import express from 'express';
import { body, validationResult } from 'express-validator';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireExamEvaluatorManager } from '../middleware/examPermissions.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { validateObjectId } from '../middleware/validation.js';
import { AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { FREE_PLAN_MESSAGES, isPlanFeatureEnabled } from '../config/planLimits.js';
import { resolveUserEffectivePlanType, sendPlanRestriction } from '../middleware/planRestrictions.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { requireEvaluatorAccess } from '../middleware/examPermissions.js';
import {
  SCOPE_TYPES,
  EvaluatorAssignmentError,
  loadExamAndEvaluator,
  createEvaluatorAssignment,
  getScopedQuestionIds,
  deriveReviewStatus,
} from '../services/evaluatorAssignmentService.js';
import { canOperateExam } from '../services/academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';

const router = express.Router();

const isAssignmentCurrentlyActive = (assignment, now = new Date()) =>
  assignment?.status === 'ACTIVE' &&
  new Date(assignment.accessStartsAt) <= now &&
  (!assignment.accessExpiresAt || new Date(assignment.accessExpiresAt) >= now);

const requireAssignmentOwner = async (req, res, next) => {
  try {
    const assignment = await ExaminerAssignment.findOne({
      _id: req.params.assignmentId,
      ...(req.tenantFilter || {}),
    }).lean();
    if (!assignment) return res.status(404).json({ error: 'Examiner assignment not found' });
    if (!(await canOperateExam(req.user, assignment.examId)) && !hasRole(req.user, 'TENANT_ADMIN')) {
      return res.status(403).json({ error: 'Only the responsible Exam Creator can change this evaluator assignment.' });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

// Create a scoped, time-bound examiner assignment.
router.post(
  '/',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER', 'TENANT_ADMIN'),
  requireExamEvaluatorManager({ examIdFrom: 'body' }),
  requireTenantFeature('EVALUATOR_REVIEW'),
  [
    body('examId').notEmpty().withMessage('examId is required').isMongoId(),
    body('examinerId').notEmpty().withMessage('examinerId is required').isMongoId(),
    body('scopeType').optional().isIn(SCOPE_TYPES),
    body('scopeData').optional().isObject(),
    body('accessStartsAt').optional().isISO8601(),
    body('accessExpiresAt').optional().isISO8601(),
    body('canViewStudentIdentity').optional().isBoolean(),
    body('canApproveAiScore').optional().isBoolean(),
    body('canOverrideScore').optional().isBoolean(),
    body('canAddFeedback').optional().isBoolean(),
    body('requiresOverrideReason').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      if (
        !isPlanFeatureEnabled(effectivePlanType, 'examinerReview') ||
        !isPlanFeatureEnabled(effectivePlanType, 'temporaryExaminerAssignment')
      ) {
        return sendPlanRestriction(res, FREE_PLAN_MESSAGES.EXAMINER_REVIEW_LOCKED);
      }

      const { examId, examinerId } = req.body;

      const { exam } = await loadExamAndEvaluator({
        examId,
        examinerId,
        tenantFilter: req.tenantFilter,
        actorRole: req.user.role,
      });

      const assignment = await createEvaluatorAssignment({
        exam,
        examinerId,
        scopeType: req.body.scopeType,
        scopeData: req.body.scopeData,
        accessStartsAt: req.body.accessStartsAt,
        accessExpiresAt: req.body.accessExpiresAt,
        capabilities: {
          canViewStudentIdentity: req.body.canViewStudentIdentity,
          canApproveAiScore: req.body.canApproveAiScore,
          canOverrideScore: req.body.canOverrideScore,
          canAddFeedback: req.body.canAddFeedback,
          requiresOverrideReason: req.body.requiresOverrideReason,
        },
        assignedBy: req.user._id,
        assignedByRole: req.user.role,
      });

      res.status(201).json({ assignment });
    } catch (error) {
      if (error instanceof EvaluatorAssignmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);

// Update / reassign an assignment (scope, dates, capability flags).
router.patch(
  '/:assignmentId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER', 'TENANT_ADMIN'),
  validateObjectId('assignmentId'),
  requireAssignmentOwner,
  async (req, res, next) => {
    try {
      const assignment = await ExaminerAssignment.findOne({
        _id: req.params.assignmentId,
        ...(req.tenantFilter || {}),
      });
      if (!assignment) {
        return res.status(404).json({ error: 'Examiner assignment not found' });
      }

      const editableFields = [
        'scopeType', 'scopeData', 'accessStartsAt', 'accessExpiresAt',
        'canViewStudentIdentity', 'canApproveAiScore', 'canOverrideScore',
        'canAddFeedback', 'requiresOverrideReason',
      ];
      editableFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          assignment[field] = req.body[field];
        }
      });

      await assignment.save();

      await logAuditEvent(AUDIT_ACTIONS.EXAMINER_ASSIGNMENT_UPDATED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: assignment.tenantId || null,
        resourceType: 'ExaminerAssignment',
        resourceId: assignment._id,
        details: { updatedFields: Object.keys(req.body || {}) },
      });

      res.json({ assignment });
    } catch (error) {
      next(error);
    }
  }
);

// Revoke an assignment immediately.
router.post(
  '/:assignmentId/revoke',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER', 'TENANT_ADMIN'),
  validateObjectId('assignmentId'),
  requireAssignmentOwner,
  async (req, res, next) => {
    try {
      const assignment = await ExaminerAssignment.findOne({
        _id: req.params.assignmentId,
        ...(req.tenantFilter || {}),
      });
      if (!assignment) {
        return res.status(404).json({ error: 'Examiner assignment not found' });
      }

      assignment.status = 'REVOKED';
      assignment.revokedAt = new Date();
      assignment.revokedBy = req.user._id;
      await assignment.save();

      await logAuditEvent(AUDIT_ACTIONS.EXAMINER_ASSIGNMENT_REVOKED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: assignment.tenantId || null,
        resourceType: 'ExaminerAssignment',
        resourceId: assignment._id,
        details: { examId: assignment.examId, examinerId: assignment.examinerId },
      });

      res.json({ assignment });
    } catch (error) {
      next(error);
    }
  }
);

