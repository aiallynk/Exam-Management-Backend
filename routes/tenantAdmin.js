import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamSession from '../models/ExamSession.js';
import Answer from '../models/Answer.js';
import SystemConfig from '../models/SystemConfig.js';
import { validatePasswordStrength, generateSecurePassword } from '../utils/passwordValidator.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';

const router = express.Router();

// All Tenant Admin routes require TENANT_ADMIN role and tenantId
router.use(requireAuth);
router.use(requireRole('TENANT_ADMIN'));

// Middleware to ensure tenant admin has tenantId
router.use((req, res, next) => {
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'TENANT_ADMIN must be assigned to a tenant' });
  }
  next();
});

/**
 * TENANT ADMIN DASHBOARD STATS
 * GET /api/tenant-admin/stats
 */
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;

    // Calculate today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Calculate today's sessions range
    const now = new Date();

    const [
      totalExams,
      activeExams,
      totalExamAttempts,
      completedAttempts,
      todayAttempts,
      totalSessions,
      activeSessions,
      totalCandidates,
    ] = await Promise.all([
      Exam.countDocuments({ tenantId }),
      Exam.countDocuments({ tenantId, isActive: true }),
      ExamAttempt.countDocuments({ tenantId }),
      ExamAttempt.countDocuments({ tenantId, isCompleted: true }),
      ExamAttempt.countDocuments({
        tenantId,
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      ExamSession.countDocuments({ tenantId }),
      ExamSession.countDocuments({ tenantId, endTime: { $gte: now } }),
      User.countDocuments({ tenantId, role: 'CANDIDATE' }),
    ]);

    // Get pending results: completed attempts where results not released
    const completedAttemptsNotReleased = await ExamAttempt.aggregate([
      {
        $match: {
          tenantId,
          isCompleted: true,
          isDisqualified: false,
        },
      },
      {
        $lookup: {
          from: 'exams',
          localField: 'examId',
          foreignField: '_id',
          as: 'exam',
        },
      },
      {
        $unwind: '$exam',
      },
      {
        $match: {
          $or: [
            { 'exam.showResultsImmediately': false, 'exam.resultsReleasedAt': null },
            { 'exam.showResultsImmediately': false, 'exam.resultsReleasedAt': { $exists: false } },
          ],
        },
      },
      {
        $count: 'count',
      },
    ]);

    const completedNotReleased = completedAttemptsNotReleased[0]?.count || 0;
    const inProgress = totalExamAttempts - completedAttempts;

    // Get active exams list (last 5)
    const activeExamsList = await Exam.find({ tenantId, isActive: true })
      .select('_id title isActive createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Get today's sessions
    const todaySessions = await ExamSession.find({
      tenantId,
      startTime: { $lte: todayEnd },
      endTime: { $gte: todayStart },
    })
      .select('_id examId startTime endTime isActive')
      .populate('examId', 'title')
      .sort({ startTime: 1 })
      .limit(10)
      .lean();

    // Get recent attempts (last 5)
    const recentAttempts = await ExamAttempt.find({ tenantId })
      .select('_id userId examId isCompleted isDisqualified createdAt')
      .populate('userId', 'name email')
      .populate('examId', 'title')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Get tenant info
    const tenant = await Tenant.findById(tenantId).select('name code type status');

    res.json({
      tenant,
      exams: {
        total: totalExams,
        active: activeExams,
      },
      attempts: {
        total: totalExamAttempts,
        completed: completedAttempts,
        todayAttempts,
      },
      sessions: {
        total: totalSessions,
        active: activeSessions,
      },
      totalCandidates,
      pendingResults: {
        completedNotReleased,
        inProgress,
      },
      activeExamsList: activeExamsList.map(e => ({
        _id: e._id,
        title: e.title,
        isActive: e.isActive,
        createdAt: e.createdAt,
      })),
      todaySessions: todaySessions.map(s => ({
        _id: s._id,
        examId: s.examId?._id || s.examId,
        examTitle: s.examId?.title || 'N/A',
        startTime: s.startTime,
        endTime: s.endTime,
        isActive: s.isActive,
      })),
      recentAttempts: recentAttempts.map(a => ({
        _id: a._id,
        userId: a.userId?._id || a.userId,
        userName: a.userId?.name || 'N/A',
        userEmail: a.userId?.email || 'N/A',
        examId: a.examId?._id || a.examId,
        examTitle: a.examId?.title || 'N/A',
        isCompleted: a.isCompleted,
        isDisqualified: a.isDisqualified,
        createdAt: a.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * USER MANAGEMENT (Tenant-scoped)
 */

// List all users in tenant
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId, role: { $ne: 'SUPER_ADMIN' } };
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(filter),
    ]);

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get single user
router.get('/users/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne({
      _id: req.params.userId,
      tenantId: req.user.tenantId,
    }).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Create user in tenant
router.post(
  '/users',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['EXAM_CREATOR', 'CANDIDATE']).withMessage('Invalid role. Must be EXAM_CREATOR or CANDIDATE'),
    body('mobile').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, mobile } = req.body;

      // Check if user exists
      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const user = new User({
        name,
        email,
        password,
        role,
        tenantId: req.user.tenantId, // Automatically assign to tenant admin's tenant
        mobile,
        status: 'ACTIVE',
      });

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      res.status(201).json({ user: userObj });
    } catch (error) {
      next(error);
    }
  }
);

