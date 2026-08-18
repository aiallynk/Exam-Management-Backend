import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import {
  advanceSpeedAttempt,
  getSpeedAttemptState,
  navigateSpeedAttempt,
  startSpeedAttempt,
  submitSpeedAnswer,
  WizKidsSpeedError,
} from '../services/wizKidsSpeedService.js';
import { completeWizKidsObjectiveAttempt, WizKidsCompletionError } from '../services/wizKidsCompletionService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

// WizKids Phase 8 — Speed Mode.
//
// The feature middleware protects every Speed endpoint before the service
// looks up an attempt.  The service then independently proves the particular
// attempt belongs to a SPEED-mode WizKids exam, which prevents a standard
// attempt from acquiring timer/navigation state through a direct URL.
const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('CANDIDATE'), requireTenantFeature('WIZKIDS_SPEED_MODE'));

const respondToSpeedError = (error, res, next) => {
  if (error instanceof WizKidsCompletionError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof WizKidsSpeedError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
};

router.post('/:attemptId/speed/start', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const payload = await startSpeedAttempt({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
    });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_SPEED_STARTED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'WizKidsAttemptState',
      resourceId: payload.state.attemptId,
      details: { examId: payload.state.examId, autoAdvance: payload.state.autoAdvance },
    });
    return res.status(201).json(payload);
  } catch (error) {
    return respondToSpeedError(error, res, next);
  }
});

router.get('/:attemptId/speed', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const payload = await getSpeedAttemptState({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
    });
    return res.json(payload);
  } catch (error) {
    return respondToSpeedError(error, res, next);
  }
});

router.post(
  '/:attemptId/speed/answer',
  validateObjectId('attemptId'),
  [body('questionId').isMongoId(), body('answer').exists({ checkNull: true })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const payload = await submitSpeedAnswer({
        tenantId: req.user.tenantId,
        userId: req.user._id,
        attemptId: req.params.attemptId,
        questionId: req.body.questionId,
        submittedAnswer: req.body.answer,
      });
      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_SPEED_ANSWER_RECORDED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'Answer',
        resourceId: req.body.questionId,
        details: {
          attemptId: req.params.attemptId,
          questionId: req.body.questionId,
          timeSpent: payload.answer.timeSpent,
        },
      });
      return res.json(payload);
    } catch (error) {
      return respondToSpeedError(error, res, next);
    }
  }
);

router.post('/:attemptId/speed/complete', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const result = await completeWizKidsObjectiveAttempt({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
      expectedMode: 'SPEED',
    });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_ATTEMPT_COMPLETED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'ExamAttempt',
      resourceId: req.params.attemptId,
      details: { mode: 'SPEED', score: result.score || null, alreadyCompleted: result.alreadyCompleted },
    });
    return res.json(result);
  } catch (error) {
    return respondToSpeedError(error, res, next);
  }
});

router.post('/:attemptId/speed/advance', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const payload = await advanceSpeedAttempt({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
    });
    return res.json(payload);
  } catch (error) {
    return respondToSpeedError(error, res, next);
  }
});

router.post(
  '/:attemptId/speed/navigate',
  validateObjectId('attemptId'),
  [body('questionId').isMongoId()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const payload = await navigateSpeedAttempt({
        tenantId: req.user.tenantId,
        userId: req.user._id,
        attemptId: req.params.attemptId,
        questionId: req.body.questionId,
      });
      return res.json(payload);
    } catch (error) {
      return respondToSpeedError(error, res, next);
    }
  }
);

export default router;
