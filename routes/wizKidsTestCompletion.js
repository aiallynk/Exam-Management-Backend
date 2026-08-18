import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { completeWizKidsObjectiveAttempt, WizKidsCompletionError } from '../services/wizKidsCompletionService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

// Normal WizKids Tests deliberately use this deterministic completion path,
// rather than the general semantic submission handler, for the same no-AI
// arithmetic guarantee as Practice and Speed.
const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('CANDIDATE'), requireTenantFeature('WIZKIDS'));

router.post('/:attemptId/test/complete', validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const result = await completeWizKidsObjectiveAttempt({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      attemptId: req.params.attemptId,
      expectedMode: ['TEST', 'WORKSHEET', 'COMPETITION', 'OLYMPIAD'],
    });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_ATTEMPT_COMPLETED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'ExamAttempt',
      resourceId: req.params.attemptId,
      details: { mode: result.attempt?.submitMeta?.submissionSource || 'wizkids_test', score: result.score || null, alreadyCompleted: result.alreadyCompleted },
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof WizKidsCompletionError) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

export default router;