// Update user in tenant
router.put(
  '/users/:userId',
  [
    body('name').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('role').optional().isIn(['EXAM_CREATOR', 'CANDIDATE']),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED']),
    body('mobile').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findOne({
        _id: req.params.userId,
        tenantId: req.user.tenantId,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent modifying SUPER_ADMIN or TENANT_ADMIN
      if (user.role === 'SUPER_ADMIN' || user.role === 'TENANT_ADMIN') {
        return res.status(403).json({ error: 'Cannot modify this user' });
      }

      const { name, email, password, role, status, mobile } = req.body;

      if (name) user.name = name;
      if (email) {
        const existing = await User.findOne({ email, _id: { $ne: user._id } });
        if (existing) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        user.email = email;
      }
      if (password) user.password = password;
      if (role) user.role = role;
      if (status) user.status = status;
      if (mobile !== undefined) user.mobile = mobile;

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      res.json({ user: userObj });
    } catch (error) {
      next(error);
    }
  }
);

// Delete user (soft delete by setting status to INACTIVE)
router.delete('/users/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne({
      _id: req.params.userId,
      tenantId: req.user.tenantId,
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'SUPER_ADMIN' || user.role === 'TENANT_ADMIN') {
      return res.status(403).json({ error: 'Cannot delete this user' });
    }

    user.status = 'INACTIVE';
    await user.save();

    res.json({ message: 'User deactivated successfully', user });
  } catch (error) {
    next(error);
  }
});

