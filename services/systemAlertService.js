import crypto from 'node:crypto';
import mongoose from 'mongoose';
import SystemAlert, {
  SYSTEM_ALERT_CATEGORIES,
  SYSTEM_ALERT_SEVERITIES,
} from '../models/SystemAlert.js';
import AITokenUsage from '../models/AITokenUsage.js';
import Tenant from '../models/Tenant.js';
import {
  SUBSCRIPTION_PLAN_TYPES,
  getSubscriptionPlanDefinition,
  resolveEffectivePlanType,
  resolveSubscriptionPlanType,
  resolveSubscriptionStatus,
} from '../config/planLimits.js';
import { getCurrentMonthRange } from '../utils/planUsage.js';
import {
  buildAlertUserLabel,
  resolveAlertUserEmail,
  resolveAlertUserName,
} from '../utils/alertActorLabel.js';

const VALID_SEVERITIES = new Set(SYSTEM_ALERT_SEVERITIES);
const VALID_CATEGORIES = new Set(SYSTEM_ALERT_CATEGORIES);
const AI_RULE_EVALUATION_COOLDOWN_MS = 60 * 1000;
const MIN_SPIKE_TOKENS = 10000;
const AI_WARNING_THRESHOLD_PERCENT = 80;
const AI_CRITICAL_THRESHOLD_PERCENT = 100;
const aiRuleEvaluationCache = new Map();

const toTrimmedString = (value, fallback = '') =>
  String(value ?? fallback)
    .trim();

const toSafeObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const toNumberOrZero = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const toPositiveIntOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const normalizeSeverity = (value) => {
  const normalized = toTrimmedString(value, 'info').toLowerCase();
  if (normalized === 'high') return 'critical';
  if (normalized === 'medium') return 'warning';
  return VALID_SEVERITIES.has(normalized) ? normalized : 'info';
};

const normalizeCategory = (value) => {
  const normalized = toTrimmedString(value, 'system').toLowerCase();
  return VALID_CATEGORIES.has(normalized) ? normalized : 'system';
};

const normalizeEntityId = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (typeof value === 'object' && value !== null && value._id) return String(value._id);
  return toTrimmedString(value);
};

const normalizeEntityType = (value) => {
  if (!value) return '';
  return toTrimmedString(value).slice(0, 120);
};

const createDedupeKey = ({
  explicitDedupeKey = '',
  title = '',
  message = '',
  severity = 'info',
  category = 'system',
  entityType = '',
  entityId = '',
}) => {
  const provided = toTrimmedString(explicitDedupeKey);
  if (provided) {
    return `manual:${provided}`.slice(0, 200);
  }

  const raw = JSON.stringify({
    title: toTrimmedString(title).toLowerCase(),
    message: toTrimmedString(message).toLowerCase(),
    severity: normalizeSeverity(severity),
    category: normalizeCategory(category),
    entityType: normalizeEntityType(entityType).toLowerCase(),
    entityId: normalizeEntityId(entityId).toLowerCase(),
  });
  return crypto.createHash('sha1').update(raw).digest('hex');
};

const mergeMetadata = (existingMetadata, incomingMetadata, now) => {
  const existing = toSafeObject(existingMetadata);
  const incoming = toSafeObject(incomingMetadata);
  return {
    ...existing,
    ...incoming,
    last_occurrence_at: now.toISOString(),
  };
};

export const mapSystemAlert = (alert) => {
  const doc = alert?.toObject ? alert.toObject() : alert;
  const isRead = Boolean(doc?.is_read);
  const isResolved = Boolean(doc?.is_resolved);
  const status = isResolved ? 'resolved' : isRead ? 'read' : 'unread';

  return {
    id: doc?._id ? String(doc._id) : null,
    title: doc?.title || '',
    message: doc?.message || '',
    severity: normalizeSeverity(doc?.severity),
    category: normalizeCategory(doc?.category),
    entity_type: doc?.entity_type || '',
    entity_id: doc?.entity_id || '',
    metadata: toSafeObject(doc?.metadata),
    is_read: isRead,
    is_resolved: isResolved,
    status,
    occurrence_count: Number(doc?.occurrence_count) || 1,
    created_at: doc?.created_at || doc?.createdAt || null,
    updated_at: doc?.updated_at || doc?.updatedAt || null,
    last_occurred_at: doc?.last_occurred_at || null,
  };
};

