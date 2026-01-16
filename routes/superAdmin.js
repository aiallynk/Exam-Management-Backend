import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamSession from '../models/ExamSession.js';

const router = express.Router();

// All Super Admin routes require SUPER_ADMIN role
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

/**
 * SUPER ADMIN DASHBOARD STATS
 * GET /api/super-admin/stats
 */
router.get('/stats', async (req, res, next) => {
  try {
    // Calculate today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [
      totalTenants,
      activeTenants,
      totalExams,
      totalExamAttempts,
      todayAttempts,
    ] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ status: 'ACTIVE' }),
      Exam.countDocuments(),
      ExamAttempt.countDocuments(),
      ExamAttempt.countDocuments({
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
    ]);

    // Get recent tenants (last 5, ordered by updatedAt)
    const recentTenants = await Tenant.find()
      .select('name code status updatedAt')
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();

    // Get recent exams (last 5, ordered by createdAt)
    const recentExams = await Exam.find()
      .select('title tenantId isActive createdAt')
      .populate('tenantId', 'name code')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // System alerts
    const systemAlerts = [];
    
    // Check for tenants at limit (if tenant limit exists in system config)
    try {
      const SystemConfig = (await import('../models/SystemConfig.js')).default;
      const config = await SystemConfig.findOne({ key: 'TENANT_LIMIT' });
      if (config && config.value) {
        const tenantLimit = parseInt(config.value);
        if (totalTenants >= tenantLimit * 0.9) {
          systemAlerts.push({
            type: 'warning',
            message: `Tenant count approaching limit: ${totalTenants}/${tenantLimit}`,
            severity: totalTenants >= tenantLimit ? 'high' : 'medium',
          });
        }
      }
    } catch (err) {
      // System config might not exist, ignore
    }

    // Check for inactive tenants (potential issues)
    const inactiveTenants = totalTenants - activeTenants;
    if (inactiveTenants > totalTenants * 0.5 && totalTenants > 10) {
      systemAlerts.push({
        type: 'warning',
        message: `${inactiveTenants} inactive tenants (${Math.round((inactiveTenants / totalTenants) * 100)}% of total)`,
        severity: 'medium',
      });
    }

    res.json({
      tenants: {
        total: totalTenants,
        active: activeTenants,
      },
      exams: {
        total: totalExams,
      },
      attempts: {
        total: totalExamAttempts,
        todayAttempts,
      },
      recentTenants: recentTenants.map(t => ({
        _id: t._id,
        name: t.name,
        code: t.code,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
      recentExams: recentExams.map(e => ({
        _id: e._id,
        title: e.title,
        tenantId: e.tenantId?._id || e.tenantId,
        tenantName: e.tenantId?.name || 'N/A',
        isActive: e.isActive,
        createdAt: e.createdAt,
      })),
      systemAlerts,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * TENANT MANAGEMENT
 */

// List all tenants
router.get('/tenants', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { contactEmail: { $regex: search, $options: 'i' } },
      ];
    }

    const [tenants, total] = await Promise.all([
      Tenant.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Tenant.countDocuments(filter),
    ]);

    res.json({
      tenants,
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
 * Create tenant - Only SUPER_ADMIN can create tenants
 * 
 * Simple flow:
 * 1. Only SUPER_ADMIN can create tenants (enforced by requireRole middleware)
 * 2. Tenant requires: name, code, type (SCHOOL|COLLEGE|COMPANY|INSTITUTE|GOVERNMENT|OTHER)
 * 3. Tenant cannot self-register - must be created by SUPER_ADMIN
 * 4. After creation, SUPER_ADMIN assigns users to tenants
 */
router.post(
  '/tenants',
  [
    body('name').trim().notEmpty().withMessage('Tenant name is required'),
    body('code')
      .trim()
      .notEmpty()
      .matches(/^[A-Z0-9_-]+$/)
      .withMessage('Code must contain only uppercase letters, numbers, hyphens, and underscores'),
    body('type').isIn(['SCHOOL', 'COLLEGE', 'COMPANY', 'INSTITUTE', 'GOVERNMENT', 'OTHER']).withMessage('Valid tenant type is required'),
    body('contactEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, code, type, contactEmail, contactPhone, address, examLimit, aiUsageLimit, metadata } = req.body;

      // Check if code already exists
      const existing = await Tenant.findOne({ code: code.toUpperCase() });
      if (existing) {
        return res.status(409).json({ error: 'Tenant code already exists' });
      }

      const tenant = new Tenant({
        name,
        code: code.toUpperCase(),
        type,
        contactEmail,
        contactPhone,
        address,
        examLimit: examLimit ? parseInt(examLimit) : null,
        aiUsageLimit: aiUsageLimit ? parseInt(aiUsageLimit) : null,
        metadata: metadata || {},
        createdBy: req.user._id,
      });

      await tenant.save();
      await tenant.populate('createdBy', 'name email');

      res.status(201).json({ tenant });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Tenant code already exists' });
      }
      next(error);
    }
  }
);

// Get single tenant with details
router.get('/tenants/:tenantId', async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.tenantId)
      .populate('createdBy', 'name email');

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Get detailed stats and data
    const [usersCount, users, examsCount, exams, attemptsCount, sessionsCount, sessions] = await Promise.all([
      User.countDocuments({ tenantId: tenant._id }),
      User.find({ tenantId: tenant._id })
        .select('name email role status createdAt')
        .sort({ createdAt: -1 })
        .limit(100), // Limit to 100 users for performance
      Exam.countDocuments({ tenantId: tenant._id }),
      Exam.find({ tenantId: tenant._id })
        .select('title isActive duration maxAttempts createdAt')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(50), // Limit to 50 exams
      ExamAttempt.countDocuments({ tenantId: tenant._id }),
      ExamSession.countDocuments({ tenantId: tenant._id }),
      ExamSession.find({ tenantId: tenant._id })
        .populate('examId', 'title duration maxAttempts')
        .populate('questionPaperId', 'setName')
        .populate('questionPaperIds', 'setName')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(50), // Limit to 50 sessions
    ]);

    res.json({
      tenant,
      stats: {
        users: usersCount,
        exams: examsCount,
        attempts: attemptsCount,
        sessions: sessionsCount,
      },
      users,
      exams,
      sessions,
    });
  } catch (error) {
    next(error);
  }
});

// Update tenant
router.put(
  '/tenants/:tenantId',
  [
    body('name').optional().trim().notEmpty(),
    body('code')
      .optional()
      .trim()
      .matches(/^[A-Z0-9_-]+$/)
      .withMessage('Code must contain only uppercase letters, numbers, hyphens, and underscores'),
    body('type').optional().isIn(['SCHOOL', 'COLLEGE', 'COMPANY', 'INSTITUTE', 'GOVERNMENT', 'OTHER']),
    body('contactEmail').optional().isEmail().normalizeEmail(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const tenant = await Tenant.findById(req.params.tenantId);
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { name, code, type, contactEmail, contactPhone, address, status, examLimit, aiUsageLimit, metadata } = req.body;

      if (name) tenant.name = name;
      if (code) {
        // Check if new code conflicts
        const existing = await Tenant.findOne({ code: code.toUpperCase(), _id: { $ne: tenant._id } });
        if (existing) {
          return res.status(409).json({ error: 'Tenant code already exists' });
        }
        tenant.code = code.toUpperCase();
      }
      if (type) tenant.type = type;
      if (contactEmail) tenant.contactEmail = contactEmail;
      if (contactPhone !== undefined) tenant.contactPhone = contactPhone;
      if (address !== undefined) tenant.address = address;
      if (status) tenant.status = status;
      if (examLimit !== undefined) tenant.examLimit = examLimit;
      if (aiUsageLimit !== undefined) tenant.aiUsageLimit = aiUsageLimit;
      if (metadata) tenant.metadata = { ...tenant.metadata, ...metadata };

      await tenant.save();
      await tenant.populate('createdBy', 'name email');

      res.json({ tenant });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Tenant code already exists' });
      }
      next(error);
    }
  }
);

// Delete tenant (soft delete by setting status to INACTIVE)
router.delete('/tenants/:tenantId', async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Check if tenant has active users or exams
    const [activeUsers, activeExams] = await Promise.all([
      User.countDocuments({ tenantId: tenant._id, status: 'ACTIVE' }),
      Exam.countDocuments({ tenantId: tenant._id, isActive: true }),
    ]);

    if (activeUsers > 0 || activeExams > 0) {
      return res.status(400).json({
        error: 'Cannot delete tenant with active users or exams. Deactivate them first.',
      });
    }

    tenant.status = 'INACTIVE';
    await tenant.save();

    res.json({ message: 'Tenant deactivated successfully', tenant });
  } catch (error) {
    next(error);
  }
});

