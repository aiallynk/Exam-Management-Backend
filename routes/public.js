import express from 'express';
import { getSubscriptionPlanCatalog } from '../utils/subscriptionPlanCatalog.js';

const router = express.Router();

/**
 * PUBLIC PLAN CATALOG
 * GET /api/public/plans
 */
router.get('/plans', async (_req, res, next) => {
  try {
    const plans = getSubscriptionPlanCatalog().map((plan) => ({
      id: plan.id,
      label: plan.label,
      price: plan.price,
      limits: plan.limits,
      features: plan.features,
    }));

    return res.json({ plans });
  } catch (error) {
    return next(error);
  }
});

export default router;