export const createSystemAlert = async ({
  title,
  message,
  severity = 'info',
  category = 'system',
  entityType = '',
  entityId = '',
  metadata = {},
  dedupeKey = '',
  cooldownSeconds = 300,
}) => {
  try {
    const normalizedTitle = toTrimmedString(title).slice(0, 200);
    const normalizedMessage = toTrimmedString(message).slice(0, 2000);
    if (!normalizedTitle || !normalizedMessage) {
      return null;
    }

    const normalizedSeverity = normalizeSeverity(severity);
    const normalizedCategory = normalizeCategory(category);
    const normalizedEntityType = normalizeEntityType(entityType);
    const normalizedEntityId = normalizeEntityId(entityId);
    const normalizedCooldownSeconds = Math.max(0, Math.floor(Number(cooldownSeconds) || 0));
    const now = new Date();
    const normalizedDedupeKey = createDedupeKey({
      explicitDedupeKey: dedupeKey,
      title: normalizedTitle,
      message: normalizedMessage,
      severity: normalizedSeverity,
      category: normalizedCategory,
      entityType: normalizedEntityType,
      entityId: normalizedEntityId,
    });

    if (normalizedCooldownSeconds > 0) {
      const cooldownStart = new Date(now.getTime() - normalizedCooldownSeconds * 1000);
      const existing = await SystemAlert.findOne({
        dedupe_key: normalizedDedupeKey,
        is_resolved: false,
        created_at: { $gte: cooldownStart },
      });

      if (existing) {
        existing.occurrence_count = Math.max(1, Number(existing.occurrence_count || 1) + 1);
        existing.last_occurred_at = now;
        existing.metadata = mergeMetadata(existing.metadata, metadata, now);
        // If the issue repeats after being read, surface it again.
        existing.is_read = false;
        await existing.save();
        return existing;
      }
    }

    return await SystemAlert.create({
      title: normalizedTitle,
      message: normalizedMessage,
      severity: normalizedSeverity,
      category: normalizedCategory,
      entity_type: normalizedEntityType,
      entity_id: normalizedEntityId,
      metadata: mergeMetadata({}, metadata, now),
      is_read: false,
      is_resolved: false,
      dedupe_key: normalizedDedupeKey,
      occurrence_count: 1,
      last_occurred_at: now,
    });
  } catch (error) {
    console.error('[SYSTEM ALERT] Failed to create alert:', error?.message || error);
    return null;
  }
};

export const buildSystemAlertQuery = ({
  severity,
  category,
  status,
  search,
  startDate,
  endDate,
}) => {
  const query = {};
  const normalizedSeverity = toTrimmedString(severity).toLowerCase();
  const normalizedCategory = toTrimmedString(category).toLowerCase();
  const normalizedStatus = toTrimmedString(status).toLowerCase();
  const normalizedSearch = toTrimmedString(search);

  if (VALID_SEVERITIES.has(normalizedSeverity)) {
    query.severity = normalizedSeverity;
  }
  if (VALID_CATEGORIES.has(normalizedCategory)) {
    query.category = normalizedCategory;
  }

  if (normalizedStatus === 'unread') {
    query.is_read = false;
    query.is_resolved = false;
  } else if (normalizedStatus === 'read') {
    query.is_read = true;
    query.is_resolved = false;
  } else if (normalizedStatus === 'resolved') {
    query.is_resolved = true;
  }

  if (normalizedSearch) {
    query.$or = [
      { title: { $regex: normalizedSearch, $options: 'i' } },
      { message: { $regex: normalizedSearch, $options: 'i' } },
      { entity_type: { $regex: normalizedSearch, $options: 'i' } },
      { entity_id: { $regex: normalizedSearch, $options: 'i' } },
    ];
  }

  const createdAtFilter = {};
  const parsedStartDate = startDate ? new Date(startDate) : null;
  const parsedEndDate = endDate ? new Date(endDate) : null;

  if (parsedStartDate && !Number.isNaN(parsedStartDate.getTime())) {
    createdAtFilter.$gte = parsedStartDate;
  }

  if (parsedEndDate && !Number.isNaN(parsedEndDate.getTime())) {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate).trim());
    if (isDateOnly) {
      parsedEndDate.setHours(23, 59, 59, 999);
    }
    createdAtFilter.$lte = parsedEndDate;
  }

  if (Object.keys(createdAtFilter).length > 0) {
    query.created_at = createdAtFilter;
  }

  return query;
};