// Block/Unblock user
router.post(
  '/users/:userId/block',
  [body('blocked').isBoolean().withMessage('Blocked status must be a boolean')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findOne({
        _id: req.params.userId,
        tenantId: req.user.tenantId,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { blocked } = req.body;
      const configKey = `blocked_user_${user._id}`;

      let config = await SystemConfig.findOne({ key: configKey });
      if (!config) {
        config = new SystemConfig({
          key: configKey,
          value: blocked ? 'true' : 'false',
          description: `Block status for user ${user.email}`,
          updatedBy: req.user._id,
        });
      } else {
        config.value = blocked ? 'true' : 'false';
        config.updatedBy = req.user._id;
      }

      await config.save();

      res.json({
        message: `User ${blocked ? 'blocked' : 'unblocked'} successfully`,
        user: { ...user.toObject(), isBlocked: blocked },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Reset user password
router.post(
  '/users/:userId/reset-password',
  [body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findOne({
        _id: req.params.userId,
        tenantId: req.user.tenantId,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.role === 'SUPER_ADMIN' || user.role === 'TENANT_ADMIN') {
        return res.status(403).json({ error: 'Cannot reset password for this user' });
      }

      user.password = req.body.newPassword;
      await user.save();

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * EXAM MANAGEMENT (Tenant-scoped)
 */

// List all exams in tenant
router.get('/exams', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId };
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const [exams, total] = await Promise.all([
      Exam.find(filter)
        .populate('createdBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Exam.countDocuments(filter),
    ]);

    res.json({
      exams,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get single exam with full details
router.get('/exams/:examId', async (req, res, next) => {
  try {
    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    }).populate('createdBy', 'name email role');

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // Get question papers for this exam
    const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
    const questionPapers = await QuestionPaper.find({ examId: exam._id, isActive: true });

    // Get sections and question counts for each question paper
    const Section = (await import('../models/Section.js')).default;
    const Question = (await import('../models/Question.js')).default;

    const examDetails = {
      ...exam.toObject(),
      questionPapers: [],
      totalQuestions: 0,
      totalMarks: 0,
      sections: [],
    };

    // Process each question paper
    for (const qp of questionPapers) {
      const sections = await Section.find({ questionPaperId: qp._id, isActive: true })
        .sort({ order: 1 })
        .lean();

      const sectionDetails = [];
      let paperTotalQuestions = 0;
      let paperTotalMarks = 0;

      for (const section of sections) {
        const questionCount = await Question.countDocuments({
          questionPaperId: qp._id,
          sectionId: section._id,
        });

        const sectionMarks = await Question.aggregate([
          {
            $match: {
              questionPaperId: qp._id,
              sectionId: section._id,
            },
          },
          {
            $group: {
              _id: null,
              totalMarks: { $sum: '$points' },
            },
          },
        ]);

        const marks = sectionMarks.length > 0 ? sectionMarks[0].totalMarks : 0;

        sectionDetails.push({
          ...section,
          questionCount,
          totalMarks: marks,
        });

        paperTotalQuestions += questionCount;
        paperTotalMarks += marks;
      }

      // Also count questions without sections
      const questionsWithoutSection = await Question.countDocuments({
        questionPaperId: qp._id,
        sectionId: { $exists: false },
      });

      const marksWithoutSection = await Question.aggregate([
        {
          $match: {
            questionPaperId: qp._id,
            sectionId: { $exists: false },
          },
        },
        {
          $group: {
            _id: null,
            totalMarks: { $sum: '$points' },
          },
        },
      ]);

      const marksNoSection = marksWithoutSection.length > 0 ? marksWithoutSection[0].totalMarks : 0;

      examDetails.questionPapers.push({
        ...qp.toObject(),
        sections: sectionDetails,
        questionCount: paperTotalQuestions + questionsWithoutSection,
        totalMarks: paperTotalMarks + marksNoSection,
      });

      examDetails.totalQuestions += paperTotalQuestions + questionsWithoutSection;
      examDetails.totalMarks += paperTotalMarks + marksNoSection;
      examDetails.sections.push(...sectionDetails);
    }

    // Get all attempts for this exam with candidate details
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    
    const attempts = await ExamAttempt.find({ examId: exam._id })
      .populate('userId', 'name email uniqueId')
      .sort({ createdAt: -1 })
      .lean();

    // Aggregate candidate data
    const candidatesMap = new Map();
    
    for (const attempt of attempts) {
      const userId = attempt.userId?._id?.toString() || attempt.userId?.toString();
      if (!userId) continue;

      if (!candidatesMap.has(userId)) {
        candidatesMap.set(userId, {
          _id: userId,
          name: attempt.userId?.name || 'Unknown',
          email: attempt.userId?.email || '',
          uniqueId: attempt.userId?.uniqueId || '',
          attempts: [],
          totalAttempts: 0,
          bestScore: 0,
          bestPercentage: 0,
          latestAttempt: null,
        });
      }

      const candidate = candidatesMap.get(userId);
      candidate.totalAttempts++;

      // Get answers for this attempt to calculate questions attempted
      const answers = await Answer.find({ attemptId: attempt._id }).lean();
      const questionsAttempted = answers.length;
      const marksObtained = attempt.scoreSummary?.totalScore || 0;
      const totalMarks = attempt.scoreSummary?.maxScore || examDetails.totalMarks || 0;
      const percentage = attempt.scoreSummary?.percentage || 0;

      candidate.attempts.push({
        attemptId: attempt._id,
        isCompleted: attempt.isCompleted || false,
        isDisqualified: attempt.isDisqualified || false,
        questionsAttempted,
        marksObtained,
        totalMarks,
        percentage,
        startTime: attempt.startTime,
        submitTime: attempt.submitTime,
      });

      // Track best score
      if (marksObtained > candidate.bestScore) {
        candidate.bestScore = marksObtained;
        candidate.bestPercentage = percentage;
      }

      // Track latest attempt
      if (!candidate.latestAttempt || new Date(attempt.createdAt) > new Date(candidate.latestAttempt.createdAt)) {
        candidate.latestAttempt = {
          attemptId: attempt._id,
          questionsAttempted,
          marksObtained,
          totalMarks,
          percentage,
          isCompleted: attempt.isCompleted || false,
          isDisqualified: attempt.isDisqualified || false,
          createdAt: attempt.createdAt,
        };
      }
    }

    // Convert map to array and format for response
    const candidates = Array.from(candidatesMap.values()).map(candidate => ({
      _id: candidate._id,
      name: candidate.name,
      email: candidate.email,
      uniqueId: candidate.uniqueId,
      totalAttempts: candidate.totalAttempts,
      latestAttempt: candidate.latestAttempt ? {
        questionsAttempted: candidate.latestAttempt.questionsAttempted,
        marksObtained: candidate.latestAttempt.marksObtained,
        totalMarks: candidate.latestAttempt.totalMarks,
        percentage: candidate.latestAttempt.percentage,
        isCompleted: candidate.latestAttempt.isCompleted,
        isDisqualified: candidate.latestAttempt.isDisqualified,
        attemptId: candidate.latestAttempt.attemptId,
      } : null,
      bestScore: candidate.bestScore,
      bestPercentage: candidate.bestPercentage,
    }));

    examDetails.candidates = candidates;
    examDetails.totalCandidates = candidates.length;

    res.json({ exam: examDetails });
  } catch (error) {
    next(error);
  }
});

// Update exam (enable/disable, etc.)
router.put(
  '/exams/:examId',
  [
    body('title').optional().trim().notEmpty(),
    body('description').optional().trim(),
    body('isActive').optional().isBoolean(),
    body('duration').optional().isInt({ min: 1 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findOne({
        _id: req.params.examId,
        tenantId: req.user.tenantId,
      });

      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const { title, description, isActive, duration, maxAttempts } = req.body;

      // Store before state for audit
      const beforeState = {
        isActive: exam.isActive,
      };

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (isActive !== undefined) exam.isActive = isActive;
      if (duration) exam.duration = duration;
      if (maxAttempts) exam.maxAttempts = maxAttempts;

      await exam.save();
      await exam.populate('createdBy', 'name email role');

      // Log audit for enable/disable
      if (isActive !== undefined && isActive !== beforeState.isActive) {
        const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
        await logAuditEvent(
          isActive ? AUDIT_ACTIONS.EXAM_ENABLED || 'EXAM_ENABLED' : AUDIT_ACTIONS.EXAM_DISABLED || 'EXAM_DISABLED',
          {
            userId: req.user._id,
            userEmail: req.user.email,
            userRole: req.user.role,
            resourceType: 'Exam',
            resourceId: exam._id,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            method: req.method,
            path: req.path,
            details: {
              before: beforeState,
              after: { isActive: exam.isActive },
            },
          }
        );
      }

      res.json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Delete exam (soft delete by setting isActive to false)
router.delete('/exams/:examId', async (req, res, next) => {
  try {
    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    });

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    exam.isActive = false;
    await exam.save();

    res.json({ message: 'Exam deactivated successfully', exam });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM SESSIONS MANAGEMENT (Tenant-scoped)
 */

// List all sessions in tenant
router.get('/sessions', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId };
    if (examId) filter.examId = examId;

    const [sessions, total] = await Promise.all([
      ExamSession.find(filter)
        .populate('examId', 'title duration')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ExamSession.countDocuments(filter),
    ]);

    res.json({
      sessions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM ATTEMPTS & RESULTS (Tenant-scoped)
 */

// List all exam attempts in tenant
// Get single attempt with full details
router.get('/attempts/:attemptId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const Section = (await import('../models/Section.js')).default;
    const Question = (await import('../models/Question.js')).default;
    const AnswerKey = (await import('../models/AnswerKey.js')).default;

    const attempt = await ExamAttempt.findOne({
      _id: req.params.attemptId,
      tenantId: req.user.tenantId,
    })
      .populate('examId', 'title duration description passingPercentage')
      .populate('sessionId', 'startTime endTime qrCode')
      .populate('userId', 'name email')
      .populate('questionPaperId', 'setName')
      .populate('adminFlags.flaggedBy', 'name email')
      .populate('adminNotes.addedBy', 'name email');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Get all answers with question details
    const answers = await Answer.find({ attemptId: attempt._id })
      .populate('questionId', 'questionText questionType options points sectionId order passage imageUrl correctAnswer')
      .sort({ 'questionId.order': 1 })
      .lean();

    // Get sections if question paper exists
    let sections = [];
    if (attempt.questionPaperId) {
      sections = await Section.find({ questionPaperId: attempt.questionPaperId._id, isActive: true })
        .sort({ order: 1 })
        .lean();
    }

    // Get answer key for this exam with full details
    let answerKeyDetails = null;
    try {
      const answerKey = await AnswerKey.findOne({ examId: attempt.examId._id, isActive: true })
        .populate('importedBy', 'name email')
        .lean();
      
      if (answerKey) {
        // Convert Map to object for JSON serialization
        const answersMap = answerKey.answers || new Map();
        const answersObj = {};
        if (answersMap instanceof Map) {
          answersMap.forEach((value, key) => {
            answersObj[key] = value;
          });
        } else if (typeof answersMap === 'object' && answersMap !== null) {
          Object.assign(answersObj, answersMap);
        }
        
        answerKeyDetails = {
          _id: answerKey._id,
          version: answerKey.version,
          source: answerKey.source,
          appliedAt: answerKey.appliedAt,
          importedAt: answerKey.importedAt,
          importedBy: answerKey.importedBy,
          notes: answerKey.notes,
          answers: answersObj,
        };
      }
    } catch (err) {
      console.error('Error loading answer key:', err);
      // Answer key might not exist - that's okay
    }

    // Build section-wise breakdown
    const sectionBreakdown = {};
    const sectionTimers = attempt.sectionTimers || {};

    for (const section of sections) {
      const sectionAnswers = answers.filter(a => {
        if (!a.questionId || !a.questionId.sectionId) return false;
        const qSectionId = a.questionId.sectionId.toString();
        const sId = section._id?.toString() || section._id;
        return qSectionId === sId;
      });

      const sectionIdStr = section._id?.toString() || section._id;
      const timer = sectionTimers[section._id] || sectionTimers[sectionIdStr] || {};

      sectionBreakdown[sectionIdStr] = {
        section: {
          _id: section._id?.toString() || section._id,
          name: section.name || '',
          description: section.description || '',
          order: section.order || 0,
          duration: section.duration || 0,
          marks: section.marks || 0,
          negativeMarking: section.negativeMarking || 0,
        },
        questionsAttempted: sectionAnswers.length,
        timeSpent: timer.timeSpent || 0,
        marksObtained: sectionAnswers.reduce((sum, a) => sum + (Number(a.pointsEarned) || 0), 0),
        maxMarks: sectionAnswers.reduce((sum, a) => sum + (Number(a.questionId?.points) || 0), 0),
        isLocked: timer.isLocked || false,
        startTime: timer.startTime || null,
        endTime: timer.endTime || null,
      };
    }

    // Questions without sections
    const questionsWithoutSection = answers.filter(a => !a.questionId || !a.questionId.sectionId);
    if (questionsWithoutSection.length > 0) {
      sectionBreakdown['no-section'] = {
        section: null,
        questionsAttempted: questionsWithoutSection.length,
        timeSpent: 0,
        marksObtained: questionsWithoutSection.reduce((sum, a) => sum + (Number(a.pointsEarned) || 0), 0),
        maxMarks: questionsWithoutSection.reduce((sum, a) => sum + (Number(a.questionId?.points) || 0), 0),
        isLocked: false,
      };
    }

    // Calculate duration used
    let durationUsed = 0;
    if (attempt.startTime && attempt.submitTime) {
      durationUsed = Math.floor((new Date(attempt.submitTime) - new Date(attempt.startTime)) / 1000 / 60);
    } else if (attempt.startTime) {
      durationUsed = Math.floor((new Date() - new Date(attempt.startTime)) / 1000 / 60);
    }

    // Get violation summary
    const { getSuspiciousActivitySummary } = await import('../services/proctoringService.js');
    let violationSummary = null;
    try {
      violationSummary = await getSuspiciousActivitySummary(attempt._id);
    } catch (err) {
      console.error('Error loading violation summary:', err);
      // Violation summary might fail - that's okay
    }

    // Convert attempt to object safely
    const attemptObj = attempt.toObject ? attempt.toObject() : attempt;

    res.json({
      attempt: {
        ...attemptObj,
        durationUsed,
      },
      answers: answers.map(a => {
        const question = a.questionId;
        return {
          _id: a._id?.toString() || a._id,
          questionId: question?._id?.toString() || question?._id || null,
          question: question ? {
            _id: question._id?.toString() || question._id,
            questionText: question.questionText || '',
            questionType: question.questionType || '',
            options: question.options || null,
            points: question.points || 0,
            sectionId: question.sectionId?.toString() || question.sectionId || null,
            order: question.order || 0,
            passage: question.passage || null,
            imageUrl: question.imageUrl || null,
            correctAnswer: question.correctAnswer || null,
          } : null,
          answerText: a.answerText || '',
          isCorrect: a.isCorrect || false,
          pointsEarned: a.pointsEarned || 0,
          timeSpent: a.timeSpent || 0,
          createdAt: a.createdAt || new Date(),
        };
      }),
      sectionBreakdown,
      answerKey: answerKeyDetails,
      violationSummary,
    });
  } catch (error) {
    next(error);
  }
});

// Get exam results with statistics
router.get('/results/exams', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;

    // Get all exams in tenant
    const exams = await Exam.find({ tenantId: req.user.tenantId })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    // Get statistics for each exam
    const examsWithStats = await Promise.all(
      exams.map(async (exam) => {
        // Get all completed attempts for this exam
        const attempts = await ExamAttempt.find({
          examId: exam._id,
          isCompleted: true,
          isDisqualified: false,
        }).populate('userId', 'name email uniqueId');

        if (attempts.length === 0) {
          return {
            _id: exam._id,
            title: exam.title,
            description: exam.description,
            createdAt: exam.createdAt,
            totalCandidates: 0,
            overallPercentage: 0,
            averageScore: 0,
            maxScore: 0,
            minScore: 0,
            averagePercentile: 0,
            averageNormalizedScore: 0,
          };
        }

        // Calculate scores for each attempt
        const scores = await Promise.all(
          attempts.map(async (attempt) => {
            const answers = await Answer.find({ attemptId: attempt._id })
              .populate('questionId', 'points');
            const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
            const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
            const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

            return {
              attemptId: attempt._id,
              userId: attempt.userId,
              totalScore,
              maxScore,
              percentage,
              normalizedScore: attempt.normalizedScore || null,
              percentile: attempt.percentile || null,
            };
          })
        );

        const totalScores = scores.reduce((sum, s) => sum + s.totalScore, 0);
        const totalMaxScores = scores.reduce((sum, s) => sum + s.maxScore, 0);
        const overallPercentage = totalMaxScores > 0 ? (totalScores / totalMaxScores) * 100 : 0;
        const averageScore = scores.reduce((sum, s) => sum + s.totalScore, 0) / scores.length;
        const maxScore = Math.max(...scores.map(s => s.totalScore));
        const minScore = Math.min(...scores.map(s => s.totalScore));
        const percentiles = scores.map(s => s.percentile).filter(p => p !== null);
        const normalizedScores = scores.map(s => s.normalizedScore).filter(s => s !== null);
        const averagePercentile = percentiles.length > 0
          ? percentiles.reduce((sum, p) => sum + p, 0) / percentiles.length
          : 0;
        const averageNormalizedScore = normalizedScores.length > 0
          ? normalizedScores.reduce((sum, s) => sum + s, 0) / normalizedScores.length
          : 0;

        return {
          _id: exam._id,
          title: exam.title,
          description: exam.description,
          createdAt: exam.createdAt,
          totalCandidates: attempts.length,
          overallPercentage: Math.round(overallPercentage * 100) / 100,
          averageScore: Math.round(averageScore * 100) / 100,
          maxScore,
          minScore,
          averagePercentile: Math.round(averagePercentile * 100) / 100,
          averageNormalizedScore: Math.round(averageNormalizedScore * 100) / 100,
        };
      })
    );

    res.json({ exams: examsWithStats });
  } catch (error) {
    next(error);
  }
});

// Get detailed results for a specific exam
router.get('/results/exams/:examId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const { getNormalizationStats } = await import('../services/normalizationService.js');

    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    });

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // Get all completed attempts for this exam
    const attempts = await ExamAttempt.find({
      examId: exam._id,
      isCompleted: true,
      isDisqualified: false,
    })
      .populate('userId', 'name email uniqueId')
      .sort({ createdAt: -1 });

    // Calculate scores and get candidate data
    const candidates = await Promise.all(
      attempts.map(async (attempt) => {
        const answers = await Answer.find({ attemptId: attempt._id })
          .populate('questionId', 'points');
        const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
        const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
        const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

        return {
          attemptId: attempt._id,
          userId: attempt.userId._id,
          name: attempt.userId.name,
          email: attempt.userId.email,
          uniqueId: attempt.userId.uniqueId,
          totalScore,
          maxScore,
          percentage: Math.round(percentage * 100) / 100,
          normalizedScore: attempt.normalizedScore || null,
          percentile: attempt.percentile || null,
          sessionPercentile: attempt.sessionPercentile || null,
          rank: null, // Will be calculated after sorting
        };
      })
    );

    // Sort by totalScore descending to calculate rank
    candidates.sort((a, b) => b.totalScore - a.totalScore);
    candidates.forEach((candidate, index) => {
      candidate.rank = index + 1;
    });

    // Get top 5 and bottom 5
    const top5 = candidates.slice(0, 5);
    const bottom5 = candidates.slice(-5).reverse();

    // Get normalization statistics
    const normalizationStats = await getNormalizationStats(exam._id);

    // Prepare data for normalization curve
    const scores = candidates.map(c => c.totalScore).sort((a, b) => a - b);
    const normalizedScores = candidates
      .map(c => c.normalizedScore)
      .filter(s => s !== null)
      .sort((a, b) => a - b);
    const percentiles = candidates
      .map(c => c.percentile)
      .filter(p => p !== null)
      .sort((a, b) => a - b);

    res.json({
      exam: {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        createdAt: exam.createdAt,
      },
      candidates,
      top5,
      bottom5,
      normalizationStats,
      scoreDistribution: {
        rawScores: scores,
        normalizedScores,
        percentiles,
      },
      totalCandidates: candidates.length,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/attempts', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId, userId, isCompleted } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId };
    if (examId) filter.examId = examId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';

    const [attempts, total] = await Promise.all([
      ExamAttempt.find(filter)
        .populate({
          path: 'examId',
          select: 'title duration',
        })
        .populate('userId', 'name email role')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ExamAttempt.countDocuments(filter),
    ]);

    // Calculate scores for each attempt
    const attemptsWithScores = await Promise.all(
      attempts.map(async (attempt) => {
        const attemptObj = attempt.toObject();
        if (attempt.isCompleted) {
          try {
            const answers = await Answer.find({ attemptId: attempt._id })
              .populate('questionId', 'points');
            const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
            const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
            const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
            attemptObj.score = percentage;
          } catch (err) {
            console.error(`Error calculating score for attempt ${attempt._id}:`, err);
            attemptObj.score = null;
          }
        }
        return attemptObj;
      })
    );

    res.json({
      attempts: attemptsWithScores,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
