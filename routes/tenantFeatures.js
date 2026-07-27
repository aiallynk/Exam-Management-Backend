import express from 'express';
import mongoose from 'mongoose';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import TenantFeatureSetting from '../models/TenantFeatureSetting.js';
import Exam from '../models/Exam.js';
import {
  buildTenantControlsOverview,
  canTenantUpdateFeature,
  resolveTenantCapabilities,
  resolveTenantFeature,
  TENANT_CAPABILITIES,
} from '../services/tenantFeatureService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

const router = express.Router();
router.use(requireAuth, requireRole('TENANT_ADMIN'));
router.use((req, res, next) => {
  if (!mongoose.isValidObjectId(req.user?.tenantId)) {
    return res.status(403).json({ error: 'Tenant-scoped administrator access is required.' });
  }
  return next();
});

router.get('/', async (req, res, next) => {
  try {
    const features = await resolveTenantCapabilities(req.user.tenantId);
    return res.json({ features, defaultRule: 'Missing tenant settings inherit current plan entitlement.' });
  } catch (error) { return next(error); }
});

router.get('/overview', async (req, res, next) => {
  try {
    const categories = await buildTenantControlsOverview(req.user.tenantId);
    return res.json({ categories });
  } catch (error) { return next(error); }
});

router.patch('/:featureKey', [body('requestedEnabled').isBoolean()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const featureKey = String(req.params.featureKey || '').toUpperCase();
    if (!TENANT_CAPABILITIES[featureKey]) return res.status(404).json({ error: 'Unknown feature capability.' });
    const before = await resolveTenantFeature(req.user.tenantId, featureKey);
    const authorization = canTenantUpdateFeature(before, req.body.requestedEnabled);
    if (!authorization.allowed) {
      return res.status(403).json({ error: authorization.error, feature: before });
    }
    const activeExamCount = await Exam.countDocuments({ tenantId: req.user.tenantId, isActive: true });
    const setting = await TenantFeatureSetting.findOneAndUpdate(
      { tenantId: req.user.tenantId, featureKey },
      { $set: { requestedEnabled: req.body.requestedEnabled, planEntitled: before?.planEntitled === true, configuredBy: req.user._id, configuredAt: new Date() }, $inc: { version: 1 }, $setOnInsert: { tenantId: req.user.tenantId, featureKey, effectiveEnabled: false } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const after = await resolveTenantFeature(req.user.tenantId, featureKey);
    setting.effectiveEnabled = after?.effectiveEnabled === true;
    setting.disabledReason = after?.disabledReason || '';
    await setting.save();
    await logAuditEvent(req.body.requestedEnabled ? AUDIT_ACTIONS.TENANT_FEATURE_ENABLED : AUDIT_ACTIONS.TENANT_FEATURE_DISABLED, {
      userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId, resourceType: 'TenantFeatureSetting', resourceId: setting._id,
      details: { featureKey, previous: before, current: after, grandfathering: activeExamCount ? 'Existing exams and records are preserved; new use is blocked.' : null },
    });
    return res.json({ feature: after, impactWarning: activeExamCount ? 'Existing active exams are grandfathered. This change prevents new feature use only.' : null });
  } catch (error) { return next(error); }
});

export default router;
