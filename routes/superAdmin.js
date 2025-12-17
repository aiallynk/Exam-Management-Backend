import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireOrganization, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import Organization from '../models/Organization.js';
import Institute from '../models/Institute.js';
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
      totalOrganizations,
      activeOrganizations,
      totalInstitutes,
      activeInstitutes,
      totalUsers,
      usersByRole,
      totalExams,
      totalExamAttempts,
      totalSessions,
    ] = await Promise.all([
      Organization.countDocuments(),
      Organization.countDocuments({ status: 'ACTIVE' }),
      Institute.countDocuments(),
      Institute.countDocuments({ status: 'ACTIVE' }),
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
      organizations: {
        total: totalOrganizations,
        active: activeOrganizations,
        inactive: totalOrganizations - activeOrganizations,
      },
      institutes: {
        total: totalInstitutes,
        active: activeInstitutes,
        inactive: totalInstitutes - activeInstitutes,
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
 * ORGANIZATION MANAGEMENT
 */

// List all organizations
router.get('/organizations', async (req, res, next) => {
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

    const [organizations, total] = await Promise.all([
      Organization.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Organization.countDocuments(filter),
    ]);

    res.json({
      organizations,
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

// Get single organization
router.get('/organizations/:orgId', async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.params.orgId)
      .populate('createdBy', 'name email');

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Get users count (users belonging to this organization)
    const usersCount = await User.countDocuments({ organizationId: organization._id });

    res.json({
      organization,
      stats: {
        users: usersCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Create organization
router.post(
  '/organizations',
  [
    body('name').trim().notEmpty().withMessage('Organization name is required'),
    body('code')
      .trim()
      .notEmpty()
      .matches(/^[A-Z0-9_-]+$/)
      .withMessage('Code must contain only uppercase letters, numbers, hyphens, and underscores'),
    body('contactEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, code, contactEmail, contactPhone, address, metadata } = req.body;

      // Check if code already exists
      const existing = await Organization.findOne({ code: code.toUpperCase() });
      if (existing) {
        return res.status(409).json({ error: 'Organization code already exists' });
      }

      const organization = new Organization({
        name,
        code: code.toUpperCase(),
        contactEmail,
        contactPhone,
        address,
        metadata: metadata || {},
        createdBy: req.user._id,
      });

      await organization.save();
      await organization.populate('createdBy', 'name email');

      res.status(201).json({ organization });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Organization code already exists' });
      }
      next(error);
    }
  }
);

// Update organization
router.put(
  '/organizations/:orgId',
  [
    body('name').optional().trim().notEmpty(),
    body('code')
      .optional()
      .trim()
      .matches(/^[A-Z0-9_-]+$/)
      .withMessage('Code must contain only uppercase letters, numbers, hyphens, and underscores'),
    body('contactEmail').optional().isEmail().normalizeEmail(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const organization = await Organization.findById(req.params.orgId);
      if (!organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      const { name, code, contactEmail, contactPhone, address, status, metadata } = req.body;

      if (name) organization.name = name;
      if (code) {
        // Check if new code conflicts
        const existing = await Organization.findOne({ code: code.toUpperCase(), _id: { $ne: organization._id } });
        if (existing) {
          return res.status(409).json({ error: 'Organization code already exists' });
        }
        organization.code = code.toUpperCase();
      }
      if (contactEmail) organization.contactEmail = contactEmail;
      if (contactPhone !== undefined) organization.contactPhone = contactPhone;
      if (address !== undefined) organization.address = address;
      if (status) organization.status = status;
      if (metadata) organization.metadata = { ...organization.metadata, ...metadata };

      await organization.save();
      await organization.populate('createdBy', 'name email');

      res.json({ organization });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Organization code already exists' });
      }
      next(error);
    }
  }
);

// Delete organization (soft delete by setting status to INACTIVE)
router.delete('/organizations/:orgId', async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.params.orgId);
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Check if organization has active institutes
    const activeInstitutes = await Institute.countDocuments({
      organizationId: organization._id,
      status: 'ACTIVE',
    });

    if (activeInstitutes > 0) {
      return res.status(400).json({
        error: 'Cannot delete organization with active institutes. Deactivate institutes first.',
      });
    }

    organization.status = 'INACTIVE';
    await organization.save();

    res.json({ message: 'Organization deactivated successfully', organization });
  } catch (error) {
    next(error);
  }
});

/**
 * INSTITUTE MANAGEMENT
 */

// List all institutes (with optional organization filter)
router.get('/institutes', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, organizationId, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (organizationId) filter.organizationId = organizationId;
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const [institutes, total] = await Promise.all([
      Institute.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Institute.countDocuments(filter),
    ]);

    res.json({
      institutes,
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

// Get single institute
router.get('/institutes/:instituteId', async (req, res, next) => {
  try {
    const institute = await Institute.findById(req.params.instituteId)
      .populate('createdBy', 'name email');

    if (!institute) {
      return res.status(404).json({ error: 'Institute not found' });
    }

    // Get stats
    const [usersCount, examsCount, attemptsCount] = await Promise.all([
      User.countDocuments({ instituteId: institute._id }),
      Exam.countDocuments({ instituteId: institute._id }),
      ExamAttempt.countDocuments({ instituteId: institute._id }),
    ]);

    res.json({
      institute,
      stats: {
        users: usersCount,
        exams: examsCount,
        attempts: attemptsCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Create institute
router.post(
  '/institutes',
  [
    body('name').trim().notEmpty().withMessage('Institute name is required'),
    body('code').trim().notEmpty().withMessage('Institute code is required'),
    body('contactEmail').optional().isEmail().normalizeEmail(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, code, contactEmail, contactPhone, address, examLimit, aiUsageLimit, metadata, status } = req.body;

      // Check if code already exists (unique across all institutes)
      const existing = await Institute.findOne({ code });
      if (existing) {
        return res.status(409).json({ error: 'Institute code already exists' });
      }

      const institute = new Institute({
        name,
        code,
        contactEmail,
        contactPhone,
        address,
        status: status || 'ACTIVE',
        examLimit: examLimit ? parseInt(examLimit) : null,
        aiUsageLimit: aiUsageLimit ? parseInt(aiUsageLimit) : null,
        metadata: metadata || {},
        createdBy: req.user._id,
      });

      await institute.save();
      await institute.populate('organizationId', 'name code');
      await institute.populate('createdBy', 'name email');

      res.status(201).json({ institute });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Institute code already exists in this organization' });
      }
      next(error);
    }
  }
);

// Update institute
router.put(
  '/institutes/:instituteId',
  [
    body('name').optional().trim().notEmpty(),
    body('code').optional().trim().notEmpty(),
    body('contactEmail').optional().isEmail().normalizeEmail(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const institute = await Institute.findById(req.params.instituteId);
      if (!institute) {
        return res.status(404).json({ error: 'Institute not found' });
      }

      const { name, code, contactEmail, contactPhone, address, status, examLimit, aiUsageLimit, metadata } = req.body;

      if (name) institute.name = name;
      if (code) {
        // Check if new code conflicts (unique across all institutes)
        const existing = await Institute.findOne({
          code,
          _id: { $ne: institute._id },
        });
        if (existing) {
          return res.status(409).json({ error: 'Institute code already exists' });
        }
        institute.code = code;
      }
      if (contactEmail !== undefined) institute.contactEmail = contactEmail;
      if (contactPhone !== undefined) institute.contactPhone = contactPhone;
      if (address !== undefined) institute.address = address;
      if (status) institute.status = status;
      if (examLimit !== undefined) institute.examLimit = examLimit;
      if (aiUsageLimit !== undefined) institute.aiUsageLimit = aiUsageLimit;
      if (metadata) institute.metadata = { ...institute.metadata, ...metadata };

      await institute.save();
      await institute.populate('organizationId', 'name code');
      await institute.populate('createdBy', 'name email');

      res.json({ institute });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Institute code already exists in this organization' });
      }
      next(error);
    }
  }
);

// Delete institute (soft delete)
router.delete('/institutes/:instituteId', async (req, res, next) => {
  try {
    const institute = await Institute.findById(req.params.instituteId);
    if (!institute) {
      return res.status(404).json({ error: 'Institute not found' });
    }

    // Check if institute has active users or exams
    const [activeUsers, activeExams] = await Promise.all([
      User.countDocuments({ instituteId: institute._id, status: 'ACTIVE' }),
      Exam.countDocuments({ instituteId: institute._id, isActive: true }),
    ]);

    if (activeUsers > 0 || activeExams > 0) {
      return res.status(400).json({
        error: 'Cannot delete institute with active users or exams. Deactivate them first.',
      });
    }

    institute.status = 'INACTIVE';
    await institute.save();

    res.json({ message: 'Institute deactivated successfully', institute });
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
    const { page = 1, limit = 20, organizationId, instituteId, role, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { role: { $ne: 'SUPER_ADMIN' } }; // Exclude SUPER_ADMIN from listings
    if (organizationId) filter.organizationId = organizationId;
    if (instituteId) filter.instituteId = instituteId;
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
        .populate('organizationId', 'name code')
        .populate('instituteId', 'name code')
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

// Create user
router.post(
  '/users',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['ORG_ADMIN', 'INSTITUTE_ADMIN', 'TEACHER', 'STUDENT']).withMessage('Invalid role'),
    body('organizationId').isMongoId().withMessage('Valid organization ID is required'),
    body('instituteId')
      .optional()
      .isMongoId()
      .custom((value, { req }) => {
        // Institute ID required for INSTITUTE_ADMIN, TEACHER, STUDENT
        if (['INSTITUTE_ADMIN', 'TEACHER', 'STUDENT'].includes(req.body.role) && !value) {
          throw new Error('Institute ID is required for this role');
        }
        return true;
      }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, organizationId, instituteId, mobile, college, degree, branch } = req.body;

      // Check if user exists
      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Verify organization exists
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      // Verify institute exists and belongs to organization (if provided)
      if (instituteId) {
        const institute = await Institute.findById(instituteId);
        if (!institute) {
          return res.status(404).json({ error: 'Institute not found' });
        }
        if (institute.organizationId.toString() !== organizationId) {
          return res.status(400).json({ error: 'Institute does not belong to the specified organization' });
        }
      }

      const user = new User({
        name,
        email,
        password,
        role,
        organizationId,
        instituteId: instituteId || null,
        mobile,
        college,
        degree,
        branch,
        status: 'ACTIVE',
      });

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      await user.populate('organizationId', 'name code');
      await user.populate('instituteId', 'name code');

      res.status(201).json({ user: { ...userObj, organizationId: user.organizationId, instituteId: user.instituteId } });
    } catch (error) {
      next(error);
    }
  }
);

// Update user
router.put(
  '/users/:userId',
  [
    body('name').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('role').optional().isIn(['ORG_ADMIN', 'INSTITUTE_ADMIN', 'TEACHER', 'STUDENT']),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED']),
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

      const { name, email, password, role, organizationId, instituteId, status, mobile, college, degree, branch } = req.body;

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
      if (role) user.role = role;
      if (organizationId) {
        const org = await Organization.findById(organizationId);
        if (!org) {
          return res.status(404).json({ error: 'Organization not found' });
        }
        user.organizationId = organizationId;
      }
      if (instituteId !== undefined) {
        if (instituteId) {
          const inst = await Institute.findById(instituteId);
          if (!inst) {
            return res.status(404).json({ error: 'Institute not found' });
          }
          if (user.organizationId && inst.organizationId.toString() !== user.organizationId.toString()) {
            return res.status(400).json({ error: 'Institute does not belong to user\'s organization' });
          }
        }
        user.instituteId = instituteId;
      }
      if (status) user.status = status;
      if (mobile !== undefined) user.mobile = mobile;
      if (college !== undefined) user.college = college;
      if (degree !== undefined) user.degree = degree;
      if (branch !== undefined) user.branch = branch;

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      await user.populate('organizationId', 'name code');
      await user.populate('instituteId', 'name code');

      res.json({ user: { ...userObj, organizationId: user.organizationId, instituteId: user.instituteId } });
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
    const { page = 1, limit = 20, organizationId, instituteId, createdBy, isActive, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (organizationId) filter.organizationId = organizationId;
    if (instituteId) filter.instituteId = instituteId;
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
        .populate('organizationId', 'name code')
        .populate('instituteId', 'name code')
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
    const { page = 1, limit = 20, organizationId, instituteId, examId, userId, isCompleted } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (organizationId) filter.organizationId = organizationId;
    if (instituteId) filter.instituteId = instituteId;
    if (examId) filter.examId = examId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';

    const [attempts, total] = await Promise.all([
      ExamAttempt.find(filter)
        .populate('examId', 'title organizationId instituteId')
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