export const getSystemAlertSummary = async (baseQuery = {}) => {
  const [counts] = await SystemAlert.aggregate([
    ...(Object.keys(baseQuery).length > 0 ? [{ $match: baseQuery }] : []),
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        unread: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$is_read', false] }, { $eq: ['$is_resolved', false] }] },
              1,
              0,
            ],
          },
        },
        read: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$is_read', true] }, { $eq: ['$is_resolved', false] }] },
              1,
              0,
            ],
          },
        },
        resolved: {
          $sum: { $cond: [{ $eq: ['$is_resolved', true] }, 1, 0] },
        },
        info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } },
        warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
        critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
      },
    },
  ]);

  return {
    total: Number(counts?.total) || 0,
    unread: Number(counts?.unread) || 0,
    read: Number(counts?.read) || 0,
    resolved: Number(counts?.resolved) || 0,
    bySeverity: {
      info: Number(counts?.info) || 0,
      warning: Number(counts?.warning) || 0,
      critical: Number(counts?.critical) || 0,
    },
  };
};

export const markSystemAlertAsRead = async (alertId) =>
  SystemAlert.findByIdAndUpdate(
    alertId,
    { $set: { is_read: true } },
    { new: true }
  );

export const markAllSystemAlertsAsRead = async (query = {}) =>
  SystemAlert.updateMany(
    { ...query, is_resolved: false },
    { $set: { is_read: true } }
  );

export const resolveSystemAlert = async (alertId) =>
  SystemAlert.findByIdAndUpdate(
    alertId,
    {
      $set: {
        is_read: true,
        is_resolved: true,
      },
    },
    { new: true }
  );

const resolveAuditCategory = (action) => {
  const normalizedAction = toTrimmedString(action).toUpperCase();
  if (normalizedAction.startsWith('USER_')) return 'user';
  if (normalizedAction.startsWith('EXAM_')) return 'exam';
  if (normalizedAction.startsWith('ATTEMPT_')) return 'exam';
  if (normalizedAction.startsWith('TENANT_')) return 'tenant';
  if (normalizedAction.includes('BACKUP')) return 'backup';
  return 'system';
};

const resolveAuditSeverity = (action) => {
  const normalizedAction = toTrimmedString(action).toUpperCase();
  const criticalActions = new Set(['UNAUTHORIZED_ACCESS']);
  const warningActions = new Set([
    'USER_ROLE_CHANGED',
    'USER_DELETED',
    'USER_BLOCKED',
    'EXAM_DELETED',
    'EXAM_DISABLED',
    'ATTEMPT_FLAGGED',
    'ATTEMPT_DISQUALIFIED',
    'TENANT_DEACTIVATED',
  ]);

  if (criticalActions.has(normalizedAction)) return 'critical';
  if (warningActions.has(normalizedAction)) return 'warning';
  return 'info';
};

const humanizeAction = (action) =>
  toTrimmedString(action)
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const resolveActorLabel = (details = {}) => {
  const normalizedUserId = normalizeEntityId(details.userId);
  return buildAlertUserLabel(details, normalizedUserId ? `User ${normalizedUserId}` : 'System');
};

const resolveEntityLabel = (details = {}) => {
  const resourceType = toTrimmedString(details.resourceType || details.entityType);
  const resourceId = normalizeEntityId(details.resourceId || details.entityId);
  if (!resourceType && !resourceId) return '';
  if (!resourceType) return resourceId;
  if (!resourceId) return resourceType;
  return `${resourceType} ${resourceId}`;
};

const buildAuditMessage = (action, details = {}) => {
  const actor = resolveActorLabel(details);
  const entityLabel = resolveEntityLabel(details);
  const actionTitle = humanizeAction(action);
  if (entityLabel) {
    return `${actionTitle} by ${actor} on ${entityLabel}.`;
  }
  return `${actionTitle} by ${actor}.`;
};

