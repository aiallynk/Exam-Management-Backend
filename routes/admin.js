import express from 'express';
import User from '../models/User.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import SystemConfig from '../models/SystemConfig.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import {
  loadCertificateTemplate,
  persistCertificateTemplate,
  extractTemplatePlaceholders,
  DEFAULT_CERTIFICATE_TEMPLATE,
  MIN_CERTIFICATION_PERCENTAGE,
} from '../utils/certificateTemplate.js';

const router = express.Router();

// Get all students (filtered by tenant for ORG_ADMIN/INSTITUTE_ADMIN)
router.get('/students', requireAuth, requireRole('ADMIN', 'INSTITUTE_ADMIN', 'ORG_ADMIN'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { role: 'STUDENT' };
    
    // Filter by tenant for ORG_ADMIN and INSTITUTE_ADMIN
    if (req.user.role === 'ORG_ADMIN' && req.user.organizationId) {
      filter.organizationId = req.user.organizationId;
      filter.instituteId = null;
    } else if (req.user.role === 'INSTITUTE_ADMIN' && req.user.instituteId) {
      filter.instituteId = req.user.instituteId;
      filter.organizationId = null;
    }
    // ADMIN (legacy) can see all students (no tenant filter)

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const students = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Check blocked status for each student
    const studentsWithStatus = await Promise.all(
      students.map(async (student) => {
        const blockedConfig = await SystemConfig.findOne({
          key: `blocked_student_${student._id}`,
        });

        return {
          ...student.toObject(),
          isBlocked: blockedConfig?.value === 'true',
        };
      })
    );

    const total = await User.countDocuments(filter);

    res.json({
      students: studentsWithStatus,
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

// Block/Unblock student
router.post(
  '/students/:studentId/block',
  requireAuth,
  requireRole('ADMIN', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  [
    body('blocked').isBoolean().withMessage('Blocked status must be a boolean'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const student = await User.findById(req.params.studentId);
      if (!student || student.role !== 'STUDENT') {
        return res.status(404).json({ error: 'Student not found' });
      }

      // Verify tenant access for ORG_ADMIN and INSTITUTE_ADMIN
      if (req.user.role === 'ORG_ADMIN') {
        if (student.organizationId?.toString() !== req.user.organizationId?.toString() || student.instituteId) {
          return res.status(403).json({ error: 'Access denied - Student does not belong to your organization' });
        }
      } else if (req.user.role === 'INSTITUTE_ADMIN') {
        if (student.instituteId?.toString() !== req.user.instituteId?.toString() || student.organizationId) {
          return res.status(403).json({ error: 'Access denied - Student does not belong to your institute' });
        }
      }

      const { blocked } = req.body;
      const configKey = `blocked_student_${student._id}`;

      let config = await SystemConfig.findOne({ key: configKey });

      if (config) {
        config.value = blocked ? 'true' : 'false';
        config.updatedBy = req.user._id;
        await config.save();
      } else {
        config = new SystemConfig({
          key: configKey,
          value: blocked ? 'true' : 'false',
          description: `Block status for student ${student.email}`,
          updatedBy: req.user._id,
        });
        await config.save();
      }

      res.json({
        message: `Student ${blocked ? 'blocked' : 'unblocked'} successfully`,
        isBlocked: blocked,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Reset student password
router.post(
  '/students/:studentId/reset-password',
  requireAuth,
  requireRole('ADMIN', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  async (req, res, next) => {
    try {
      const student = await User.findById(req.params.studentId);
      if (!student || student.role !== 'STUDENT') {
        return res.status(404).json({ error: 'Student not found' });
      }

      // Verify tenant access for ORG_ADMIN and INSTITUTE_ADMIN
      if (req.user.role === 'ORG_ADMIN') {
        if (student.organizationId?.toString() !== req.user.organizationId?.toString() || student.instituteId) {
          return res.status(403).json({ error: 'Access denied - Student does not belong to your organization' });
        }
      } else if (req.user.role === 'INSTITUTE_ADMIN') {
        if (student.instituteId?.toString() !== req.user.instituteId?.toString() || student.organizationId) {
          return res.status(403).json({ error: 'Access denied - Student does not belong to your institute' });
        }
      }

      // Generate random password
      const newPassword = crypto.randomBytes(8).toString('hex');
      student.password = newPassword;
      await student.save();

      res.json({
        message: 'Password reset successfully',
        newPassword, // In production, send via email instead
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get student results
router.get(
  '/students/:studentId/results',
  requireAuth,
  requireRole('ADMIN', 'DESIGNER', 'TEACHER', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  async (req, res, next) => {
    try {
      const student = await User.findById(req.params.studentId);
      if (!student || student.role !== 'STUDENT') {
        return res.status(404).json({ error: 'Student not found' });
      }

      // Verify tenant access for ORG_ADMIN and INSTITUTE_ADMIN
      if (req.user.role === 'ORG_ADMIN') {
        if (student.organizationId?.toString() !== req.user.organizationId?.toString() || student.instituteId) {
          return res.status(403).json({ error: 'Access denied - Student does not belong to your organization' });
        }
      } else if (req.user.role === 'INSTITUTE_ADMIN') {
        if (student.instituteId?.toString() !== req.user.instituteId?.toString() || student.organizationId) {
          return res.status(403).json({ error: 'Access denied - Student does not belong to your institute' });
        }
      }

      // Allow fetching all results - use a very high limit if not specified, or use limit from query
      const { page = 1, limit } = req.query;
      const parsedLimit = limit ? parseInt(limit) : 10000; // Default to very high number to get all results
      const skip = (parseInt(page) - 1) * parsedLimit;

      const attempts = await ExamAttempt.find({
        userId: student._id,
        isCompleted: true,
      })
        .populate('examId', 'title duration')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit);

      // Use the ensureScoreSummary utility for consistent score calculation
      const { ensureScoreSummary } = await import('../utils/attemptScores.js');
      
      const results = await Promise.all(
        attempts.map(async (attempt) => {
          const { summary } = await ensureScoreSummary(attempt);
          
          return {
            attempt,
            score: summary,
          };
        })
      );

      const total = await ExamAttempt.countDocuments({
        userId: student._id,
        isCompleted: true,
      });

      res.json({
        student,
        results,
        pagination: {
          page: parseInt(page),
          limit: parsedLimit,
          total,
          pages: Math.ceil(total / parsedLimit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Create user (any role)
router.post(
  '/create-user',
  requireAuth,
  requireRole('ADMIN', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('role')
      .isIn(['STUDENT', 'DESIGNER', 'ADMIN'])
      .withMessage('Invalid role'),
    body('password')
      .optional()
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, role, password, ...otherFields } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Set tenant IDs based on admin's tenant
      const userData = {
        name,
        email,
        password: password || crypto.randomBytes(8).toString('hex'),
        role,
        ...otherFields,
      };

      // ORG_ADMIN can only create users for their organization
      if (req.user.role === 'ORG_ADMIN' && req.user.organizationId) {
        userData.organizationId = req.user.organizationId;
        userData.instituteId = null;
      }
      // INSTITUTE_ADMIN can only create users for their institute
      else if (req.user.role === 'INSTITUTE_ADMIN' && req.user.instituteId) {
        userData.instituteId = req.user.instituteId;
        userData.organizationId = null;
      }
      // Legacy ADMIN can create users without tenant (they'll be assigned later)

      const user = new User(userData);

      await user.save();

      res.status(201).json({
        user: user.toJSON(),
        password: password ? undefined : userPassword, // Only return if auto-generated
      });
    } catch (error) {
      next(error);
    }
  }
);

// Certificate template configuration
router.get(
  '/certificate-template',
  requireAuth,
  requireRole('ADMIN', 'DESIGNER', 'TEACHER', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  async (req, res, next) => {
    try {
      const template = await loadCertificateTemplate();
      res.json({
        template,
        placeholders: extractTemplatePlaceholders(),
        defaults: DEFAULT_CERTIFICATE_TEMPLATE,
        minPercentage: MIN_CERTIFICATION_PERCENTAGE,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/certificate-template',
  requireAuth,
  requireRole('ADMIN', 'DESIGNER', 'TEACHER', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  [body('template').isObject().withMessage('Template configuration is required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { template } = req.body;
      const mergedTemplate = await persistCertificateTemplate(template, req.user._id);

      res.json({
        success: true,
        template: mergedTemplate,
        placeholders: extractTemplatePlaceholders(),
        minPercentage: MIN_CERTIFICATION_PERCENTAGE,
        message: 'Certificate template updated successfully.',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

