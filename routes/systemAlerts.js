import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import SystemAlert from '../models/SystemAlert.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import {
  buildSystemAlertQuery,
  getSystemAlertSummary,
  mapSystemAlert,
  markAllSystemAlertsAsRead,
  markSystemAlertAsRead,
  resolveSystemAlert,
} from '../services/systemAlertService.js';
import {
  formatAlertUserLabel,
  resolveAlertUserEmail,
  resolveAlertUserName,
} from '../utils/alertActorLabel.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

const toSafePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const toNonEmptyString = (value) => {
  const normalized = String(value ?? '').trim();
  return normalized || '';
};

const toSafeObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const toObjectIdString = (value) => {
  const candidate = toNonEmptyString(value?._id || value);
  if (!candidate || !mongoose.Types.ObjectId.isValid(candidate)) return '';
  return candidate;
};

const resolveMetadataUserId = (metadata = {}) =>
  toObjectIdString(
    metadata.actor_user_id ||
      metadata.user_id ||
      metadata.userId ||
      metadata.user?._id ||
      metadata.user?.id
  );

const resolveMetadataTenantId = (metadata = {}) =>
  toObjectIdString(
    metadata.tenant_id ||
      metadata.tenantId ||
      metadata.tenant?._id ||
      metadata.tenant?.id
  );

const resolveActorLabel = (alert, userLookup = new Map(), tenantLookup = new Map()) => {
  const metadata = toSafeObject(alert?.metadata);
  const actorUserId = resolveMetadataUserId(metadata);
  const actorTenantId = resolveMetadataTenantId(metadata);

  if (actorUserId) {
    const actor = userLookup.get(actorUserId);
    const actorLabel = formatAlertUserLabel({
      name: toNonEmptyString(actor?.name) || resolveAlertUserName(metadata),
      email: toNonEmptyString(actor?.email) || resolveAlertUserEmail(metadata),
    });
    if (actorLabel) return actorLabel;
  }

  if (actorTenantId) {
    const tenant = tenantLookup.get(actorTenantId);
    if (toNonEmptyString(tenant?.name)) return toNonEmptyString(tenant.name);

    const metadataTenantName = toNonEmptyString(
      metadata.tenant_name || metadata.tenantName || metadata.tenant?.name
    );
    if (metadataTenantName) return metadataTenantName;
  }

  const actorRole = toNonEmptyString(metadata.actor_role || metadata.userRole || metadata.role).toUpperCase();
  if (actorRole === 'SUPER_ADMIN') return 'Super Admin';

  return 'System';
};

const formatDisplayMessage = (message, actorLabel) => {
  const baseMessage = toNonEmptyString(message);
  if (!baseMessage) return '';
  if (!toNonEmptyString(actorLabel) || actorLabel === 'System') return baseMessage;

  return baseMessage
    .replace(/\bby\s+"?System"?\b/i, `by "${actorLabel}"`)
    .replace(/\bby\s+Unknown User\b/i, `by "${actorLabel}"`)
    .replace(/\bby\s+User\s+[^\s."]+/i, `by "${actorLabel}"`);
};

const enrichAlertsWithActor = async (alerts = []) => {
  const rows = Array.isArray(alerts) ? alerts : [];
  if (!rows.length) return [];

  const userIds = new Set();
  const tenantIds = new Set();

  rows.forEach((alert) => {
    const metadata = toSafeObject(alert?.metadata);
    const actorUserId = resolveMetadataUserId(metadata);
    const actorTenantId = resolveMetadataTenantId(metadata);
    if (actorUserId) userIds.add(actorUserId);
    if (actorTenantId) tenantIds.add(actorTenantId);
  });

  const [users, tenants] = await Promise.all([
    userIds.size > 0
      ? User.find({ _id: { $in: Array.from(userIds) } }).select('_id name email').lean()
      : Promise.resolve([]),
    tenantIds.size > 0
      ? Tenant.find({ _id: { $in: Array.from(tenantIds) } }).select('_id name').lean()
      : Promise.resolve([]),
  ]);

  const userLookup = new Map(
    (Array.isArray(users) ? users : []).map((user) => [
      String(user._id),
      { name: toNonEmptyString(user.name), email: toNonEmptyString(user.email) },
    ])
  );

  const tenantLookup = new Map(
    (Array.isArray(tenants) ? tenants : []).map((tenant) => [
      String(tenant._id),
      { name: toNonEmptyString(tenant.name) },
    ])
  );

  return rows.map((alert) => {
    const actorLabel = resolveActorLabel(alert, userLookup, tenantLookup);
    return {
      ...alert,
      actor_label: actorLabel,
      display_message: formatDisplayMessage(alert?.message, actorLabel),
    };
  });
};

const enrichSingleAlertWithActor = async (alert) => {
  if (!alert) return alert;
  const [row] = await enrichAlertsWithActor([alert]);
  return row || alert;
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

    const mappedAlerts = (Array.isArray(items) ? items : []).map((alert) => mapSystemAlert(alert));
    const enrichedAlerts = await enrichAlertsWithActor(mappedAlerts);

    res.json({
      alerts: enrichedAlerts,
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

    const mappedAlert = mapSystemAlert(alert);
    const enrichedAlert = await enrichSingleAlertWithActor(mappedAlert);
    res.json({ alert: enrichedAlert });
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

    const mappedAlert = mapSystemAlert(alert);
    const enrichedAlert = await enrichSingleAlertWithActor(mappedAlert);
    res.json({ alert: enrichedAlert });
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

    const mappedAlert = mapSystemAlert(alert);
    const enrichedAlert = await enrichSingleAlertWithActor(mappedAlert);
    res.json({ alert: enrichedAlert });
  } catch (error) {
    next(error);
  }
});

export default router;
