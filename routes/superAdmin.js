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
    const [
      totalTenants,
      activeTenants,
      totalUsers,
      usersByRole,
      totalExams,
      totalExamAttempts,
      totalSessions,
    ] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ status: 'ACTIVE' }),
      User.countDocuments({ role: { $ne: 'SUPER_ADMIN' } }),
      User.aggregate([
        { $match: { role: { $ne: 'SUPER_ADMIN' } } },
        { $group: { _id: '$role', count: { $sum: 1 } } },
      ]),
      Exam.countDocuments(),
      ExamAttempt.countDocuments(),
      ExamSession.countDocuments(),
    ]);

    // Calculate AI usage stats
    const aiExams = await Exam.countDocuments({ aiGenerated: true });
    const recentAiExams = await Exam.countDocuments({
      aiGenerated: true,
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // Last 30 days
    });

    res.json({
      tenants: {
        total: totalTenants,
        active: activeTenants,
        inactive: totalTenants - activeTenants,
      },
      users: {
        total: totalUsers,
        byRole: usersByRole.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
      },
      exams: {
        total: totalExams,
        aiGenerated: aiExams,
        recentAiGenerated: recentAiExams,
      },
      attempts: {
        total: totalExamAttempts,
      },
      sessions: {
        total: totalSessions,
      },
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

// Disable exam (Super Admin can disable any exam)
router.put('/exams/:examId/disable', async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    exam.isActive = false;
    await exam.save();

    res.json({ message: 'Exam disabled successfully', exam });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM ATTEMPTS & RESULTS MONITORING
 */

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

export default router;
