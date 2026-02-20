import express from 'express';
import User from '../models/User.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import SystemConfig from '../models/SystemConfig.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import { validatePasswordStrength, generateSecurePassword } from '../utils/passwordValidator.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import {
  loadCertificateTemplate,
  persistCertificateTemplate,
  extractTemplatePlaceholders,
  DEFAULT_CERTIFICATE_TEMPLATE,
  MIN_CERTIFICATION_PERCENTAGE,
} from '../utils/certificateTemplate.js';

const router = express.Router();

// Get all candidates (filtered by tenant for EXAM_CREATOR and TENANT_ADMIN)
router.get('/candidates', requireAuth, requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter by CANDIDATE role
    const filter = { 
      role: 'CANDIDATE'
    };
    
    // Filter by tenant for EXAM_CREATOR and TENANT_ADMIN
    if ((req.user.role === 'EXAM_CREATOR' || req.user.role === 'TENANT_ADMIN') && req.user.tenantId) {
      filter.tenantId = req.user.tenantId;
    }

    if (search) {
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
        ],
      });
    }

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Check blocked status for each user (universal: changed from blocked_student_ to blocked_user_)
    const usersWithStatus = await Promise.all(
      users.map(async (user) => {
        // Check both old and new key format for backward compatibility
        const blockedConfig = await SystemConfig.findOne({
          $or: [
            { key: `blocked_user_${user._id}` }, // New universal format
            { key: `blocked_student_${user._id}` }, // Legacy format
          ],
        });

        return {
          ...user.toObject(),
          isBlocked: blockedConfig?.value === 'true',
        };
      })
    );

    const total = await User.countDocuments(filter);

    res.json({
      students: usersWithStatus, // Keep 'students' key for backward compatibility
      users: usersWithStatus, // Also provide 'users' key for new clients
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

// Block/Unblock candidate
router.post(
  '/candidates/:candidateId/block',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.USER_BLOCKED, (req) => ({
    targetUserId: req.params.studentId,
    blocked: req.body.blocked,
  })),
  [
    body('blocked').isBoolean().withMessage('Blocked status must be a boolean'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findById(req.params.studentId);
      // Check for CANDIDATE role (students/candidates)
      if (!user || user.role !== 'CANDIDATE') {
        return res.status(404).json({ error: 'Candidate not found' });
      }

      // Verify tenant access for TENANT_ADMIN
      const userTenantId = user.organizationId || user.instituteId;
      const adminTenantId = req.user.organizationId || req.user.instituteId;
      
      if (userTenantId && adminTenantId && userTenantId.toString() !== adminTenantId.toString()) {
        return res.status(403).json({ error: 'Access denied - User does not belong to your tenant' });
      }

      const { blocked } = req.body;
      // Universal: Use blocked_user_ key (also update legacy blocked_student_ for backward compatibility)
      const configKey = `blocked_user_${user._id}`;
      const legacyConfigKey = `blocked_student_${user._id}`;

      // Update or create new config with universal key
      let config = await SystemConfig.findOne({ key: configKey });
      if (!config) {
        // Check for legacy key and migrate
        const legacyConfig = await SystemConfig.findOne({ key: legacyConfigKey });
        if (legacyConfig) {
          legacyConfig.key = configKey; // Migrate to new key
          legacyConfig.description = `Block status for user ${user.email}`;
          legacyConfig.updatedBy = req.user._id;
          await legacyConfig.save();
          config = legacyConfig;
        }
      }

      if (config) {
        config.value = blocked ? 'true' : 'false';
        config.updatedBy = req.user._id;
        await config.save();
      } else {
        config = new SystemConfig({
          key: configKey,
          value: blocked ? 'true' : 'false',
          description: `Block status for user ${user.email}`, // Universal: changed from 'student' to 'user'
          updatedBy: req.user._id,
        });
        await config.save();
      }

      res.json({
        message: `User ${blocked ? 'blocked' : 'unblocked'} successfully`, // Universal: changed from 'Student' to 'User'
        isBlocked: blocked,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Reset candidate password
router.post(
  '/candidates/:candidateId/reset-password',
  requireAuth,
  requireRole('EXAM_CREATOR'),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.params.candidateId);
      // Check for CANDIDATE role
      if (!user || user.role !== 'CANDIDATE') {
        return res.status(404).json({ error: 'Candidate not found' });
      }

      // Verify tenant access for EXAM_CREATOR
      const userTenantId = user.tenantId;
      const adminTenantId = req.user.tenantId;
      
      if (userTenantId && adminTenantId && userTenantId.toString() !== adminTenantId.toString()) {
        return res.status(403).json({ error: 'Access denied - Candidate does not belong to your tenant' });
      }

      // Generate secure random password
      const newPassword = generateSecurePassword();
      user.password = newPassword;
      await user.save();

      res.json({
        message: 'Password reset successfully',
        newPassword, // In production, send via email instead
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get candidate results
router.get(
  '/candidates/:candidateId/results',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'CANDIDATE'),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.params.candidateId);
      // Check for CANDIDATE role
      if (!user || user.role !== 'CANDIDATE') {
        return res.status(404).json({ error: 'Candidate not found' });
      }

      // Verify tenant access
      // CANDIDATE users can only see their own results
      if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'EXAM_CREATOR') {
        if (user._id.toString() !== req.user._id.toString()) {
          return res.status(403).json({ error: 'You can only view your own results' });
        }
      } else {
        // EXAM_CREATOR: verify tenant access
        const userTenantId = user.tenantId;
        const adminTenantId = req.user.tenantId;
        
        if (userTenantId && adminTenantId && userTenantId.toString() !== adminTenantId.toString()) {
          return res.status(403).json({ error: 'Access denied - Candidate does not belong to your tenant' });
        }
      }

      // Allow fetching all results - use a very high limit if not specified, or use limit from query
      const { page = 1, limit } = req.query;
      const parsedLimit = limit ? parseInt(limit) : 10000; // Default to very high number to get all results
      const skip = (parseInt(page) - 1) * parsedLimit;

      const attempts = await ExamAttempt.find({
        userId: user._id,
        isCompleted: true,
      })
        .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit);

      const visibleAttempts = req.user.role === 'CANDIDATE'
        ? attempts.filter((attempt) => {
            const exam = attempt.examId;
            if (!exam) return false;
            if (exam.showResultsImmediately) return true;
            if (!exam.resultsReleasedAt) return false;
            return new Date(exam.resultsReleasedAt) <= new Date();
          })
        : attempts;

      // Use the ensureScoreSummary utility for consistent score calculation
      const { ensureScoreSummary } = await import('../utils/attemptScores.js');
      
      const results = await Promise.all(
        visibleAttempts.map(async (attempt) => {
          const { summary } = await ensureScoreSummary(attempt);
          
          return {
            attempt,
            score: summary,
          };
        })
      );

      const total = await ExamAttempt.countDocuments({
        userId: user._id,
        isCompleted: true,
      });

      res.json({
        candidate: user,
        results,
        pagination: {
          page: parseInt(page),
          limit: parsedLimit,
          total: req.user.role === 'CANDIDATE' ? results.length : total,
          pages: req.user.role === 'CANDIDATE'
            ? Math.ceil(results.length / parsedLimit)
            : Math.ceil(total / parsedLimit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Create user (EXAM_CREATOR or CANDIDATE)
router.post(
  '/create-user',
  requireAuth,
  requireRole('EXAM_CREATOR'),
  auditLog(AUDIT_ACTIONS.USER_CREATED, (req) => ({
    createdUserEmail: req.body.email,
    createdUserRole: req.body.role,
  })),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('role')
      .isIn(['EXAM_CREATOR', 'CANDIDATE'])
      .withMessage('Invalid role. Must be EXAM_CREATOR or CANDIDATE'),
    body('password')
      .optional()
      .custom((value) => {
        if (value) {
          try {
            validatePasswordStrength(value);
            return true;
          } catch (error) {
            throw new Error(error.message);
          }
        }
        return true; // Optional, so empty is OK
      })
      .withMessage('Password does not meet strength requirements'),
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
      const autoGeneratedPassword = password || generateSecurePassword();
      const userData = {
        name,
        email,
        password: autoGeneratedPassword,
        role,
        ...otherFields,
      };

      // TENANT_ADMIN can only create users for their tenant
      if (req.user.role === 'TENANT_ADMIN') {
        if (req.user.organizationId) {
          userData.organizationId = req.user.organizationId;
          userData.instituteId = null;
        } else if (req.user.instituteId) {
          userData.instituteId = req.user.instituteId;
          userData.organizationId = null;
        }
      }
      // Legacy role support (backward compatibility)
      if (req.user.role === 'ORG_ADMIN' && req.user.organizationId) {
        userData.organizationId = req.user.organizationId;
        userData.instituteId = null;
      } else if (req.user.role === 'INSTITUTE_ADMIN' && req.user.instituteId) {
        userData.instituteId = req.user.instituteId;
        userData.organizationId = null;
      }

      const user = new User(userData);

      await user.save();

      res.status(201).json({
        user: user.toJSON(),
        password: password ? undefined : autoGeneratedPassword, // Only return if auto-generated
      });
    } catch (error) {
      next(error);
    }
  }
);

// Certificate template configuration (available to EXAM_CREATOR)
router.get(
  '/certificate-template',
  requireAuth,
  requireRole('EXAM_CREATOR'),
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
  requireRole('EXAM_CREATOR'),
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