// Admin view: list assignments in the current tenant, optionally filtered.
router.get(
  '/',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const filter = { ...req.tenantFilter };
      const isTenantMonitor = req.user.role === 'TENANT_ADMIN' || (req.user.roles || []).includes('TENANT_ADMIN');
      if (!isTenantMonitor) {
        const Exam = (await import('../models/Exam.js')).default;
        const ownedExamIds = await Exam.find({ ...req.tenantFilter, createdBy: req.user._id }).distinct('_id');
        filter.examId = req.query.examId
          ? { $in: ownedExamIds.filter((examId) => String(examId) === String(req.query.examId)) }
          : { $in: ownedExamIds };
      }
      if (req.query.examId && isTenantMonitor) filter.examId = req.query.examId;
      if (req.query.examinerId) filter.examinerId = req.query.examinerId;
      if (req.query.status) filter.status = req.query.status;

      const assignments = await ExaminerAssignment.find(filter)
        .populate('examId', 'title')
        .populate('examinerId', 'name email')
        .sort({ createdAt: -1 });

      res.json({ assignments });
    } catch (error) {
      next(error);
    }
  }
);

// Examiner's own view: active assignments granted to the current user.
router.get('/mine', requireAuth, requireEvaluatorAccess(), async (req, res, next) => {
  try {
    const now = new Date();
    const assignments = await ExaminerAssignment.find({
      examinerId: req.user._id,
      status: 'ACTIVE',
      accessStartsAt: { $lte: now },
      $or: [{ accessExpiresAt: { $exists: false } }, { accessExpiresAt: null }, { accessExpiresAt: { $gte: now } }],
    })
      .populate('examId', 'title evaluationMode')
      .sort({ createdAt: -1 });

    res.json({ assignments });
  } catch (error) {
    next(error);
  }
});

// List the attempts an examiner can review under a specific assignment.
router.get('/:assignmentId/attempts', requireAuth, requireEvaluatorAccess(), validateObjectId('assignmentId'), async (req, res, next) => {
  try {
    const assignment = await ExaminerAssignment.findOne({
      _id: req.params.assignmentId,
      examinerId: req.user._id,
    });
    if (!assignment || !isAssignmentCurrentlyActive(assignment)) {
      return res.status(404).json({ error: 'Examiner assignment not found or not active for you' });
    }

    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;

    let attemptFilter = { examId: assignment.examId, isCompleted: true };
    if (assignment.scopeType === 'ATTEMPTS') {
      attemptFilter = { examId: assignment.examId, _id: { $in: assignment.scopeData?.attemptIds || [] } };
    } else {
      const scopedQuestionIds = await getScopedQuestionIds(assignment);
      if (scopedQuestionIds !== null) {
        if (!scopedQuestionIds.length) {
          return res.json({ attempts: [] });
        }
        const scopedAttemptIds = await Answer.find({ questionId: { $in: scopedQuestionIds } })
          .distinct('attemptId');
        attemptFilter._id = { $in: scopedAttemptIds };
      }
    }

    const identityFields = assignment.canViewStudentIdentity ? 'userId' : '';
    const attempts = await ExamAttempt.find(attemptFilter)
      .select(`scoreSummary submitTime ${identityFields}`)
      .populate(assignment.canViewStudentIdentity ? { path: 'userId', select: 'name email' } : [])
      .sort({ submitTime: -1 })
      .lean();

    // "reviewable" (pending ∪ completed) distinguishes "never entered the
    // review pipeline" from "genuinely reviewed" — see deriveReviewStatus.
    const reviewCounts = await Answer.aggregate([
      {
        $match: {
          attemptId: { $in: attempts.map((a) => a._id) },
          evaluationStatus: { $in: ['PENDING_REVIEW', 'UNDER_REVIEW', 'FLAGGED', 'REVIEWED', 'FINALIZED', 'MODERATED'] },
        },
      },
      {
        $group: {
          _id: '$attemptId',
          pending: { $sum: { $cond: [{ $in: ['$evaluationStatus', ['PENDING_REVIEW', 'UNDER_REVIEW', 'FLAGGED']] }, 1, 0] } },
          reviewable: { $sum: 1 },
        },
      },
    ]);
    const reviewByAttempt = new Map(reviewCounts.map((r) => [String(r._id), r]));

    res.json({
      attempts: attempts.map((attempt) => {
        const review = reviewByAttempt.get(String(attempt._id)) || { pending: 0, reviewable: 0 };
        return {
          _id: attempt._id,
          submitTime: attempt.submitTime,
          scoreSummary: attempt.scoreSummary,
          candidate: assignment.canViewStudentIdentity ? attempt.userId : null,
          pendingReviewCount: review.pending,
          reviewStatus: deriveReviewStatus(review),
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
