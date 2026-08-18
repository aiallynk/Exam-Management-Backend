import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { resolveTenantCapabilities } from '../services/tenantFeatureService.js';

// WizKids Phase 2 — Module Shell.
//
// This router intentionally exposes only a single, read-only, self-scoped
// entitlement-status endpoint. It has no role restriction beyond "authenticated
// tenant user" because every persona (TENANT_ADMIN, EXAM_CREATOR, CANDIDATE,
// EVALUATOR) needs to know whether WizKids is visible to them in order to
// decide whether to render a WizKids navigation entry — this is display logic,
// not an authorization boundary, so it must not be confused with the real
// server-side enforcement gate. Every future WizKids business endpoint (question
// bank, practice, batches, etc.) must additionally apply requireTenantFeature(...)
// from services/tenantFeatureService.js, per the master prompt §10 guard chain.
const router = express.Router();
router.use(requireAuth, requireTenant);

router.get('/entitlement', async (req, res, next) => {
  try {
    // SUPER_ADMIN may have no tenant context (requireTenant does not assign one
    // for platform admins) — treat that as "not applicable", not an error.
    if (!req.user?.tenantId) {
      return res.json({ effectiveEnabled: false, capabilities: {} });
    }

    const capabilities = await resolveTenantCapabilities(req.user.tenantId);
    const wizKidsCapabilities = capabilities.filter((capability) => capability.group === 'WizKids');
    const parent = wizKidsCapabilities.find((capability) => capability.featureKey === 'WIZKIDS');

    const capabilitiesByKey = wizKidsCapabilities.reduce((accumulator, capability) => {
      accumulator[capability.featureKey] = {
        effectiveEnabled: capability.effectiveEnabled === true,
        effectiveState: capability.effectiveState,
      };
      return accumulator;
    }, {});

    return res.json({
      effectiveEnabled: parent?.effectiveEnabled === true,
      capabilities: capabilitiesByKey,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
