import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { refreshCandidateGamification } from '../services/wizKidsGamificationService.js';

const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('CANDIDATE'), requireTenantFeature('WIZKIDS'));

router.get('/me', async (req, res, next) => {
  try {
    return res.json(await refreshCandidateGamification({ tenantId: req.user.tenantId, candidateId: req.user._id }));
  } catch (error) { return next(error); }
});

export default router;
