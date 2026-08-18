import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { checkPracticeAnswer, getAttemptPracticeHistory, WizKidsPracticeError } from '../services/wizKidsPracticeService.js';
import { completeWizKidsObjectiveAttempt, WizKidsCompletionError } from '../services/wizKidsCompletionService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

// WizKids Phase 7 — Practice Mode.
//
// Full guard chain per master prompt §10. requireTenantFeature('WIZKIDS_PRACTICE')
// here already accounts for the WIZKIDS parent capability via the
// dependsOn-aware resolution built in Phase 1 (resolveTenantCapabilities) —
// WIZKIDS_PRACTICE can only be effectively enabled if WIZKIDS itself is.
// Only CANDIDATE may check practice answers — this is the student-facing
// attempt-taking action, not a Teacher/Tenant-Admin authoring capability.
const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('CANDIDATE'), requireTenantFeature('WIZKIDS_PRACTICE'));

const respondToPracticeError = (error, res, next) => {
  if (error instanceof WizKidsCompletionError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof WizKidsPracticeError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
};

router.post(
  '/:attemptId/questions/:questionId/check',
  validateObjectId('attemptId'),
  validateObjectId('questionId'),
  [body('answer').exists({ checkNull: true }).withMessage('answer is required.')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const result = await checkPracticeAnswer({
        tenantId: req.user.tenantId,
        userId: req.user._id,
        attemptId: req.params.attemptId,
        questionId: req.params.questionId,
        submittedAnswer: req.body.answer,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_PRACTICE_ANSWER_CHECKED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsPracticeCheck',
        resourceId: result.checkId,
        details: { attemptId: req.params.attemptId, questionId: req.params.questionId, isCorrect: result.isCorrect },
      });

      return res.json(result);
    } catch (error) {
      return respondToPracticeError(error, res, next);
    }
  }
);

router.get('/:attemptId/history', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const history = await getAttemptPracticeHistory({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
    });
    return res.json({ history });
  } catch (error) {
    return respondToPracticeError(error, res, next);
  }
});

router.post('/:attemptId/complete', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const result = await completeWizKidsObjectiveAttempt({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
      expectedMode: 'PRACTICE',
    });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_ATTEMPT_COMPLETED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'ExamAttempt',
      resourceId: req.params.attemptId,
      details: { mode: 'PRACTICE', score: result.score || null, alreadyCompleted: result.alreadyCompleted },
    });
    return res.json(result);
  } catch (error) {
    return respondToPracticeError(error, res, next);
  }
});

export default router;
