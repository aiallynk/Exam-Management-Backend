import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import SystemAlert from '../models/SystemAlert.js';
import {
  buildSystemAlertQuery,
  getSystemAlertSummary,
  mapSystemAlert,
  markAllSystemAlertsAsRead,
  markSystemAlertAsRead,
  resolveSystemAlert,
} from '../services/systemAlertService.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

const toSafePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

router.get('/summary', async (_req, res, next) => {
  try {
    const summary = await getSystemAlertSummary({});
    res.json({ summary });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const query = buildSystemAlertQuery({
      severity: req.query?.severity,
      category: req.query?.category,
      status: req.query?.status,
      search: req.query?.search || req.query?.q,
      startDate: req.query?.startDate,
      endDate: req.query?.endDate,
    });
    const page = toSafePositiveInt(req.query?.page, 1);
    const limit = Math.min(toSafePositiveInt(req.query?.limit, 25), 100);
    const skip = (page - 1) * limit;

    const [items, total, filteredSummary, globalSummary] = await Promise.all([
      SystemAlert.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
      SystemAlert.countDocuments(query),
      getSystemAlertSummary(query),
      getSystemAlertSummary({}),
    ]);

    res.json({
      alerts: (Array.isArray(items) ? items : []).map((alert) => mapSystemAlert(alert)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      summary: filteredSummary,
      globalSummary,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/:alertId/read', async (req, res, next) => {
  try {
    const { alertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(alertId || ''))) {
      return res.status(400).json({ error: 'Invalid alertId' });
    }

    const alert = await markSystemAlertAsRead(alertId);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ alert: mapSystemAlert(alert) });
  } catch (error) {
    next(error);
  }
});

router.post('/read-all', async (_req, res, next) => {
  try {
    const result = await markAllSystemAlertsAsRead({});
    res.json({
      success: true,
      modifiedCount: Number(result?.modifiedCount || 0),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/:alertId/resolve', async (req, res, next) => {
  try {
    const { alertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(alertId || ''))) {
      return res.status(400).json({ error: 'Invalid alertId' });
    }

    const alert = await resolveSystemAlert(alertId);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ alert: mapSystemAlert(alert) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:alertId/dismiss', async (req, res, next) => {
  try {
    const { alertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(alertId || ''))) {
      return res.status(400).json({ error: 'Invalid alertId' });
    }

    const alert = await resolveSystemAlert(alertId);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ alert: mapSystemAlert(alert) });
  } catch (error) {
    next(error);
  }
});

export default router;
