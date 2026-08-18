import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { getAdaptiveRecommendations, getBatchAnalytics, getCandidateAnalytics, rebuildCandidateSkillProfile } from '../services/wizKidsAnalyticsService.js';
import { refreshCandidateGamification } from '../services/wizKidsGamificationService.js';

const router = express.Router();
router.use(requireAuth, requireTenant, requireTenantFeature('WIZKIDS'));

router.get('/me', requireRole('CANDIDATE'), async (req, res, next) => {
  try {
    const analytics = await getCandidateAnalytics({ tenantId: req.user.tenantId, candidateId: req.user._id });
    return res.json(analytics);
  } catch (error) { return next(error); }
});

router.post('/me/refresh', requireRole('CANDIDATE'), async (req, res, next) => {
  try {
    const profiles = await rebuildCandidateSkillProfile({ tenantId: req.user.tenantId, candidateId: req.user._id });
    const gamification = await refreshCandidateGamification({ tenantId: req.user.tenantId, candidateId: req.user._id });
    return res.json({ profiles, gamification });
  } catch (error) { return next(error); }
});

router.get('/me/recommendations', requireRole('CANDIDATE'), async (req, res, next) => {
  try {
    const gradeLevel = Number(req.query.gradeLevel);
    if (!Number.isInteger(gradeLevel) || gradeLevel < 1 || gradeLevel > 7) return res.status(400).json({ error: 'gradeLevel must be between 1 and 7.' });
    const recommendations = await getAdaptiveRecommendations({ tenantId: req.user.tenantId, candidateId: req.user._id, gradeLevel, limit: req.query.limit });
    return res.json(recommendations);
  } catch (error) { return next(error); }
});

router.get('/candidates/:candidateId', requireRole('TENANT_ADMIN', 'EXAM_CREATOR'), validateObjectId('candidateId'), async (req, res, next) => {
  try {
    return res.json(await getCandidateAnalytics({ tenantId: req.user.tenantId, candidateId: req.params.candidateId }));
  } catch (error) { return next(error); }
});

router.post('/candidates/:candidateId/rebuild', requireRole('TENANT_ADMIN', 'EXAM_CREATOR'), validateObjectId('candidateId'), async (req, res, next) => {
  try {
    const profiles = await rebuildCandidateSkillProfile({ tenantId: req.user.tenantId, candidateId: req.params.candidateId });
    return res.json({ profiles });
  } catch (error) { return next(error); }
});

router.get('/batches/:batchId', requireRole('TENANT_ADMIN', 'EXAM_CREATOR'), validateObjectId('batchId'), async (req, res, next) => {
  try {
    return res.json(await getBatchAnalytics({ tenantId: req.user.tenantId, batchId: req.params.batchId }));
  } catch (error) { return next(error); }
});

export default router;
