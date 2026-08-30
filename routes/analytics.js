import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { FREE_PLAN_MESSAGES, isPlanFeatureEnabled } from '../config/planLimits.js';
import { blockFreePlanByExamId, blockFreePlanByUser, resolveUserEffectivePlanType } from '../middleware/planRestrictions.js';
import {
  getSectionDifficultyAnalysis,
  getQuestionSuccessRatio,
  getSectionDropoffAnalysis,
  getTimeAccuracyData,
  getExamAnalytics,
  getTenantAnalyticsDashboard,
} from '../services/analyticsService.js';

const router = express.Router();

const parseDateBoundary = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// Tenant-wide dashboard analytics, scoped by viewer role inside
// getTenantAnalyticsDashboard (EXAM_CREATOR sees only their own exams —
// examFilter.createdBy = viewerUserId — never the whole tenant). This is
// the correctly-owned home for it: /tenant-admin/analytics stays behind
// that router's blanket TENANT_ADMIN-only gate for the Tenant Admin's own
// dashboard, and this route (already EXAM_CREATOR/TENANT_ADMIN-gated,
// matching every other route in this file) is what /dashboard/analytics
// (the Exam Creator workspace) calls instead — Part Q: a creator-facing
// feature must not depend on a Tenant-Admin-only endpoint. Reuses the
// exact same service function both routes already shared.
router.get(
  '/dashboard',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  blockFreePlanByUser(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED, 'analytics'),
  async (req, res, next) => {
    try {
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      const includeAdvancedAnalytics = isPlanFeatureEnabled(effectivePlanType, 'advancedAnalytics');
      const requestedExamId = req.query.examId || req.query.specificExamId || null;
      const startDate = parseDateBoundary(req.query.startDate);
      const endDate = parseDateBoundary(req.query.endDate);

      const analytics = await getTenantAnalyticsDashboard({
        tenantId: req.user.tenantId,
        viewerRole: req.user.role,
        viewerUserId: req.user._id,
        examId: requestedExamId,
        startDate,
        endDate,
        includeAdvanced: includeAdvancedAnalytics,
      });

      res.json({
        ...analytics,
        planContext: { planType: effectivePlanType, advancedAnalytics: includeAdvancedAnalytics },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get comprehensive exam analytics
router.get(
  '/exam/:examId',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  blockFreePlanByExamId(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED),
  async (req, res, next) => {
  try {
    const analytics = await getExamAnalytics(req.params.examId);
    res.json({ analytics });
  } catch (error) {
    next(error);
  }
  }
);

// Get section difficulty analysis
router.get(
  '/exam/:examId/sections/difficulty',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  blockFreePlanByExamId(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED),
  async (req, res, next) => {
  try {
    const analysis = await getSectionDifficultyAnalysis(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json({ analysis });
  } catch (error) {
    next(error);
  }
  }
);

// Get question success ratio
router.get(
  '/exam/:examId/questions/success',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  blockFreePlanByExamId(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED),
  async (req, res, next) => {
  try {
    const stats = await getQuestionSuccessRatio(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json({ stats });
  } catch (error) {
    next(error);
  }
  }
);

// Get section drop-off analysis
router.get(
  '/exam/:examId/sections/dropoff',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  blockFreePlanByExamId(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED),
  async (req, res, next) => {
  try {
    const analysis = await getSectionDropoffAnalysis(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json({ analysis });
  } catch (error) {
    next(error);
  }
  }
);

// Get time vs accuracy data
router.get(
  '/exam/:examId/time-accuracy',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  blockFreePlanByExamId(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED),
  async (req, res, next) => {
  try {
    const data = await getTimeAccuracyData(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
  }
);

export default router;