/**
 * USER MANAGEMENT (Global)
 */

// List all users (with filters)
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, tenantId, role, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { role: { $ne: 'SUPER_ADMIN' } }; // Exclude SUPER_ADMIN from listings
    if (tenantId) filter.tenantId = tenantId;
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
        .populate('tenantId', 'name code type')
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
    const user = await User.findById(req.params.userId)
      .select('-password')
      .populate('tenantId', 'name code type');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent viewing SUPER_ADMIN details
    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot view SUPER_ADMIN user details' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Create user
router.post(
  '/users',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['TENANT_ADMIN', 'EXAM_CREATOR', 'CANDIDATE']).withMessage('Invalid role. Must be TENANT_ADMIN, EXAM_CREATOR, or CANDIDATE'),
    body('tenantId')
      .optional({ checkFalsy: true })
      .custom((value) => {
        if (!value || value === '') return true; // Allow empty string/null
        return /^[0-9a-fA-F]{24}$/.test(value); // MongoDB ObjectId format
      })
      .withMessage('Valid tenant ID is required if provided'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, tenantId, mobile } = req.body;

      // Check if user exists
      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Normalize empty strings to null/undefined
      const normalizedTenantId = tenantId && tenantId.trim() !== '' ? tenantId : null;

      // TENANT_ADMIN must have a tenantId
      if (role === 'TENANT_ADMIN' && !normalizedTenantId) {
        return res.status(400).json({ error: 'TENANT_ADMIN must be assigned to a tenant' });
      }

      // Verify tenant exists (if provided)
      if (normalizedTenantId) {
        const tenant = await Tenant.findById(normalizedTenantId);
        if (!tenant) {
          return res.status(404).json({ error: 'Tenant not found' });
        }
      }

      // Allow users to be created without tenant initially (they can be assigned later)
      // Exception: TENANT_ADMIN must have tenantId (checked above)
      const user = new User({
        name,
        email,
        password,
        role,
        tenantId: normalizedTenantId,
        mobile,
        status: 'ACTIVE',
      });

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      await user.populate('tenantId', 'name code type');

      res.status(201).json({ user: { ...userObj, tenantId: user.tenantId } });
    } catch (error) {
      next(error);
    }
  }
);

