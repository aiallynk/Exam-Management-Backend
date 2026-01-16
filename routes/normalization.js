import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import {
  getNormalizationConfig,
  getTenantNormalizationConfig,
  updateNormalizationConfig,
  updateTenantNormalizationConfig,
  lockNormalizationConfig,
  lockTenantNormalizationConfig,
  calculateNormalizedScore,
  recalculateExamNormalization,
  recalculateTenantNormalization,
  getNormalizationStats,
  getTenantNormalizationStats,
} from '../services/normalizationService.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';

const router = express.Router();

// Get normalization config for exam
router.get('/exam/:examId', requireAuth, async (req, res, next) => {
  try {
    const config = await getNormalizationConfig(req.params.examId);
    res.json({ config });
  } catch (error) {
    next(error);
  }
});

// Update normalization config
router.put(
  '/exam/:examId',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  [
    body('formulaType').optional().isIn(['LINEAR', 'Z_SCORE', 'PERCENTILE_RANK', 'CUSTOM']),
    body('shiftBased').optional().isBoolean(),
    body('sessionBased').optional().isBoolean(),
  ],
  auditLog(AUDIT_ACTIONS.NORMALIZATION_CONFIGURED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const config = await updateNormalizationConfig(
        req.params.examId,
        req.body,
        req.user._id
      );
      res.json({ config });
    } catch (error) {
      next(error);
    }
  }
);

// Lock normalization config
router.post(
  '/exam/:examId/lock',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.NORMALIZATION_LOCKED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const config = await lockNormalizationConfig(req.params.examId, req.user._id);
      res.json({ config });
    } catch (error) {
      next(error);
    }
  }
);

// Calculate normalized score for attempt
router.post(
  '/attempt/:attemptId/calculate',
  requireAuth,
  async (req, res, next) => {
    try {
      const config = await getNormalizationConfig(req.body.examId || req.query.examId);
      const result = await calculateNormalizedScore(req.params.attemptId, config);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Recalculate normalization for all attempts in exam
router.post(
  '/exam/:examId/recalculate',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.NORMALIZATION_RECALCULATED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const result = await recalculateExamNormalization(req.params.examId, req.user._id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Get normalization statistics
router.get('/exam/:examId/stats', requireAuth, async (req, res, next) => {
  try {
    const stats = await getNormalizationStats(req.params.examId);
    res.json({ stats });
  } catch (error) {
    next(error);
  }
});

// ========== TENANT-LEVEL NORMALIZATION ROUTES (TENANT_ADMIN ONLY) ==========

// Get tenant normalization config
router.get('/tenant', requireAuth, requireRole('TENANT_ADMIN'), requireTenant, async (req, res, next) => {
  try {
    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'Tenant admin must be assigned to a tenant' });
    }
    const config = await getTenantNormalizationConfig(req.user.tenantId);
    res.json({ config });
  } catch (error) {
    next(error);
  }
});

// Update tenant normalization config
router.put(
  '/tenant',
  requireAuth,
  requireRole('TENANT_ADMIN'),
  requireTenant,
  [
    body('formulaType').optional().isIn(['LINEAR', 'Z_SCORE', 'PERCENTILE_RANK', 'CUSTOM']),
    body('shiftBased').optional().isBoolean(),
  ],
  auditLog(AUDIT_ACTIONS.NORMALIZATION_CONFIGURED, (req) => ({
    resourceType: 'Tenant',
    resourceId: req.user.tenantId,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      if (!req.user.tenantId) {
        return res.status(403).json({ error: 'Tenant admin must be assigned to a tenant' });
      }

      const config = await updateTenantNormalizationConfig(
        req.user.tenantId,
        req.body,
        req.user._id
      );
      res.json({ config });
    } catch (error) {
      next(error);
    }
  }
);

// Lock tenant normalization config
router.post(
  '/tenant/lock',
  requireAuth,
  requireRole('TENANT_ADMIN'),
  requireTenant,
  auditLog(AUDIT_ACTIONS.NORMALIZATION_LOCKED, (req) => ({
    resourceType: 'Tenant',
    resourceId: req.user.tenantId,
  })),
  async (req, res, next) => {
    try {
      if (!req.user.tenantId) {
        return res.status(403).json({ error: 'Tenant admin must be assigned to a tenant' });
      }
      const config = await lockTenantNormalizationConfig(req.user.tenantId, req.user._id);
      res.json({ config });
    } catch (error) {
      next(error);
    }
  }
);

// Recalculate normalization for all attempts in tenant
router.post(
  '/tenant/recalculate',
  requireAuth,
  requireRole('TENANT_ADMIN'),
  requireTenant,
  auditLog(AUDIT_ACTIONS.NORMALIZATION_RECALCULATED, (req) => ({
    resourceType: 'Tenant',
    resourceId: req.user.tenantId,
  })),
  async (req, res, next) => {
    try {
      if (!req.user.tenantId) {
        return res.status(403).json({ error: 'Tenant admin must be assigned to a tenant' });
      }
      const result = await recalculateTenantNormalization(req.user.tenantId, req.user._id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Get tenant normalization statistics
router.get('/tenant/stats', requireAuth, requireRole('TENANT_ADMIN'), requireTenant, async (req, res, next) => {
  try {
    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'Tenant admin must be assigned to a tenant' });
    }
    const stats = await getTenantNormalizationStats(req.user.tenantId);
    res.json({ stats });
  } catch (error) {
    next(error);
  }
});

export default router;
