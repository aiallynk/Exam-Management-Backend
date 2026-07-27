import express from 'express';
import { body, validationResult } from 'express-validator';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import Exam from '../models/Exam.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { validateObjectId } from '../middleware/validation.js';
import { AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { FREE_PLAN_MESSAGES, isPlanFeatureEnabled } from '../config/planLimits.js';
import { resolveUserEffectivePlanType, sendPlanRestriction } from '../middleware/planRestrictions.js';
import { requireTenantFeature, resolveTenantFeature } from '../services/tenantFeatureService.js';
import {
  SCOPE_TYPES,
  EvaluatorAssignmentError,
  loadExamAndEvaluator,
  createEvaluatorAssignment,
  computeAssignmentProgress,
  getEligibleEvaluatorUserFilter,
} from '../services/evaluatorAssignmentService.js';
import {
  DISTRIBUTION_STRATEGIES,
  distributeAttemptsAcrossEvaluators,
  reassignAttempt,
  getDistributionSummary,
} from '../services/responseDistributionService.js';

const evaluatorCapabilityStatus = (evaluatorAccess) => {
  if (!evaluatorAccess?.enabled) return 'INACTIVE';
  if (evaluatorAccess.accessExpiresAt && new Date(evaluatorAccess.accessExpiresAt) < new Date()) return 'EXPIRED';
  return 'ACTIVE';
};

/**
 * Exam-scoped "Manage Evaluators" surface. Every exam — including exams
 * created before this feature existed — reaches evaluator management
 * through this route rather than a separate per-exam role system: it is a
 * thin, exam-first view over the same ExaminerAssignment/ExamParticipant
 * records the tenant-wide /api/tenant/evaluators and /api/examiner-
 * assignments routers use, via evaluatorAssignmentService.
 */
const router = express.Router();

// Tenant-wide eligible-evaluator lookup that does not require an exam to
// already exist — used by the "Assign Evaluators" step of exam creation.
// It uses the same active-EVALUATOR filter as every later assignment route,
// so a person shown before creation remains assignable after creation.
router.get(
  '/evaluators/eligible',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  async (req, res, next) => {
    try {
      const now = new Date();
      const evaluators = await User.find(getEligibleEvaluatorUserFilter({ tenantId: req.user.tenantId, now }))
        .select('name email role roles evaluatorAccess')
        .sort({ name: 1 })
        .lean();

      const ids = evaluators.map((evaluator) => evaluator._id);
      const assignments = ids.length ? await ExaminerAssignment.aggregate([
        { $match: { examinerId: { $in: ids }, status: 'ACTIVE' } },
        { $group: { _id: '$examinerId', activeExamCount: { $sum: 1 } } },
      ]) : [];
      const workloadByEvaluator = new Map(assignments.map((entry) => [String(entry._id), entry.activeExamCount]));

      res.json({
        evaluators: evaluators.map((evaluator) => ({
          _id: evaluator._id,
          name: evaluator.name,
          email: evaluator.email,
          role: evaluator.role,
          status: evaluatorCapabilityStatus(evaluator.evaluatorAccess),
          activeExamCount: workloadByEvaluator.get(String(evaluator._id)) || 0,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// List every evaluator assignment for this exam, with review-progress counts.
router.get(
  '/:examId/evaluators',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const exam = await Exam.findOne({ _id: req.params.examId, ...(req.tenantFilter || {}) })
        .select('title tenantId evaluationMode')
        .lean();
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const assignments = await ExaminerAssignment.find({ examId: exam._id })
        .populate('examinerId', 'name email')
        .populate('assignedBy', 'name email')
        .sort({ createdAt: -1 })
        .lean();

      const progressByAssignment = await computeAssignmentProgress(assignments);

      res.json({
        exam: { _id: exam._id, title: exam.title, evaluationMode: exam.evaluationMode },
        assignments: assignments.map((assignment) => ({
          ...assignment,
          progress: progressByAssignment.get(String(assignment._id)) || { pending: 0, completed: 0 },
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// List active Evaluators who could be assigned to this exam. An Exam Creator
// who can create assignments may see this list without getting tenant-wide
// evaluator administration access; the user eligibility itself is identical
// to the tenant-admin Controls list.
router.get(
  '/:examId/evaluators/eligible',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const exam = await Exam.findOne({ _id: req.params.examId, ...(req.tenantFilter || {}) }).select('_id tenantId').lean();
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const now = new Date();
      const evaluators = await User.find(getEligibleEvaluatorUserFilter({ tenantId: exam.tenantId, now }))
        .select('name email role roles evaluatorAccess')
        .sort({ name: 1 })
        .lean();

      res.json({ evaluators });
    } catch (error) {
      next(error);
    }
  }
);

// Add an evaluator to this exam — works for draft, scheduled, active, and
// already-submitted exams alike; existing answers simply become visible to
// the new assignment's scope. Published-result exams are not blocked here
// (the publication gate itself remains untouched), but reopening a
// published result is a separate, explicit workflow this endpoint does not
// perform.
router.post(
  '/:examId/evaluators',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  [
    body('examinerId').notEmpty().withMessage('examinerId is required').isMongoId(),
    body('scopeType').optional().isIn(SCOPE_TYPES),
    body('scopeData').optional().isObject(),
    body('accessStartsAt').optional().isISO8601(),
    body('accessExpiresAt').optional().isISO8601(),
    body('dueAt').optional().isISO8601(),
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

      const { examinerId } = req.body;

      const { exam } = await loadExamAndEvaluator({
        examId: req.params.examId,
        examinerId,
        tenantFilter: req.tenantFilter,
        actorRole: req.user.role,
      });

      // A tenant on a plan/feature-setting without MULTIPLE_EVALUATORS may
      // still assign its first evaluator freely; only a *second* (or later)
      // concurrently-active evaluator on the same exam requires the feature.
      const activeAssignmentCount = await ExaminerAssignment.countDocuments({ examId: exam._id, status: 'ACTIVE' });
      if (activeAssignmentCount > 0) {
        const multipleEvaluators = await resolveTenantFeature(exam.tenantId, 'MULTIPLE_EVALUATORS');
        if (!multipleEvaluators?.effectiveEnabled) {
          return res.status(403).json({
            error: 'Assigning more than one evaluator to an exam is not enabled for this tenant.',
            feature: multipleEvaluators || { featureKey: 'MULTIPLE_EVALUATORS' },
          });
        }
      }

      const existingActive = await ExaminerAssignment.findOne({
        examId: exam._id,
        examinerId,
        status: 'ACTIVE',
        scopeType: req.body.scopeType || 'FULL_EXAM',
      });
      if (existingActive) {
        return res.status(409).json({
          error: 'This evaluator already has an active assignment with the same scope on this exam. Edit or revoke the existing assignment instead of creating a duplicate — a different scope, or a different evaluator, is fine.',
          assignment: existingActive,
        });
      }

      const assignment = await createEvaluatorAssignment({
        exam,
        examinerId,
        scopeType: req.body.scopeType,
        scopeData: req.body.scopeData,
        accessStartsAt: req.body.accessStartsAt,
        accessExpiresAt: req.body.accessExpiresAt || req.body.dueAt,
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

// Distribution/workload overview: every active assignment's pending/
// completed counts, plus how many completed attempts have not yet been
// claimed by any evaluator.
router.get(
  '/:examId/evaluators/workload',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const summary = await getDistributionSummary({ examId: req.params.examId, tenantFilter: req.tenantFilter });
      res.json(summary);
    } catch (error) {
      if (error instanceof EvaluatorAssignmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);

// Split currently-unassigned completed responses across the given
// evaluators. Idempotent — safe to call again after new candidates submit;
// already-claimed attempts are never reconsidered.
router.post(
  '/:examId/evaluators/distribute',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  [
    body('evaluatorIds').isArray({ min: 1 }).withMessage('evaluatorIds must be a non-empty array'),
    body('evaluatorIds.*').isMongoId(),
    body('strategy').optional().isIn(DISTRIBUTION_STRATEGIES),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      if (!isPlanFeatureEnabled(effectivePlanType, 'examinerReview')) {
        return sendPlanRestriction(res, FREE_PLAN_MESSAGES.EXAMINER_REVIEW_LOCKED);
      }

      if (req.body.evaluatorIds.length > 1) {
        const multipleEvaluators = await resolveTenantFeature(req.tenantFilter?.tenantId || req.user.tenantId, 'MULTIPLE_EVALUATORS');
        if (!multipleEvaluators?.effectiveEnabled) {
          return res.status(403).json({
            error: 'Distributing responses across more than one evaluator is not enabled for this tenant.',
            feature: multipleEvaluators || { featureKey: 'MULTIPLE_EVALUATORS' },
          });
        }
      }

      const summary = await distributeAttemptsAcrossEvaluators({
        examId: req.params.examId,
        evaluatorIds: req.body.evaluatorIds,
        strategy: req.body.strategy,
        assignedBy: req.user._id,
        assignedByRole: req.user.role,
        tenantFilter: req.tenantFilter,
      });

      res.json(summary);
    } catch (error) {
      if (error instanceof EvaluatorAssignmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);

// Move one candidate's response from whichever evaluator currently holds it
// to a different evaluator. Never touches the underlying Answer review data.
router.post(
  '/:examId/evaluators/reassign',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  [
    body('attemptId').notEmpty().isMongoId(),
    body('toExaminerId').notEmpty().isMongoId(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const result = await reassignAttempt({
        examId: req.params.examId,
        attemptId: req.body.attemptId,
        toExaminerId: req.body.toExaminerId,
        performedBy: req.user._id,
        performedByRole: req.user.role,
        tenantFilter: req.tenantFilter,
      });

      res.json(result);
    } catch (error) {
      if (error instanceof EvaluatorAssignmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  }
);

// Opt an exam into (or out of) automatic distribution of future submissions.
// Null/omitted strategy turns automatic distribution off; existing manual
// assignment/reassignment endpoints keep working either way.
router.patch(
  '/:examId/evaluators/distribution-strategy',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenantFeature('EVALUATOR_REVIEW'),
  validateObjectId('examId'),
  [body('strategy').optional({ nullable: true }).isIn(DISTRIBUTION_STRATEGIES)],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findOne({ _id: req.params.examId, ...(req.tenantFilter || {}) });
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const previousStrategy = exam.evaluatorDistributionStrategy || null;
      exam.evaluatorDistributionStrategy = req.body.strategy || null;
      await exam.save();

      await logAuditEvent(AUDIT_ACTIONS.EVALUATOR_DISTRIBUTION_STRATEGY_CHANGED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: exam.tenantId || null,
        resourceType: 'Exam',
        resourceId: exam._id,
        details: { examId: exam._id, previousStrategy, newStrategy: exam.evaluatorDistributionStrategy },
      });

      res.json({ examId: exam._id, evaluatorDistributionStrategy: exam.evaluatorDistributionStrategy });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