// Role mapping for old roles to new roles
const roleMapping = {
  // Admin/creator roles → EXAM_CREATOR
  'ORG_ADMIN': 'EXAM_CREATOR',
  'INSTITUTE_ADMIN': 'EXAM_CREATOR',
  'ADMIN': 'EXAM_CREATOR',
  'DESIGNER': 'EXAM_CREATOR',
  'TEACHER': 'EXAM_CREATOR',
  
  // User roles → CANDIDATE
  'USER': 'CANDIDATE',
  'STUDENT': 'CANDIDATE',
};

// Helper function to convert old roles to new roles
function convertRole(oldRole) {
  return roleMapping[oldRole] || oldRole;
}

// Update user
router.put(
  '/users/:userId',
  [
    body('name').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('role')
      .optional()
      .custom((value) => {
        // Allow new roles and old roles (will be converted in handler)
        const validRoles = ['EXAM_CREATOR', 'CANDIDATE', 'TENANT_ADMIN', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'ADMIN', 'DESIGNER', 'TEACHER', 'USER', 'STUDENT'];
        return validRoles.includes(value);
      })
      .withMessage('Invalid role'),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED']),
    body('tenantId')
      .optional({ checkFalsy: true })
      .custom((value) => {
        if (!value || value === '') return true; // Allow empty string/null
        return /^[0-9a-fA-F]{24}$/.test(value); // MongoDB ObjectId format
      })
      .withMessage('Valid tenant ID is required if provided'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent modifying SUPER_ADMIN
      if (user.role === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Cannot modify SUPER_ADMIN user' });
      }

      const { name, email, password, role, tenantId, status, mobile } = req.body;

      if (name) user.name = name;
      if (email) {
        // Check if email conflicts
        const existing = await User.findOne({ email, _id: { $ne: user._id } });
        if (existing) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        user.email = email;
      }
      if (password) user.password = password; // Will be hashed by pre-save hook
      
      // Handle role: convert old roles to new roles
      if (role !== undefined) {
        // Convert role if it's an old role, otherwise use the provided role
        const convertedRole = convertRole(role);
        user.role = convertedRole;
      } else {
        // No role provided in request - check if current role needs conversion
        const currentRole = user.role;
        const convertedCurrentRole = convertRole(currentRole);
        if (convertedCurrentRole !== currentRole) {
          // User has an old role, convert it automatically
          user.role = convertedCurrentRole;
        }
      }
      // Normalize empty strings to null
      const normalizedTenantId = tenantId !== undefined 
        ? (tenantId && tenantId.trim() !== '' ? tenantId : null)
        : undefined;

      if (normalizedTenantId !== undefined) {
        if (normalizedTenantId) {
          const tenant = await Tenant.findById(normalizedTenantId);
          if (!tenant) {
            return res.status(404).json({ error: 'Tenant not found' });
          }
          user.tenantId = normalizedTenantId;
        } else {
          // Setting to null explicitly
          user.tenantId = null;
        }
      }
      if (status) user.status = status;
      if (mobile !== undefined) user.mobile = mobile;

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      await user.populate('tenantId', 'name code type');

      res.json({ user: { ...userObj, tenantId: user.tenantId } });
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

      const user = await User.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.role === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Cannot reset SUPER_ADMIN password' });
      }

      user.password = req.body.newPassword; // Will be hashed by pre-save hook
      await user.save();

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * EXAM OVERSIGHT
 */

// List all exams (with filters)
router.get('/exams', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, tenantId, createdBy, isActive, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (tenantId) filter.tenantId = tenantId;
    if (createdBy) filter.createdBy = createdBy;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const [exams, total] = await Promise.all([
      Exam.find(filter)
        .populate('tenantId', 'name code type')
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
    const exam = await Exam.findById(req.params.examId)
      .populate('tenantId', 'name code type')
      .populate('createdBy', 'name email role');

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

// Disable exam (Super Admin can disable any exam)
router.put('/exams/:examId/disable', async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const beforeState = { isActive: exam.isActive };
    exam.isActive = false;
    await exam.save();

    // Log audit
    const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
    await logAuditEvent(AUDIT_ACTIONS.EXAM_DISABLED || 'EXAM_DISABLED', {
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
        after: { isActive: false },
      },
    });

    res.json({ message: 'Exam disabled successfully', exam });
  } catch (error) {
    next(error);
  }
});

// Enable exam (Super Admin can enable any exam)
router.put('/exams/:examId/enable', async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const beforeState = { isActive: exam.isActive };
    exam.isActive = true;
    await exam.save();

    // Log audit
    const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
    await logAuditEvent(AUDIT_ACTIONS.EXAM_ENABLED || 'EXAM_ENABLED', {
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
        after: { isActive: true },
      },
    });

    res.json({ message: 'Exam enabled successfully', exam });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM ATTEMPTS & RESULTS MONITORING
 */

// Get single attempt with full details
router.get('/attempts/:attemptId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const Section = (await import('../models/Section.js')).default;
    const Question = (await import('../models/Question.js')).default;
    const AnswerKey = (await import('../models/AnswerKey.js')).default;

    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate({
        path: 'examId',
        select: 'title duration description passingPercentage',
        populate: {
          path: 'tenantId',
          select: 'name code type'
        }
      })
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
    let answerKey = null;
    let answerKeyDetails = null;
    try {
      answerKey = await AnswerKey.findOne({ examId: attempt.examId._id, isActive: true })
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
        } else if (typeof answersMap === 'object') {
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
      // Answer key might not exist
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
      // Violation summary might fail
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

// List all exam attempts (with filters)
router.get('/attempts', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, tenantId, examId, userId, isCompleted } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (tenantId) filter.tenantId = tenantId;
    if (examId) filter.examId = examId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';

    const [attempts, total] = await Promise.all([
      ExamAttempt.find(filter)
        .populate({
          path: 'examId',
          select: 'title tenantId',
          populate: {
            path: 'tenantId',
            select: 'name code type'
          }
        })
        .populate('userId', 'name email role')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ExamAttempt.countDocuments(filter),
    ]);

    res.json({
      attempts,
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

// Get exam results with statistics (Super Admin - all tenants)
router.get('/results/exams', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;

    // Get all exams across all tenants
    const exams = await Exam.find()
      .populate('createdBy', 'name email')
      .populate('tenantId', 'name code')
      .sort({ createdAt: -1 });

    // Get statistics for each exam
    const examsWithStats = await Promise.all(
      exams.map(async (exam) => {
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
            tenantId: exam.tenantId,
            tenantName: exam.tenantId?.name || 'N/A',
            totalCandidates: 0,
            overallPercentage: 0,
            averageScore: 0,
            maxScore: 0,
            minScore: 0,
            averagePercentile: 0,
            averageNormalizedScore: 0,
          };
        }

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
          tenantId: exam.tenantId?._id || exam.tenantId,
          tenantName: exam.tenantId?.name || 'N/A',
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

// Get detailed results for a specific exam (Super Admin)
router.get('/results/exams/:examId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const { getNormalizationStats } = await import('../services/normalizationService.js');

    const exam = await Exam.findById(req.params.examId)
      .populate('tenantId', 'name code');

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const attempts = await ExamAttempt.find({
      examId: exam._id,
      isCompleted: true,
      isDisqualified: false,
    })
      .populate('userId', 'name email uniqueId')
      .sort({ createdAt: -1 });

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
          rank: null,
        };
      })
    );

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    candidates.forEach((candidate, index) => {
      candidate.rank = index + 1;
    });

    const top5 = candidates.slice(0, 5);
    const bottom5 = candidates.slice(-5).reverse();

    const normalizationStats = await getNormalizationStats(exam._id);

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
        tenantId: exam.tenantId?._id || exam.tenantId,
        tenantName: exam.tenantId?.name || 'N/A',
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

export default router;