const shouldEmitAuditAlert = (action) => {
  const normalizedAction = toTrimmedString(action).toUpperCase();
  const allowed = new Set([
    'USER_CREATED',
    'USER_UPDATED',
    'USER_ROLE_CHANGED',
    'USER_DELETED',
    'USER_BLOCKED',
    'USER_UNBLOCKED',
    'EXAM_CREATED',
    'EXAM_UPDATED',
    'EXAM_DELETED',
    'EXAM_ENABLED',
    'EXAM_DISABLED',
    'EXAM_RESULTS_RELEASED',
    'ATTEMPT_FLAGGED',
    'ATTEMPT_DISQUALIFIED',
    'TENANT_CREATED',
    'TENANT_UPDATED',
    'TENANT_DEACTIVATED',
    'UNAUTHORIZED_ACCESS',
  ]);
  return allowed.has(normalizedAction);
};

export const emitSystemAlertFromAuditEvent = async (action, details = {}) => {
  try {
    if (!shouldEmitAuditAlert(action)) return null;

    const normalizedAction = toTrimmedString(action).toUpperCase();
    const category = resolveAuditCategory(normalizedAction);
    const severity = resolveAuditSeverity(normalizedAction);
    const title = humanizeAction(normalizedAction);
    const message = buildAuditMessage(normalizedAction, details);
    const entityType = toTrimmedString(details.resourceType || details.entityType || category);
    const entityId = normalizeEntityId(details.resourceId || details.entityId);
    const actorUserName = resolveAlertUserName(details);
    const actorUserEmail = resolveAlertUserEmail(details);

    return await createSystemAlert({
      title,
      message,
      severity,
      category,
      entityType,
      entityId,
      dedupeKey: `audit:${normalizedAction}:${entityType}:${entityId}:${details.path || ''}`,
      cooldownSeconds: severity === 'critical' ? 120 : 30,
      metadata: {
        action: normalizedAction,
        actor_user_id: normalizeEntityId(details.userId),
        actor_user_name: actorUserName,
        actor_user_email: actorUserEmail,
        actor_role: toTrimmedString(details.userRole),
        tenant_id: normalizeEntityId(details.tenantId),
        method: toTrimmedString(details.method),
        path: toTrimmedString(details.path),
        status_code: Number(details.statusCode) || null,
      },
    });
  } catch (error) {
    console.error(
      '[SYSTEM ALERT] Failed to emit audit-driven system alert:',
      error?.message || error
    );
    return null;
  }
};

export const emitTenantQuotaExceededAlert = async ({
  tenantId,
  tenantName = '',
  message = 'Tenant quota limit reached.',
  limitType = 'general',
  usage = null,
  category = 'tenant',
}) => {
  const normalizedTenantId = normalizeEntityId(tenantId);
  const normalizedTenantName = toTrimmedString(tenantName) || 'Unknown Tenant';
  const normalizedLimitType = toTrimmedString(limitType).toLowerCase() || 'general';

  return createSystemAlert({
    title: 'Tenant Quota Exceeded',
    message: `${normalizedTenantName}: ${toTrimmedString(message)}`,
    severity: 'warning',
    category,
    entityType: 'tenant',
    entityId: normalizedTenantId,
    dedupeKey: `quota:${normalizedTenantId}:${normalizedLimitType}`,
    cooldownSeconds: 30 * 60,
    metadata: {
      tenant_id: normalizedTenantId,
      tenant_name: normalizedTenantName,
      limit_type: normalizedLimitType,
      usage: usage && typeof usage === 'object' ? usage : null,
    },
  });
};

const resolveTenantAiQuestionLimit = (tenant) => {
  const subscription = toSafeObject(tenant?.subscription);
  const subscriptionStatus = resolveSubscriptionStatus(subscription);
  const assignedPlanType = resolveSubscriptionPlanType(
    subscription?.planType || SUBSCRIPTION_PLAN_TYPES.FREE
  );
  const effectivePlanType = resolveEffectivePlanType(assignedPlanType, subscriptionStatus);
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const planLimit = toPositiveIntOrNull(planDefinition?.limits?.maxAiQuestionsPerMonth);
  if (planLimit !== null) {
    return {
      limit: planLimit,
      effectivePlanType,
    };
  }

  if (effectivePlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND) {
    const customLimits = toSafeObject(subscription.customLimits);
    if (Object.prototype.hasOwnProperty.call(customLimits, 'maxAiQuestionsPerMonth')) {
      return {
        limit: toPositiveIntOrNull(customLimits.maxAiQuestionsPerMonth),
        effectivePlanType,
      };
    }
    return {
      limit: toPositiveIntOrNull(tenant?.aiUsageLimit),
      effectivePlanType,
    };
  }

  return { limit: null, effectivePlanType };
};

