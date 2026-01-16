import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { hasExamPermission, requireExamPermission } from '../middleware/examPermissions.js';
import { body, validationResult } from 'express-validator';
import { validateObjectId } from '../middleware/validation.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import {
  generateExamPackage,
  getExamPackage,
  getPackageInfo,
  validatePackageHash,
} from '../services/examPackageService.js';
import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import ExamPackage from '../models/ExamPackage.js';

const router = express.Router();

/**
 * Generate exam package
 * POST /exam-packages/:examId/generate
 * Requires: EXAM_CREATOR or TENANT_ADMIN role
 */
router.post(
  '/:examId/generate',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  [
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('expiresAt').isISO8601().withMessage('Expiry date must be a valid ISO 8601 date'),
  ],
  auditLog(AUDIT_ACTIONS.EXAM_PACKAGE_GENERATED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { examId } = req.params;
      const { questionPaperId, expiresAt } = req.body;

      // Verify exam exists and user has permission
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check tenant boundary
      if (exam.tenantId.toString() !== req.user.tenantId?.toString()) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check permission (EXAM_CREATOR or TENANT_ADMIN)
      const canCreate = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION') ||
        req.user.role === 'TENANT_ADMIN';
      
      if (!canCreate && req.user.role !== 'TENANT_ADMIN') {
        return res.status(403).json({ error: 'You do not have permission to generate exam packages' });
      }

      // Validate expiry date
      const expiryDate = new Date(expiresAt);
      if (expiryDate <= new Date()) {
        return res.status(400).json({ error: 'Expiry date must be in the future' });
      }

      // Generate package
      const packageInfo = await generateExamPackage(
        examId,
        questionPaperId,
        req.user._id,
        expiryDate
      );

      res.status(201).json({
        message: 'Exam package generated successfully',
        package: packageInfo,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Get package info (metadata only)
 * GET /exam-packages/:examId/info
 * Requires: CANDIDATE role with ATTEMPT_EXAM permission
 */
router.get(
  '/:examId/info',
  requireAuth,
  requireTenant,
  requireRole('CANDIDATE'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const { examId } = req.params;
      const { questionPaperId } = req.query;

      if (!questionPaperId) {
        return res.status(400).json({ error: 'Question paper ID is required' });
      }

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check permission
      const canAttempt = await hasExamPermission(req.user._id, examId, 'ATTEMPT_EXAM');
      if (!canAttempt) {
        return res.status(403).json({ error: 'You do not have permission to access this exam package' });
      }

      // Check if user is admin (for canGenerate flag)
      const isAdmin = req.user.role === 'EXAM_CREATOR' || req.user.role === 'TENANT_ADMIN';
      const canGenerate = isAdmin && (
        await hasExamPermission(req.user._id, examId, 'CREATE_SESSION') ||
        req.user.role === 'TENANT_ADMIN'
      );

      // Check if question paper exists
      const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
      const questionPaper = await QuestionPaper.findById(questionPaperId);
      const hasQuestionPapers = questionPaper !== null;

      // Get package info
      const packageInfo = await getPackageInfo(examId, questionPaperId);

      if (!packageInfo) {
        return res.status(404).json({ 
          error: 'Exam package not found. The exam package has not been generated yet. Please contact the exam administrator.',
          examStatus: {
            isActive: exam.isActive,
            hasQuestionPapers,
          },
          canGenerate: canGenerate || undefined, // Only include if user is admin
        });
      }

      // Include exam status in response
      const response = {
        package: packageInfo,
        examStatus: {
          isActive: exam.isActive,
          hasQuestionPapers,
        }
      };

      // Add canGenerate flag for admins
      if (canGenerate) {
        response.canGenerate = true;
      }

      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Download exam package
 * GET /exam-packages/:examId/download
 * Requires: CANDIDATE role with ATTEMPT_EXAM permission
 */
router.get(
  '/:examId/download',
  requireAuth,
  requireTenant,
  requireRole('CANDIDATE'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const { examId } = req.params;
      const { questionPaperId, version } = req.query;

      if (!questionPaperId) {
        return res.status(400).json({ error: 'Question paper ID is required' });
      }

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check permission
      const canAttempt = await hasExamPermission(req.user._id, examId, 'ATTEMPT_EXAM');
      if (!canAttempt) {
        return res.status(403).json({ error: 'You do not have permission to download this exam package' });
      }

      // Optional: Check if user has an active session for this exam
      // This ensures packages are only downloaded when there's an active session
      const activeSession = await ExamSession.findOne({
        examId,
        isActive: true,
        startTime: { $lte: new Date() },
        endTime: { $gte: new Date() },
      });

      if (!activeSession) {
        return res.status(403).json({ 
          error: 'No active session found for this exam. Please check the exam schedule.' 
        });
      }

      // Get package
      const packageVersion = version ? parseInt(version, 10) : null;
      const packageData = await getExamPackage(examId, questionPaperId, packageVersion);

      // Convert Buffer to base64 for JSON response
      const encryptedDataBase64 = packageData.encryptedData.toString('base64');

      res.json({
        package: {
          packageId: packageData.packageId,
          examId: packageData.examId,
          version: packageData.version,
          encryptedData: encryptedDataBase64,
          hash: packageData.hash,
          size: packageData.size,
          expiresAt: packageData.expiresAt,
          createdAt: packageData.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Regenerate exam package
 * POST /exam-packages/:examId/regenerate
 * Requires: EXAM_CREATOR or TENANT_ADMIN role
 */
router.post(
  '/:examId/regenerate',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  [
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('expiresAt').optional().isISO8601().withMessage('Expiry date must be a valid ISO 8601 date'),
  ],
  auditLog(AUDIT_ACTIONS.EXAM_PACKAGE_GENERATED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { examId } = req.params;
      const { questionPaperId, expiresAt } = req.body;

      // Verify exam exists and user has permission
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check tenant boundary
      if (exam.tenantId.toString() !== req.user.tenantId?.toString()) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check permission (EXAM_CREATOR or TENANT_ADMIN)
      const canCreate = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION') ||
        req.user.role === 'TENANT_ADMIN';
      
      if (!canCreate && req.user.role !== 'TENANT_ADMIN') {
        return res.status(403).json({ error: 'You do not have permission to regenerate exam packages' });
      }

      // Set expiry date (default: 30 days from now)
      let expiryDate;
      if (expiresAt) {
        expiryDate = new Date(expiresAt);
        if (expiryDate <= new Date()) {
          return res.status(400).json({ error: 'Expiry date must be in the future' });
        }
      } else {
        expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);
      }

      // Deactivate old packages for this exam/question paper
      await ExamPackage.updateMany(
        {
          examId,
          questionPaperId,
          isActive: true,
        },
        {
          isActive: false,
        }
      );

      // Generate new package
      const packageInfo = await generateExamPackage(
        examId,
        questionPaperId,
        req.user._id,
        expiryDate
      );

      res.status(201).json({
        message: 'Exam package regenerated successfully',
        package: packageInfo,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * List all packages for an exam (admin only)
 * GET /exam-packages/:examId/list
 * Requires: EXAM_CREATOR or TENANT_ADMIN role
 */
router.get(
  '/:examId/list',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const { examId } = req.params;

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check tenant boundary
      if (exam.tenantId.toString() !== req.user.tenantId?.toString()) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get all packages for this exam
      const packages = await ExamPackage.find({
        examId,
      })
        .populate('questionPaperId', 'setName')
        .populate('createdBy', 'name email')
        .sort({ version: -1 })
        .lean();

      res.json({
        packages: packages.map(pkg => ({
          packageId: pkg._id.toString(),
          examId: pkg.examId.toString(),
          questionPaperId: pkg.questionPaperId?._id?.toString(),
          questionPaperSetName: pkg.questionPaperId?.setName,
          version: pkg.version,
          size: pkg.size,
          hash: pkg.packageHash,
          expiresAt: pkg.expiresAt,
          isActive: pkg.isActive,
          isExpired: pkg.expiresAt < new Date(),
          createdAt: pkg.createdAt,
          createdBy: pkg.createdBy ? {
            name: pkg.createdBy.name,
            email: pkg.createdBy.email,
          } : null,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
