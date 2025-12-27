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

    const [
      totalUsers,
      usersByRole,
      totalExams,
      activeExams,
      totalExamAttempts,
      completedAttempts,
      totalSessions,
      activeSessions,
    ] = await Promise.all([
      User.countDocuments({ tenantId, role: { $ne: 'SUPER_ADMIN' } }),
      User.aggregate([
        { $match: { tenantId, role: { $ne: 'SUPER_ADMIN' } } },
        { $group: { _id: '$role', count: { $sum: 1 } } },
      ]),
      Exam.countDocuments({ tenantId }),
      Exam.countDocuments({ tenantId, isActive: true }),
      ExamAttempt.countDocuments({ tenantId }),
      ExamAttempt.countDocuments({ tenantId, isCompleted: true }),
      ExamSession.countDocuments({ tenantId }),
      ExamSession.countDocuments({ tenantId, endTime: { $gte: new Date() } }),
    ]);

    // Calculate AI usage stats
    const aiExams = await Exam.countDocuments({ tenantId, aiGenerated: true });
    const recentAiExams = await Exam.countDocuments({
      tenantId,
      aiGenerated: true,
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    // Get tenant info
    const tenant = await Tenant.findById(tenantId).select('name code type status');

    res.json({
      tenant,
      users: {
        total: totalUsers,
        byRole: usersByRole.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
      },
      exams: {
        total: totalExams,
        active: activeExams,
        inactive: totalExams - activeExams,
        aiGenerated: aiExams,
        recentAiGenerated: recentAiExams,
      },
      attempts: {
        total: totalExamAttempts,
        completed: completedAttempts,
        inProgress: totalExamAttempts - completedAttempts,
      },
      sessions: {
        total: totalSessions,
        active: activeSessions,
        completed: totalSessions - activeSessions,
      },
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

// Get single exam
router.get('/exams/:examId', async (req, res, next) => {
  try {
    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    }).populate('createdBy', 'name email role');

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    res.json({ exam });
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

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (isActive !== undefined) exam.isActive = isActive;
      if (duration) exam.duration = duration;
      if (maxAttempts) exam.maxAttempts = maxAttempts;

      await exam.save();
      await exam.populate('createdBy', 'name email role');

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