const buildAiUsageWindow = (subscription) => {
  const { start, end } = getCurrentMonthRange();
  const resetAt = subscription?.usageResetAt ? new Date(subscription.usageResetAt) : null;
  if (resetAt && !Number.isNaN(resetAt.getTime()) && resetAt > start && resetAt < end) {
    return { start: resetAt, end };
  }
  return { start, end };
};

export const evaluateAiUsageAlertRules = async (tenantId) => {
  try {
    const normalizedTenantId = normalizeEntityId(tenantId);
    if (!normalizedTenantId || !mongoose.Types.ObjectId.isValid(normalizedTenantId)) {
      return null;
    }

    const now = Date.now();
    const lastEvaluatedAt = aiRuleEvaluationCache.get(normalizedTenantId) || 0;
    if (now - lastEvaluatedAt < AI_RULE_EVALUATION_COOLDOWN_MS) {
      return null;
    }
    aiRuleEvaluationCache.set(normalizedTenantId, now);

    const tenant = await Tenant.findById(normalizedTenantId)
      .select('name code subscription aiUsageLimit')
      .lean();
    if (!tenant) return null;

    const { limit, effectivePlanType } = resolveTenantAiQuestionLimit(tenant);
    const usageWindow = buildAiUsageWindow(tenant.subscription || {});

    const [windowTotals] = await AITokenUsage.aggregate([
      {
        $match: {
          tenant_id: new mongoose.Types.ObjectId(normalizedTenantId),
          request_status: 'SUCCESS',
          created_at: { $gte: usageWindow.start, $lt: usageWindow.end },
        },
      },
      {
        $group: {
          _id: null,
          request_count: {
            $sum: {
              $max: [
                1,
                {
                  $convert: {
                    input: '$usage_count',
                    to: 'int',
                    onError: 1,
                    onNull: 1,
                  },
                },
              ],
            },
          },
          total_tokens: {
            $sum: {
              $max: [
                0,
                {
                  $convert: {
                    input: { $ifNull: ['$total_tokens', '$tokens_used'] },
                    to: 'double',
                    onError: 0,
                    onNull: 0,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    const requestCount = Math.max(0, Math.floor(toNumberOrZero(windowTotals?.request_count)));
    const totalTokens = Math.max(0, Math.floor(toNumberOrZero(windowTotals?.total_tokens)));

    if (limit !== null && limit > 0) {
      const utilizationPercent = Number(((requestCount / limit) * 100).toFixed(2));

      if (utilizationPercent >= AI_WARNING_THRESHOLD_PERCENT) {
        const thresholdSeverity =
          utilizationPercent >= AI_CRITICAL_THRESHOLD_PERCENT ? 'critical' : 'warning';

        await createSystemAlert({
          title:
            thresholdSeverity === 'critical'
              ? 'AI Usage Limit Exceeded'
              : 'AI Usage Threshold Reached',
          message: `${tenant.name} has used ${requestCount}/${limit} AI requests (${utilizationPercent}%) in the current billing window.`,
          severity: thresholdSeverity,
          category: 'ai',
          entityType: 'tenant',
          entityId: normalizedTenantId,
          dedupeKey: `ai-threshold:${normalizedTenantId}:${usageWindow.start.toISOString().slice(0, 10)}:${thresholdSeverity}`,
          cooldownSeconds: 6 * 60 * 60,
          metadata: {
            tenant_id: normalizedTenantId,
            tenant_name: tenant.name || '',
            tenant_code: tenant.code || '',
            effective_plan: effectivePlanType,
            usage_window_start: usageWindow.start,
            usage_window_end: usageWindow.end,
            request_count: requestCount,
            total_tokens: totalTokens,
            limit,
            utilization_percent: utilizationPercent,
          },
        });
      }
    }

    const lastHourStart = new Date(now - 60 * 60 * 1000);
    const last24HoursStart = new Date(now - 24 * 60 * 60 * 1000);

    const [lastHourTotals, previousWindowTotals] = await Promise.all([
      AITokenUsage.aggregate([
        {
          $match: {
            tenant_id: new mongoose.Types.ObjectId(normalizedTenantId),
            request_status: 'SUCCESS',
            created_at: { $gte: lastHourStart, $lt: new Date(now) },
          },
        },
        {
          $group: {
            _id: null,
            total_tokens: {
              $sum: {
                $max: [
                  0,
                  {
                    $convert: {
                      input: { $ifNull: ['$total_tokens', '$tokens_used'] },
                      to: 'double',
                      onError: 0,
                      onNull: 0,
                    },
                  },
                ],
              },
            },
          },
        },
      ]),
      AITokenUsage.aggregate([
        {
          $match: {
            tenant_id: new mongoose.Types.ObjectId(normalizedTenantId),
            request_status: 'SUCCESS',
            created_at: { $gte: last24HoursStart, $lt: lastHourStart },
          },
        },
        {
          $group: {
            _id: null,
            total_tokens: {
              $sum: {
                $max: [
                  0,
                  {
                    $convert: {
                      input: { $ifNull: ['$total_tokens', '$tokens_used'] },
                      to: 'double',
                      onError: 0,
                      onNull: 0,
                    },
                  },
                ],
              },
            },
          },
        },
      ]),
    ]);

    const lastHourTokens = Math.max(0, toNumberOrZero(lastHourTotals?.[0]?.total_tokens));
    const previousTokens = Math.max(0, toNumberOrZero(previousWindowTotals?.[0]?.total_tokens));
    const baselineHourlyTokens = previousTokens / 23 || 0;
    const spikeThreshold = Math.max(MIN_SPIKE_TOKENS, baselineHourlyTokens * 3);
    const isSpike = baselineHourlyTokens > 0 && lastHourTokens >= spikeThreshold;

    if (isSpike) {
      await createSystemAlert({
        title: 'Abnormal AI Usage Spike',
        message: `${tenant.name} consumed ${Math.floor(lastHourTokens).toLocaleString()} AI tokens in the last hour, significantly above baseline.`,
        severity: 'warning',
        category: 'ai',
        entityType: 'tenant',
        entityId: normalizedTenantId,
        dedupeKey: `ai-spike:${normalizedTenantId}:${new Date(now).toISOString().slice(0, 13)}`,
        cooldownSeconds: 60 * 60,
        metadata: {
          tenant_id: normalizedTenantId,
          tenant_name: tenant.name || '',
          tenant_code: tenant.code || '',
          last_hour_tokens: Math.floor(lastHourTokens),
          baseline_hourly_tokens: Number(baselineHourlyTokens.toFixed(2)),
          evaluated_at: new Date(now),
        },
      });
    }

    return {
      requestCount,
      totalTokens,
      limit,
    };
  } catch (error) {
    console.error('[SYSTEM ALERT] AI usage alert rule evaluation failed:', error?.message || error);
    return null;
  }
};

export const emitSystemFailureAlert = async ({
  title = 'System API Failure',
  message = 'An internal server error was detected.',
  path = '',
  method = '',
  statusCode = 500,
  errorMessage = '',
  stack = '',
}) =>
  createSystemAlert({
    title,
    message,
    severity: 'critical',
    category: 'system',
    entityType: 'api',
    entityId: `${toTrimmedString(method).toUpperCase()} ${toTrimmedString(path)}`.trim(),
    dedupeKey: `api-failure:${toTrimmedString(method).toUpperCase()}:${toTrimmedString(path)}:${Number(statusCode) || 500}:${toTrimmedString(errorMessage).slice(0, 120)}`,
    cooldownSeconds: 5 * 60,
    metadata: {
      method: toTrimmedString(method).toUpperCase(),
      path: toTrimmedString(path),
      status_code: Number(statusCode) || 500,
      error_message: toTrimmedString(errorMessage).slice(0, 500),
      stack: toTrimmedString(stack).slice(0, 2000),
    },
  });

export const emitBackupOperationAlert = async ({
  title,
  message,
  severity = 'info',
  entityId = '',
  metadata = {},
}) =>
  createSystemAlert({
    title,
    message,
    severity,
    category: 'backup',
    entityType: 'backup',
    entityId,
    metadata,
    dedupeKey: `backup:${toTrimmedString(title)}:${normalizeEntityId(entityId)}`,
    cooldownSeconds: severity === 'critical' ? 60 : 15,
  });
