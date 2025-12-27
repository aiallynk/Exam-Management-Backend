import express from 'express';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import ExamParticipant from '../models/ExamParticipant.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { ensureExamParticipant } from '../middleware/examPermissions.js';
import { body, validationResult } from 'express-validator';
import { sanitizePagination } from '../middleware/validation.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import {
  loadCertificateTemplate,
  applyCertificateTemplate,
  MIN_CERTIFICATION_PERCENTAGE,
} from '../utils/certificateTemplate.js';
import { ensureScoreSummary } from '../utils/attemptScores.js';

const router = express.Router();

// Get all exams (filtered by exam permissions and tenant)
// Universal: Shows exams based on exam context roles, not user system role
router.get('/', requireAuth, requireTenant, enforceTenantBoundaries, sanitizePagination, async (req, res, next) => {
  try {
    const { page, limit, isActive, filterBy } = req.query;
    const skip = (page - 1) * limit;

    let filter = { ...req.tenantFilter };
    
    // SUPER_ADMIN, TENANT_ADMIN, and EXAM_CREATOR see all exams in their scope
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'TENANT_ADMIN' || req.user.role === 'EXAM_CREATOR') {
      if (isActive !== undefined) {
        filter.isActive = isActive === 'true';
      }
    } else {
      // Regular users see exams based on their exam context roles
      // Get all ExamParticipant records for this user
      const participants = await ExamParticipant.find({ userId: req.user._id })
        .select('examId examRole')
        .lean();
      
      const examIds = participants.map(p => p.examId);
      
      if (filterBy === 'created') {
        // Show only exams user created (CREATOR role)
        const creatorExamIds = participants
          .filter(p => p.examRole === 'CREATOR')
          .map(p => p.examId);
        filter._id = { $in: creatorExamIds };
      } else if (filterBy === 'canAttempt') {
        // Show only exams user can attempt (CANDIDATE role)
        const candidateExamIds = participants
          .filter(p => p.examRole === 'CANDIDATE')
          .map(p => p.examId);
        filter._id = { $in: candidateExamIds };
        filter.isActive = true; // Only active exams can be attempted
      } else if (filterBy === 'canEvaluate') {
        // Show only exams user can evaluate (EVALUATOR role)
        const evaluatorExamIds = participants
          .filter(p => p.examRole === 'EVALUATOR')
          .map(p => p.examId);
        filter._id = { $in: evaluatorExamIds };
      } else {
        // Default: show all exams user has any role in
        if (examIds.length > 0) {
          filter._id = { $in: examIds };
          // For candidates, only show active exams
          const candidateExamIds = participants
            .filter(p => p.examRole === 'CANDIDATE')
            .map(p => p.examId);
          if (candidateExamIds.length > 0 && examIds.every(id => candidateExamIds.includes(id))) {
            filter.isActive = true;
          }
        } else {
          // User has no exam roles, return empty
          filter._id = { $in: [] };
        }
      }
    }

    const exams = await Exam.find(filter)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Exam.countDocuments(filter);

    res.json({
      exams,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get single exam
// Universal: Access based on exam permissions, not user role
router.get('/:examId', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId).populate(
      'createdBy',
      'name email'
    );

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // SUPER_ADMIN, TENANT_ADMIN, and EXAM_CREATOR can access all exams in their scope
    if (req.user.role === 'SUPER_ADMIN') {
      return res.json({ exam });
    }

    if (req.user.role === 'TENANT_ADMIN' || req.user.role === 'EXAM_CREATOR') {
      const userTenantId = req.user.tenantId;
      const examTenantId = exam.tenantId;
      
      if (userTenantId && examTenantId && userTenantId.toString() === examTenantId.toString()) {
        return res.json({ exam });
      }
    }

    // Regular users: check exam permissions
    const { hasExamPermission } = await import('../middleware/examPermissions.js');
    const hasViewResults = await hasExamPermission(req.user._id, exam._id, 'VIEW_RESULTS');
    const hasAttemptExam = await hasExamPermission(req.user._id, exam._id, 'ATTEMPT_EXAM');
    const hasCreateSession = await hasExamPermission(req.user._id, exam._id, 'CREATE_SESSION');

    // User must have at least one permission to view exam
    if (!hasViewResults && !hasAttemptExam && !hasCreateSession) {
      return res.status(403).json({ error: 'You do not have access to this exam' });
    }

    // Candidates can only see active exams
    if (hasAttemptExam && !hasCreateSession && !exam.isActive) {
      return res.status(403).json({ error: 'Exam is not currently available' });
    }

    res.json({ exam });
  } catch (error) {
    next(error);
  }
});

/**
 * Create exam - Only EXAM_CREATOR can create exams
 * 
 * Simple flow:
 * 1. User must be EXAM_CREATOR role
 * 2. User must belong to a tenant (except SUPER_ADMIN)
 * 3. Exam is created with user's tenantId
 * 4. ExamParticipant record is auto-created with CREATOR role
 */
router.post(
  '/',
  requireAuth,
  requireTenant, // Ensure user belongs to a tenant (except SUPER_ADMIN)
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can create exams
  auditLog(AUDIT_ACTIONS.EXAM_CREATED, (req, res) => ({
    examTitle: req.body.title,
    examId: res.locals.examId, // Will be set after creation
  })),
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('duration').isInt({ min: 1 }).withMessage('Duration must be a positive number'),
    body('gracePeriod').optional().isInt({ min: 0 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
    body('showResultsImmediately').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        title,
        description,
        duration,
        gracePeriod,
        maxAttempts,
        isActive,
        showResultsImmediately,
        allowCertification,
        passingPercentage,
        certificateTemplate,
      } =
        req.body;

      // Set tenant IDs based on user's tenant (Organization OR Institute)
      // SUPER_ADMIN can create exams without tenant (for global use)
      const examData = {
        title,
        description,
        duration,
        gracePeriod: gracePeriod || 0,
        maxAttempts: maxAttempts || 1,
        isActive: isActive !== undefined ? isActive : true,
        showResultsImmediately: Boolean(showResultsImmediately),
        allowCertification: Boolean(allowCertification),
        passingPercentage: passingPercentage !== undefined 
          ? Math.max(0, Math.min(100, parseInt(passingPercentage) || 60))
          : 60,
        certificateTemplate: allowCertification ? (certificateTemplate || null) : null,
        createdBy: req.user._id,
      };

      // Set tenant ID
      if (req.user.role !== 'SUPER_ADMIN' && req.user.tenantId) {
        examData.tenantId = req.user.tenantId;
      }

      const exam = new Exam(examData);
      await exam.save();
      await exam.populate('createdBy', 'name email');

      // UNIVERSAL: Auto-create ExamParticipant with CREATOR role
      // This enables exam-context permissions instead of role-based assumptions
      await ensureExamParticipant(
        req.user._id,
        exam._id,
        'CREATOR',
        req.user._id
      );

      // Store exam ID for audit log
      res.locals.examId = exam._id.toString();

      res.status(201).json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Update exam - Only EXAM_CREATOR who owns the exam or SUPER_ADMIN can update
// Simple permission: EXAM_CREATOR can update their own exams within their tenant
router.put(
  '/:examId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin, // Checks EXAM_CREATOR ownership or SUPER_ADMIN
  [
    body('title').optional().trim().notEmpty(),
    body('duration').optional().isInt({ min: 1 }),
    body('gracePeriod').optional().isInt({ min: 0 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
    body('showResultsImmediately').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const {
        title,
        description,
        duration,
        gracePeriod,
        maxAttempts,
        isActive,
        showResultsImmediately,
        resultsReleasedAt,
      } =
        req.body;

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (duration) exam.duration = duration;
      if (gracePeriod !== undefined) exam.gracePeriod = gracePeriod;
      if (maxAttempts !== undefined) exam.maxAttempts = maxAttempts;
      if (isActive !== undefined) exam.isActive = isActive;
      if (showResultsImmediately !== undefined) {
        exam.showResultsImmediately = showResultsImmediately;
        if (showResultsImmediately) {
          exam.resultsReleasedAt = null;
        }
      }
      if (resultsReleasedAt !== undefined) {
        exam.resultsReleasedAt = resultsReleasedAt ? new Date(resultsReleasedAt) : null;
      }

      await exam.save();
      await exam.populate('createdBy', 'name email');

      res.json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Delete exam (DESIGNER own/ADMIN/ORG_ADMIN/INSTITUTE_ADMIN)
router.delete(
  '/:examId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin,
  auditLog(AUDIT_ACTIONS.EXAM_DELETED, (req) => ({
    examId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      await Exam.findByIdAndDelete(req.params.examId);
      res.json({ message: 'Exam deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Release results
router.post(
  '/:examId/release-results',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin,
  auditLog(AUDIT_ACTIONS.EXAM_RESULTS_RELEASED, (req) => ({
    examId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      exam.resultsReleasedAt = new Date();
      await exam.save();
      await exam.populate('createdBy', 'name email');

      res.json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Send certificates separately (for students who passed >= 60%)
router.post(
  '/:examId/send-certificates',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Find all completed attempts for this exam
      const attempts = await ExamAttempt.find({
        examId: exam._id,
        isCompleted: true,
        isDisqualified: false,
      })
        .populate('userId', 'name email')
        .populate('examId', 'title allowCertification passingPercentage certificateTemplate')
        .populate('questionPaperId', '_id');

      const certificateResults = [];
      // Note: For bulk sending, we use global template. 
      // Individual certificate generation uses exam-specific templates.
      const template = await loadCertificateTemplate();

      // Process each attempt to check if they qualify for certificate
      for (const attempt of attempts) {
        const { summary } = await ensureScoreSummary(attempt);
        const percentage = summary?.percentage ?? 0;

        // Use exam-specific passing percentage if available, otherwise use default
        const minPercentage = attempt.examId?.passingPercentage !== undefined
          ? attempt.examId.passingPercentage
          : MIN_CERTIFICATION_PERCENTAGE;

        // Only send certificates to students who scored >= passing percentage
        if (percentage >= minPercentage) {
          const examTitle = attempt.examId?.title || attempt.examSnapshot?.title || 'Exam';
          const attemptDate = attempt.submitTime ? new Date(attempt.submitTime) : null;
          const issuedTimestamp = attemptDate ? attemptDate : new Date();

          const context = {
            studentName: attempt.userId?.name || 'Candidate', // Universal: Changed from 'Student' to 'Candidate'
            examTitle,
            attemptDate: attemptDate ? attemptDate.toLocaleDateString() : '',
            issuedOn: issuedTimestamp.toLocaleDateString(),
            percentage,
            score: summary?.totalScore ?? 0,
            maxScore: summary?.maxScore ?? 0,
            attemptId: attempt._id.toString(),
          };

          const renderedTemplate = applyCertificateTemplate(template, context);

          // TODO: Implement actual email sending service here
          // For now, we'll just mark that certificates were sent
          // In production, you would:
          // 1. Generate PDF certificate
          // 2. Send email with certificate attachment
          // 3. Use a service like nodemailer, SendGrid, etc.

          certificateResults.push({
            attemptId: attempt._id,
            studentName: attempt.userId?.name,
            studentEmail: attempt.userId?.email,
            percentage,
            certificateGenerated: true,
            // certificateSent: true, // Set when email is actually sent
          });
        }
      }

      // Mark exam with certificate sent timestamp
      exam.certificatesSentAt = new Date();
      await exam.save();

      res.json({
        success: true,
        message: `Certificates processed for ${certificateResults.length} candidate(s)`, // Universal: Changed from 'student(s)' to 'candidate(s)'
        count: certificateResults.length,
        certificates: certificateResults,
        exam: {
          _id: exam._id,
          title: exam.title,
          certificatesSentAt: exam.certificatesSentAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;


