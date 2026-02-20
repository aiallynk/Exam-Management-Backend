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
 * questionPaperId is optional - if not provided, uses first active question paper
 * expiresAt is optional - defaults to 30 days from now
 */
router.post(
  '/:examId/generate',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  [
    body('questionPaperId').optional().notEmpty().withMessage('Question paper ID must not be empty if provided'),
    body('expiresAt').optional().isISO8601().withMessage('Expiry date must be a valid ISO 8601 date'),
  ],
  auditLog(AUDIT_ACTIONS.EXAM_PACKAGE_GENERATED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    const { examId } = req.params;
    const { questionPaperId, expiresAt } = req.body;

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[Package Generation] Validation errors for exam ${examId}:`, errors.array());
        return res.status(400).json({ errors: errors.array() });
      }

      console.log(`[Package Generation] Starting package generation for exam ${examId} by user ${req.user._id}`);

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        console.error(`[Package Generation] Exam ${examId} not found`);
        return res.status(404).json({ error: 'Exam not found' });
      }

      console.log(`[Package Generation] Exam found: ${exam.title} (Active: ${exam.isActive})`);

      // Check tenant boundary
      if (req.user.role !== 'SUPER_ADMIN' && exam.tenantId.toString() !== req.user.tenantId?.toString()) {
        console.error(`[Package Generation] Tenant mismatch for exam ${examId}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check permission (EXAM_CREATOR or TENANT_ADMIN)
      const canCreate = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION') ||
        req.user.role === 'TENANT_ADMIN';
      
      if (!canCreate && req.user.role !== 'TENANT_ADMIN') {
        console.error(`[Package Generation] Permission denied for user ${req.user._id} on exam ${examId}`);
        return res.status(403).json({ error: 'You do not have permission to generate exam packages' });
      }

      // Get question paper (if not provided, use first active one)
      const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
      let resolvedQuestionPaperId = questionPaperId;

      if (!resolvedQuestionPaperId) {
        console.log(`[Package Generation] No questionPaperId provided, finding first active question paper for exam ${examId}`);
        const questionPapers = await QuestionPaper.find({ examId, isActive: true });
        if (questionPapers.length === 0) {
          console.error(`[Package Generation] No active question papers found for exam ${examId}`);
          return res.status(400).json({ 
            error: 'No active question papers found for this exam. Please create a question paper first.' 
          });
        }
        resolvedQuestionPaperId = questionPapers[0]._id.toString();
        console.log(`[Package Generation] Using question paper: ${resolvedQuestionPaperId} (${questionPapers[0].setName})`);
      }

      // Validate question paper exists and belongs to exam
      const questionPaper = await QuestionPaper.findById(resolvedQuestionPaperId);
      if (!questionPaper) {
        console.error(`[Package Generation] Question paper ${resolvedQuestionPaperId} not found`);
        return res.status(404).json({ error: 'Question paper not found' });
      }

      if (questionPaper.examId.toString() !== examId) {
        console.error(`[Package Generation] Question paper ${resolvedQuestionPaperId} does not belong to exam ${examId}`);
        return res.status(400).json({ error: 'Question paper does not belong to this exam' });
      }

      // Validate questions exist
      const Question = (await import('../models/Question.js')).default;
      const Section = (await import('../models/Section.js')).default;
      
      // Get all sections (both active and inactive) for debugging
      const allSections = await Section.find({ questionPaperId: resolvedQuestionPaperId });
      const activeSections = await Section.find({ questionPaperId: resolvedQuestionPaperId, isActive: true });
      const questions = await Question.find({ questionPaperId: resolvedQuestionPaperId });

      console.log(`[Package Generation] Validation for question paper ${resolvedQuestionPaperId}:`);
      console.log(`  - Total sections: ${allSections.length} (Active: ${activeSections.length}, Inactive: ${allSections.length - activeSections.length})`);
      console.log(`  - Total questions: ${questions.length}`);

      // Validate that questions exist (required for all exams)
      if (questions.length === 0) {
        console.error(`[Package Generation] No questions found for question paper ${resolvedQuestionPaperId}`);
        return res.status(400).json({ 
          error: 'No questions found for this question paper. Please add questions first.' 
        });
      }

      // Check if this is a section-based exam (questions have sectionId)
      const questionsWithSections = questions.filter(q => q.sectionId);
      const questionsWithoutSections = questions.filter(q => !q.sectionId);
      
      console.log(`  - Questions with sections: ${questionsWithSections.length}`);
      console.log(`  - Questions without sections: ${questionsWithoutSections.length}`);

      // For section-based exams, validate sections exist
      // For non-section-based exams, questions can exist without sections
      if (questionsWithSections.length > 0 && activeSections.length === 0) {
        // Check if there are inactive sections
        if (allSections.length > 0) {
          console.error(`[Package Generation] Questions have sectionId but no ACTIVE sections found. Found ${allSections.length} inactive sections.`);
          return res.status(400).json({ 
            error: `This question paper has ${allSections.length} section(s), but none are active. Please activate sections or remove section assignments from questions.` 
          });
        } else {
          console.error(`[Package Generation] Questions have sectionId but no sections found at all for question paper ${resolvedQuestionPaperId}`);
          return res.status(400).json({ 
            error: 'This question paper has questions assigned to sections, but no sections found. Please create sections or remove section assignments from questions.' 
          });
        }
      }

      // Log exam type
      if (activeSections.length > 0) {
        console.log(`[Package Generation] Section-based exam: ${activeSections.length} active sections, ${questions.length} questions`);
      } else if (questionsWithoutSections.length > 0) {
        console.log(`[Package Generation] Non-section-based exam: ${questions.length} questions (no sections required)`);
      } else {
        console.log(`[Package Generation] Mixed exam: ${questionsWithSections.length} questions with sections, ${questionsWithoutSections.length} without`);
      }

      // Set expiry date (default: 30 days from now)
      let expiryDate;
      if (expiresAt) {
        expiryDate = new Date(expiresAt);
        if (expiryDate <= new Date()) {
          console.error(`[Package Generation] Invalid expiry date: ${expiresAt}`);
          return res.status(400).json({ error: 'Expiry date must be in the future' });
        }
      } else {
        expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);
        console.log(`[Package Generation] Using default expiry: ${expiryDate.toISOString()}`);
      }

      console.log(`[Package Generation] Generating package for exam ${examId}, question paper ${resolvedQuestionPaperId}, expires ${expiryDate.toISOString()}`);

      // Generate package
      const packageInfo = await generateExamPackage(
        examId,
        resolvedQuestionPaperId,
        req.user._id,
        expiryDate
      );

      console.log(`[Package Generation] Package generated successfully: ID ${packageInfo.packageId}, Version ${packageInfo.version}, Size ${packageInfo.size} bytes`);

      res.status(201).json({
        message: 'Exam package generated successfully',
        package: packageInfo,
      });
    } catch (error) {
      console.error(`[Package Generation] Error generating package for exam ${examId}:`, error);
      console.error(`[Package Generation] Error stack:`, error.stack);
      // Don't fail silently - return error to client
      return res.status(500).json({ 
        error: 'Failed to generate exam package',
        message: error.message || 'Unknown error occurred',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
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

      // Check if question papers exist (for status info)
      const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
      const questionPapers = await QuestionPaper.find({ examId, isActive: true });
      const hasQuestionPapers = questionPapers.length > 0;

      // If questionPaperId provided, verify it exists
      if (questionPaperId) {
        const questionPaper = await QuestionPaper.findById(questionPaperId);
        if (!questionPaper) {
          return res.status(404).json({ error: 'Question paper not found' });
        }
      }

      // Get package info (questionPaperId is optional - if not provided, returns latest package for exam)
      const packageInfo = await getPackageInfo(examId, questionPaperId || null);

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

      // Verify exam is active (pre-download allowed for active exams with valid packages)
      if (!exam.isActive) {
        return res.status(403).json({ 
          error: 'Exam is not active. Packages can only be downloaded for active exams.' 
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

      // Check tenant boundary (SUPER_ADMIN can access all exams)
      if (req.user.role !== 'SUPER_ADMIN' && exam.tenantId.toString() !== req.user.tenantId?.toString()) {
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
