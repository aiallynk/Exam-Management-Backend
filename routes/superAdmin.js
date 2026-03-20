import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import { checkTenantLimits } from '../middleware/planLimits.js';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamSession from '../models/ExamSession.js';
import AITokenUsage from '../models/AITokenUsage.js';
import AuditLog from '../models/AuditLog.js';
import BackupHistory from '../models/BackupHistory.js';
import SystemAlert from '../models/SystemAlert.js';
import { deleteUserAndCleanup } from '../services/userDeletionService.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import {
  getMongoEstimatedCostExpression,
  getMongoNormalizedModelExpression,
  MODEL_PRICING_REFERENCE,
  normalizeModelName,
  usdToInr,
  USD_TO_INR_RATE,
} from '../utils/aiPricing.js';
import config from '../config/env.js';
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_PLAN_TYPES,
  SUBSCRIPTION_STATUSES,
  getSubscriptionPlanDefinition,
  resolveSubscriptionPlanType,
  resolveSubscriptionStatus,
  resolveEffectivePlanType,
} from '../config/planLimits.js';
import {
  getCurrentMonthRange,
  getExamCountForTenantByWindow,
  getAttemptCountForTenantByWindow,
} from '../utils/planUsage.js';
import {
  createBackup,
  createTenantBackupsForAll,
  listBackupHistory,
  restoreBackupFromHistory,
  restoreBackupFromUploadedFile,
  parseBackupManifest,
  getBackupDownloadPath,
  deleteBackup,
} from '../services/backupService.js';
import { emitBackupOperationAlert } from '../services/systemAlertService.js';

const router = express.Router();

const backupUploadDir = path.join(os.tmpdir(), 'exam-management-backup-uploads');
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fsSync.mkdirSync(backupUploadDir, { recursive: true });
        cb(null, backupUploadDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const safeOriginal = String(file.originalname || 'uploaded_backup.zip')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
      cb(null, `${Date.now()}_${safeOriginal || 'uploaded_backup.zip'}`);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB
  },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    if (!fileName.endsWith('.zip')) {
      cb(new Error('Only ZIP backup files are allowed.'));
      return;
    }
    cb(null, true);
  },
});

const toFormattedBackupRecord = (record) => {
  const company = record?.company_id || null;
  const createdBy = record?.created_by || null;
  const restoredBy = record?.restored_by || null;
  return {
    id: record?._id || null,
    backup_name: record?.backup_name || '',
    type: record?.type || '',
    company_id: company?._id || company || null,
    company_name: company?.name || null,
    company_code: company?.code || null,
    file_size: Number(record?.file_size) || 0,
    storage_path: record?.storage_url_path || record?.storage_path || '',
    status: record?.status || '',
    created_by: createdBy?._id || createdBy || null,
    created_by_name: createdBy?.name || null,
    created_by_email: createdBy?.email || null,
    restored_by: restoredBy?._id || restoredBy || null,
    restored_by_name: restoredBy?.name || null,
    restored_by_email: restoredBy?.email || null,
    restored_at: record?.restored_at || null,
    created_at: record?.created_at || null,
    updated_at: record?.updated_at || null,
    error_message: record?.error_message || '',
    source_backup_id: record?.source_backup_id || null,
  };
};

const isValidMongoId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ''));

const buildActorAuditDetails = (req) => ({
  userId: req.user?._id || null,
  userEmail: req.user?.email || null,
  userName: req.user?.name || null,
  userRole: req.user?.role || null,
  ip: req.ip,
  userAgent: req.get('user-agent'),
  method: req.method,
  path: req.path,
});

const buildUsageWindow = (subscription = null, referenceDate = new Date()) => {
  const { start, end } = getCurrentMonthRange(referenceDate);
  const resetAt = subscription?.usageResetAt ? new Date(subscription.usageResetAt) : null;
  if (resetAt && !Number.isNaN(resetAt.getTime()) && resetAt > start && resetAt < end) {
    return { start: resetAt, end };
  }
  return { start, end };
};

const LEGEND_CUSTOM_LIMIT_KEYS = Object.freeze([
  'maxExamsPerMonth',
  'maxAttemptsPerMonth',
  'maxAiQuestionsPerMonth',
  'maxCandidates',
]);

const SUBSCRIPTION_STATUS_VALUES = Object.freeze([
  SUBSCRIPTION_STATUSES.ACTIVE,
  SUBSCRIPTION_STATUSES.EXPIRED,
  SUBSCRIPTION_STATUSES.SUSPENDED,
]);

const PLAN_DEFAULT_DURATIONS_DAYS = Object.freeze({
  [SUBSCRIPTION_PLAN_TYPES.FREE]: 30,
  [SUBSCRIPTION_PLAN_TYPES.PRO]: 30,
  [SUBSCRIPTION_PLAN_TYPES.ULTIMATE]: 180,
  [SUBSCRIPTION_PLAN_TYPES.LEGEND]: 365,
});

const hasOwn = (target, key) =>
  Boolean(target && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key));

const normalizeOptionalObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const parseOptionalLimitValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const isValidLimitInput = (value) => {
  if (value === null || value === undefined || value === '') return true;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
};

const extractLegendCustomLimits = (input) => {
  const source = normalizeOptionalObject(input);
  const result = {};
  LEGEND_CUSTOM_LIMIT_KEYS.forEach((key) => {
    if (hasOwn(source, key)) {
      result[key] = parseOptionalLimitValue(source[key]);
    }
  });
  return result;
};

const extractFeatureOverrides = (input) => {
  const source = normalizeOptionalObject(input);
  return Object.entries(source).reduce((accumulator, [key, value]) => {
    if (typeof value === 'boolean') {
      accumulator[key] = value;
    }
    return accumulator;
  }, {});
};

const FEATURE_SOURCE_TYPES = Object.freeze({
  PLAN: 'plan',
  OVERRIDE: 'override',
  CUSTOM: 'custom',
});

const MAIN_FEATURE_DEFINITIONS = Object.freeze({
  examsLimit: {
    key: 'examsLimit',
    label: 'Exams Limit',
    description: 'Monthly exam creation quota availability.',
    type: 'limit',
    limitKey: 'maxExamsPerMonth',
  },
  candidateLimit: {
    key: 'candidateLimit',
    label: 'Candidate Limit',
    description: 'Maximum active candidates allowance for the tenant.',
    type: 'limit',
    limitKey: 'maxCandidates',
  },
  aiUsage: {
    key: 'aiUsage',
    label: 'AI Usage',
    description: 'AI-assisted question generation usage availability.',
    type: 'limit',
    limitKey: 'maxAiQuestionsPerMonth',
  },
  questionTypes: {
    key: 'questionTypes',
    label: 'Question Types',
    description: 'Access to extended question type set.',
    type: 'boolean',
    customFeatureKey: 'questionTypesAccess',
  },
  secureBrowser: {
    key: 'secureBrowser',
    label: 'Secure Browser',
    description: 'Secure browser controls for exams.',
    type: 'boolean',
    customFeatureKey: 'secureBrowser',
    planFeatureKey: 'secureBrowser',
  },
  omrEvaluation: {
    key: 'omrEvaluation',
    label: 'OMR Evaluation',
    description: 'Optical mark recognition evaluation support.',
    type: 'boolean',
    customFeatureKey: 'omr',
    planFeatureKey: 'omr',
  },
});

const ADDON_FEATURE_DEFINITIONS = Object.freeze({
  aiProctoring: {
    key: 'aiProctoring',
    label: 'AI Proctoring',
    description: 'AI-assisted proctoring and monitoring.',
    customFeatureKey: 'addonAiProctoring',
  },
  advancedAnalytics: {
    key: 'advancedAnalytics',
    label: 'Advanced Analytics',
    description: 'Premium analytics and deeper visual insights.',
    customFeatureKey: 'addonAdvancedAnalytics',
  },
  customBranding: {
    key: 'customBranding',
    label: 'Custom Branding',
    description: 'Tenant-level branding customization.',
    customFeatureKey: 'addonCustomBranding',
  },
  apiAccess: {
    key: 'apiAccess',
    label: 'API Access',
    description: 'Enable external API integration capability.',
    customFeatureKey: 'addonApiAccess',
  },
  bulkImportExport: {
    key: 'bulkImportExport',
    label: 'Bulk Import/Export',
    description: 'Bulk import and export operations.',
    customFeatureKey: 'addonBulkImportExport',
  },
  codingCompiler: {
    key: 'codingCompiler',
    label: 'Coding Compiler',
    description: 'Coding question compiler support.',
    customFeatureKey: 'addonCodingCompiler',
  },
});

const resolvePlanQuestionTypesEnabled = (planFeatures = {}) => {
  const questionTypes = Array.isArray(planFeatures?.questionTypes)
    ? planFeatures.questionTypes
    : [];
  if (questionTypes.length === 0) return true;
  return questionTypes.length > 3;
};

const resolvePlanMainBooleanValue = (feature, planFeatures = {}) => {
  if (feature.key === 'questionTypes') {
    return resolvePlanQuestionTypesEnabled(planFeatures);
  }
  if (!feature.planFeatureKey) return true;
  return planFeatures?.[feature.planFeatureKey] !== false;
};

const buildMainFeatureState = ({
  feature,
  planLimits,
  planFeatures,
  customLimits,
  customFeatures,
}) => {
  if (feature.type === 'limit') {
    const hasOverride = hasOwn(customLimits, feature.limitKey);
    const planValue = parseOptionalLimitValue(planLimits?.[feature.limitKey]);
    const overrideValue = hasOverride ? parseOptionalLimitValue(customLimits[feature.limitKey]) : null;
    const effectiveValue = hasOverride ? overrideValue : planValue;
    const enabled = effectiveValue === null || effectiveValue > 0;

    return {
      key: feature.key,
      label: feature.label,
      description: feature.description,
      type: feature.type,
      enabled,
      status: enabled ? 'Active' : 'Disabled',
      source: hasOverride ? FEATURE_SOURCE_TYPES.OVERRIDE : FEATURE_SOURCE_TYPES.PLAN,
      overrideEnabled: hasOverride,
      planValue,
      overrideValue: hasOverride ? overrideValue : null,
      effectiveValue,
    };
  }

  const customFeatureKey = feature.customFeatureKey;
  const hasOverride =
    hasOwn(customFeatures, customFeatureKey) &&
    typeof customFeatures[customFeatureKey] === 'boolean';
  const planValue = resolvePlanMainBooleanValue(feature, planFeatures);
  const overrideValue = hasOverride ? Boolean(customFeatures[customFeatureKey]) : null;
  const enabled = hasOverride ? overrideValue : planValue;

  return {
    key: feature.key,
    label: feature.label,
    description: feature.description,
    type: feature.type,
    enabled,
    status: enabled ? 'Active' : 'Disabled',
    source: hasOverride ? FEATURE_SOURCE_TYPES.OVERRIDE : FEATURE_SOURCE_TYPES.PLAN,
    overrideEnabled: hasOverride,
    planValue,
    overrideValue: hasOverride ? overrideValue : null,
    effectiveValue: enabled,
  };
};

const buildAddonFeatureState = ({ feature, customFeatures }) => {
  const value =
    hasOwn(customFeatures, feature.customFeatureKey) &&
    typeof customFeatures[feature.customFeatureKey] === 'boolean'
      ? Boolean(customFeatures[feature.customFeatureKey])
      : false;

  return {
    key: feature.key,
    label: feature.label,
    description: feature.description,
    enabled: value,
    status: value ? 'Active' : 'Disabled',
    source: FEATURE_SOURCE_TYPES.CUSTOM,
  };
};

const buildTenantFeaturePayload = (tenantInput) => {
  const tenant = tenantInput?.toObject ? tenantInput.toObject() : tenantInput;
  const subscription = normalizeOptionalObject(tenant?.subscription);
  const assignedPlanType = resolveSubscriptionPlanType(
    subscription.planType || SUBSCRIPTION_PLAN_TYPES.FREE
  );
  const subscriptionStatus = resolveSubscriptionStatus(subscription);
  const effectivePlanType = resolveEffectivePlanType(assignedPlanType, subscriptionStatus);
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const basePlanLimits = normalizeOptionalObject(planDefinition?.limits);
  const effectivePlanLimits = resolveLegendEffectiveLimits({
    planType: effectivePlanType,
    tenant,
    baseLimits: basePlanLimits,
  });
  const planFeatures = normalizeOptionalObject(planDefinition?.features);
  const customLimits = normalizeOptionalObject(subscription.customLimits);
  const customFeatures = normalizeOptionalObject(subscription.customFeatures);

  const mainFeatures = Object.values(MAIN_FEATURE_DEFINITIONS).reduce((accumulator, feature) => {
    accumulator[feature.key] = buildMainFeatureState({
      feature,
      planLimits: effectivePlanLimits,
      planFeatures,
      customLimits,
      customFeatures,
    });
    return accumulator;
  }, {});

  const addonFeatures = Object.values(ADDON_FEATURE_DEFINITIONS).reduce((accumulator, feature) => {
    accumulator[feature.key] = buildAddonFeatureState({
      feature,
      customFeatures,
    });
    return accumulator;
  }, {});

  return {
    tenantId: tenant?._id || null,
    tenantName: tenant?.name || '',
    tenantCode: tenant?.code || '',
    plan: {
      assigned: assignedPlanType,
      effective: effectivePlanType,
      status: subscriptionStatus,
      label: planDefinition?.label || String(effectivePlanType || '').toUpperCase(),
    },
    features: {
      main: mainFeatures,
      addons: addonFeatures,
    },
    updatedAt: subscription.updatedAt || tenant?.updatedAt || null,
  };
};

const resolveLegendEffectiveLimits = ({ planType, tenant, baseLimits }) => {
  const normalizedPlanType = resolveSubscriptionPlanType(planType);

  const customLimits = normalizeOptionalObject(tenant?.subscription?.customLimits);
  const resolveLimit = (key, legacyValue, baseValue) => {
    if (hasOwn(customLimits, key)) {
      return parseOptionalLimitValue(customLimits[key]);
    }
    const legacyLimit = parseOptionalLimitValue(legacyValue);
    if (legacyLimit !== null) {
      return legacyLimit;
    }
    return parseOptionalLimitValue(baseValue);
  };

  return {
    ...baseLimits,
    maxExamsPerMonth: resolveLimit(
      'maxExamsPerMonth',
      normalizedPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND ? tenant?.examLimit : null,
      baseLimits?.maxExamsPerMonth
    ),
    maxAttemptsPerMonth: resolveLimit(
      'maxAttemptsPerMonth',
      normalizedPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND ? tenant?.attemptLimit : null,
      baseLimits?.maxAttemptsPerMonth
    ),
    maxAiQuestionsPerMonth: resolveLimit(
      'maxAiQuestionsPerMonth',
      normalizedPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND ? tenant?.aiUsageLimit : null,
      baseLimits?.maxAiQuestionsPerMonth
    ),
    maxCandidates: resolveLimit('maxCandidates', null, baseLimits?.maxCandidates),
  };
};

const REVENUE_RANGE_TYPES = Object.freeze({
  LAST_7_DAYS: '7d',
  LAST_30_DAYS: '30d',
  LAST_6_MONTHS: '6m',
  LAST_12_MONTHS: '12m',
  ALL_TIME: 'all',
});

const REVENUE_INTERVAL_TYPES = Object.freeze({
  DAILY: 'daily',
  MONTHLY: 'monthly',
});

const REVENUE_MS_PER_DAY = 24 * 60 * 60 * 1000;

const toValidDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const normalizeSubscriptionStatusInput = (value) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  return SUBSCRIPTION_STATUS_VALUES.includes(normalized) ? normalized : null;
};

const startOfCurrentDayUtc = (value = new Date()) => {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
};

const calculateDefaultSubscriptionExpiryDate = (planType, startDate = new Date()) => {
  const normalizedPlanType = resolveSubscriptionPlanType(planType) || SUBSCRIPTION_PLAN_TYPES.FREE;
  const durationDays = PLAN_DEFAULT_DURATIONS_DAYS[normalizedPlanType] || PLAN_DEFAULT_DURATIONS_DAYS[SUBSCRIPTION_PLAN_TYPES.FREE];
  const base = startOfCurrentDayUtc(startDate);
  const expiresAt = new Date(base);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);
  return expiresAt;
};

const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const startOfMonth = (value) => {
  const date = new Date(value);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfMonth = (value) => {
  const date = new Date(value);
  date.setMonth(date.getMonth() + 1, 0);
  date.setHours(23, 59, 59, 999);
  return date;
};

const addDays = (value, days) => {
  const date = new Date(value);
  date.setDate(date.getDate() + Number(days || 0));
  return date;
};

const addMonths = (value, months) => {
  const date = new Date(value);
  const safeMonths = Number(months || 0);
  date.setMonth(date.getMonth() + safeMonths);
  return date;
};

const toDayKey = (value) => {
  const date = new Date(value);
  return date.toISOString().slice(0, 10);
};

const toMonthKey = (value) => {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const formatRevenueBucketLabel = (value, interval) => {
  const date = new Date(value);
  if (interval === REVENUE_INTERVAL_TYPES.DAILY) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

const extractSubscriptionPlanTypeFromAuditDetails = (details, phase = 'after') => {
  const safeDetails = normalizeOptionalObject(details);
  const nestedDetails = normalizeOptionalObject(safeDetails.details);
  const directPayload = normalizeOptionalObject(safeDetails[phase]);
  const nestedPayload = normalizeOptionalObject(nestedDetails[phase]);
  const hasDirectValue = hasOwn(directPayload, 'planType');
  const hasNestedValue = hasOwn(nestedPayload, 'planType');

  if (!hasDirectValue && !hasNestedValue) return null;

  const rawPlanType = hasDirectValue ? directPayload.planType : nestedPayload.planType;
  return resolveSubscriptionPlanType(rawPlanType || SUBSCRIPTION_PLAN_TYPES.FREE);
};

const getTenantBillingStartDate = (tenant, fallback = new Date()) => {
  const startedAt = toValidDate(tenant?.subscription?.startedAt);
  const createdAt = toValidDate(tenant?.createdAt);
  if (startedAt && createdAt) {
    return startedAt < createdAt ? startedAt : createdAt;
  }
  return startedAt || createdAt || new Date(fallback);
};

const buildRevenueWindow = ({ range, now, earliestBillingDate }) => {
  const normalizedNow = toValidDate(now) || new Date();

  if (range === REVENUE_RANGE_TYPES.LAST_7_DAYS) {
    return {
      start: startOfDay(new Date(normalizedNow.getTime() - 6 * REVENUE_MS_PER_DAY)),
      end: normalizedNow,
      interval: REVENUE_INTERVAL_TYPES.DAILY,
    };
  }

  if (range === REVENUE_RANGE_TYPES.LAST_30_DAYS) {
    return {
      start: startOfDay(new Date(normalizedNow.getTime() - 29 * REVENUE_MS_PER_DAY)),
      end: normalizedNow,
      interval: REVENUE_INTERVAL_TYPES.DAILY,
    };
  }

  if (range === REVENUE_RANGE_TYPES.LAST_6_MONTHS) {
    return {
      start: startOfMonth(addMonths(normalizedNow, -5)),
      end: normalizedNow,
      interval: REVENUE_INTERVAL_TYPES.MONTHLY,
    };
  }

  if (range === REVENUE_RANGE_TYPES.LAST_12_MONTHS) {
    return {
      start: startOfMonth(addMonths(normalizedNow, -11)),
      end: normalizedNow,
      interval: REVENUE_INTERVAL_TYPES.MONTHLY,
    };
  }

  const earliest = toValidDate(earliestBillingDate) || normalizedNow;
  const boundedEarliest = earliest > normalizedNow ? normalizedNow : earliest;
  return {
    start: startOfMonth(boundedEarliest),
    end: normalizedNow,
    interval: REVENUE_INTERVAL_TYPES.MONTHLY,
  };
};

const buildRevenueBuckets = ({ start, end, interval }) => {
  const bucketStart = toValidDate(start);
  const bucketEnd = toValidDate(end);
  if (!bucketStart || !bucketEnd || bucketStart > bucketEnd) return [];

  const buckets = [];

  if (interval === REVENUE_INTERVAL_TYPES.DAILY) {
    for (
      let cursor = startOfDay(bucketStart);
      cursor <= bucketEnd;
      cursor = addDays(cursor, 1)
    ) {
      const pointDate = endOfDay(cursor) > bucketEnd ? new Date(bucketEnd) : endOfDay(cursor);
      buckets.push({
        key: toDayKey(cursor),
        label: formatRevenueBucketLabel(cursor, interval),
        date: toDayKey(cursor),
        pointDate,
      });
    }
    return buckets;
  }

  const lastMonth = startOfMonth(bucketEnd);
  for (
    let cursor = startOfMonth(bucketStart);
    cursor <= lastMonth;
    cursor = addMonths(cursor, 1)
  ) {
    const pointDate = endOfMonth(cursor) > bucketEnd ? new Date(bucketEnd) : endOfMonth(cursor);
    buckets.push({
      key: toMonthKey(cursor),
      label: formatRevenueBucketLabel(cursor, interval),
      date: toMonthKey(cursor),
      pointDate,
    });
  }

  return buckets;
};

const buildTenantSubscriptionSummary = async (tenant) => {
  const subscription = tenant?.subscription || {};
  const planType = resolveSubscriptionPlanType(subscription.planType || SUBSCRIPTION_PLAN_TYPES.FREE);
  const subscriptionStatus = resolveSubscriptionStatus(subscription);
  const effectivePlanType = resolveEffectivePlanType(planType, subscriptionStatus);
  const planDefinition = getSubscriptionPlanDefinition(planType);
  const featureOverrides = extractFeatureOverrides(subscription.customFeatures);
  const effectiveLimits = resolveLegendEffectiveLimits({
    planType,
    tenant,
    baseLimits: planDefinition?.limits || {},
  });
  const usageWindow = buildUsageWindow(subscription);

  const [examsUsed, attemptsUsed, activeUsers] = await Promise.all([
    getExamCountForTenantByWindow(tenant._id, usageWindow.start, usageWindow.end),
    getAttemptCountForTenantByWindow(tenant._id, usageWindow.start, usageWindow.end),
    User.countDocuments({
      tenantId: tenant._id,
      status: 'ACTIVE',
      role: { $ne: 'SUPER_ADMIN' },
    }),
  ]);

  return {
    _id: tenant._id,
    name: tenant.name,
    code: tenant.code,
    type: tenant.type,
    status: tenant.status,
    planStartDate: subscription.startedAt || null,
    planExpiryDate: subscription.expiresAt || null,
    subscriptionStatus,
    subscription: {
      planType,
      status: subscriptionStatus,
      startedAt: subscription.startedAt || null,
      expiresAt: subscription.expiresAt || null,
      planStartDate: subscription.startedAt || null,
      planExpiryDate: subscription.expiresAt || null,
      subscriptionStatus,
      usageResetAt: subscription.usageResetAt || null,
      customLimits: normalizeOptionalObject(subscription.customLimits),
      customFeatures: normalizeOptionalObject(subscription.customFeatures),
      updatedAt: subscription.updatedAt || null,
    },
    effectivePlanType,
    plan: {
      id: planDefinition.id,
      label: planDefinition.label,
      price: planDefinition.price,
      limits: effectiveLimits,
      features: {
        ...(planDefinition.features || {}),
        ...featureOverrides,
      },
    },
    usage: {
      exams: examsUsed,
      attempts: attemptsUsed,
      users: activeUsers,
      window: {
        start: usageWindow.start,
        end: usageWindow.end,
      },
    },
  };
};

// All Super Admin routes require SUPER_ADMIN role
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

/**
 * SUBSCRIPTION PLAN CATALOG
 * GET /api/super-admin/subscriptions/plans
 */
router.get('/subscriptions/plans', async (_req, res, next) => {
  try {
    const planOrder = [
      SUBSCRIPTION_PLAN_TYPES.FREE,
      SUBSCRIPTION_PLAN_TYPES.PRO,
      SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
      SUBSCRIPTION_PLAN_TYPES.LEGEND,
    ];

    const plans = planOrder.map((planType) => {
      const plan = getSubscriptionPlanDefinition(planType);
      return {
        id: plan.id,
        label: plan.label,
        price: plan.price,
        limits: plan.limits,
        features: plan.features,
      };
    });

    res.json({ plans });
  } catch (error) {
    next(error);
  }
});

/**
 * SUBSCRIPTION TENANT LIST WITH USAGE
 * GET /api/super-admin/subscriptions/tenants
 */
router.get('/subscriptions/tenants', async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search, q } = req.query;
    const normalizedSearch = String(search || q || '').trim();
    const filter = {};

    if (normalizedSearch) {
      filter.$or = [
        { name: { $regex: normalizedSearch, $options: 'i' } },
        { code: { $regex: normalizedSearch, $options: 'i' } },
        { contactEmail: { $regex: normalizedSearch, $options: 'i' } },
      ];
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [tenants, total] = await Promise.all([
      Tenant.find(filter)
        .select('name code type status subscription examLimit attemptLimit aiUsageLimit updatedAt')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Tenant.countDocuments(filter),
    ]);

    const summaries = await Promise.all(
      (Array.isArray(tenants) ? tenants : []).map((tenant) =>
        buildTenantSubscriptionSummary(tenant)
      )
    );

    res.json({
      tenants: summaries,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * SUBSCRIPTION REVENUE ANALYTICS
 * GET /api/super-admin/subscriptions/revenue-analytics
 * Optional query params:
 * - range: 7d | 30d | 6m | 12m | all
 * - tenantId: all | <tenantId>
 * - planType: all | free | pro | ultimate | legend
 */
router.get('/subscriptions/revenue-analytics', async (req, res, next) => {
  try {
    const now = new Date();
    const normalizedRange = String(req.query?.range || REVENUE_RANGE_TYPES.LAST_30_DAYS)
      .trim()
      .toLowerCase();
    const normalizedTenantId = String(req.query?.tenantId || 'all').trim();
    const normalizedPlanType = String(req.query?.planType || 'all')
      .trim()
      .toLowerCase();

    const allowedRanges = new Set(Object.values(REVENUE_RANGE_TYPES));
    if (!allowedRanges.has(normalizedRange)) {
      return res.status(400).json({
        error: 'Invalid range. Use one of: 7d, 30d, 6m, 12m, all.',
      });
    }

    if (normalizedTenantId !== 'all' && !isValidMongoId(normalizedTenantId)) {
      return res.status(400).json({
        error: 'Invalid tenantId. Use "all" or a valid tenant id.',
      });
    }

    const selectedPlanFilter =
      normalizedPlanType === 'all'
        ? 'all'
        : resolveSubscriptionPlanType(normalizedPlanType);
    if (selectedPlanFilter !== 'all' && !SUBSCRIPTION_PLANS[selectedPlanFilter]) {
      return res.status(400).json({
        error: 'Invalid planType. Use one of: all, free, pro, ultimate, legend.',
      });
    }

    const tenantFilter = {};
    if (normalizedTenantId !== 'all') {
      tenantFilter._id = normalizedTenantId;
    }

    const tenants = await Tenant.find(tenantFilter)
      .select('name code status createdAt subscription')
      .sort({ name: 1 })
      .lean();

    const tenantIds = (Array.isArray(tenants) ? tenants : [])
      .map((tenant) => tenant?._id)
      .filter(Boolean);

    const planChangeLogs = tenantIds.length
      ? await AuditLog.find({
          action: AUDIT_ACTIONS.TENANT_UPDATED,
          tenantId: { $in: tenantIds },
          timestamp: { $lte: now },
        })
          .select('tenantId timestamp details')
          .sort({ tenantId: 1, timestamp: 1 })
          .lean()
      : [];

    const planChangesByTenant = new Map();
    (Array.isArray(planChangeLogs) ? planChangeLogs : []).forEach((entry) => {
      const tenantId = entry?.tenantId ? String(entry.tenantId) : '';
      if (!tenantId) return;
      const beforePlan = extractSubscriptionPlanTypeFromAuditDetails(entry?.details, 'before');
      const afterPlan = extractSubscriptionPlanTypeFromAuditDetails(entry?.details, 'after');
      if (!beforePlan && !afterPlan) return;

      if (!planChangesByTenant.has(tenantId)) {
        planChangesByTenant.set(tenantId, []);
      }

      planChangesByTenant.get(tenantId).push({
        timestamp: toValidDate(entry?.timestamp) || now,
        beforePlan: beforePlan || null,
        afterPlan: afterPlan || null,
      });
    });

    const earliestBillingDate = (Array.isArray(tenants) ? tenants : []).reduce(
      (earliest, tenant) => {
        const billingStart = getTenantBillingStartDate(tenant, now);
        if (!earliest) return billingStart;
        return billingStart < earliest ? billingStart : earliest;
      },
      null
    );

    const revenueWindow = buildRevenueWindow({
      range: normalizedRange,
      now,
      earliestBillingDate,
    });

    const trendBuckets = buildRevenueBuckets({
      start: revenueWindow.start,
      end: revenueWindow.end,
      interval: revenueWindow.interval,
    });

    const resolvePlanAtDate = (tenant, pointDate) => {
      const tenantId = tenant?._id ? String(tenant._id) : '';
      const defaultPlanType = resolveSubscriptionPlanType(
        tenant?.subscription?.planType || SUBSCRIPTION_PLAN_TYPES.FREE
      );
      const changes = planChangesByTenant.get(tenantId) || [];
      if (!changes.length) return defaultPlanType;

      const targetDate = toValidDate(pointDate) || now;
      const firstChange = changes[0];
      let resolvedPlan = firstChange?.beforePlan || defaultPlanType;

      for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        const changeTime = toValidDate(change?.timestamp);
        if (!changeTime) continue;
        if (targetDate >= changeTime) {
          if (change?.afterPlan) {
            resolvedPlan = resolveSubscriptionPlanType(change.afterPlan);
          }
        } else {
          break;
        }
      }

      return resolvedPlan || defaultPlanType;
    };

    const evaluateTenantAtDate = (tenant, pointDate, { applyPlanFilter = true } = {}) => {
      const safePointDate = toValidDate(pointDate) || now;
      const billingStart = getTenantBillingStartDate(tenant, now);
      if (safePointDate < billingStart) {
        return {
          planType: SUBSCRIPTION_PLAN_TYPES.FREE,
          monthlyPrice: 0,
          isPaid: false,
          matchesPlanFilter: selectedPlanFilter === 'all',
          billable: false,
        };
      }

      const subscription = normalizeOptionalObject(tenant?.subscription);
      const expiresAt = toValidDate(subscription.expiresAt);
      if (expiresAt && safePointDate > expiresAt) {
        return {
          planType: SUBSCRIPTION_PLAN_TYPES.FREE,
          monthlyPrice: 0,
          isPaid: false,
          matchesPlanFilter: selectedPlanFilter === 'all' || selectedPlanFilter === SUBSCRIPTION_PLAN_TYPES.FREE,
          billable: false,
        };
      }

      const historicalPlanType = resolvePlanAtDate(tenant, safePointDate);
      const statusAtDate = resolveSubscriptionStatus(subscription, safePointDate);
      const effectivePlanType = resolveEffectivePlanType(historicalPlanType, statusAtDate);
      const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
      const monthlyPrice = Number(planDefinition?.price) || 0;
      const isPaid = monthlyPrice > 0;
      const matchesPlanFilter =
        selectedPlanFilter === 'all' || effectivePlanType === selectedPlanFilter;

      return {
        planType: effectivePlanType,
        monthlyPrice,
        isPaid,
        matchesPlanFilter,
        billable: isPaid && (!applyPlanFilter || matchesPlanFilter),
      };
    };

    const computeRevenueAtPoint = (pointDate, { applyPlanFilter = true } = {}) => {
      let totalRevenue = 0;
      let paidTenants = 0;
      (Array.isArray(tenants) ? tenants : []).forEach((tenant) => {
        const snapshot = evaluateTenantAtDate(tenant, pointDate, { applyPlanFilter });
        if (!snapshot.billable) return;
        totalRevenue += snapshot.monthlyPrice;
        paidTenants += 1;
      });
      return { revenue: totalRevenue, paidTenants };
    };

    const trend = trendBuckets.map((bucket) => {
      const pointMetrics = computeRevenueAtPoint(bucket.pointDate);
      return {
        key: bucket.key,
        label: bucket.label,
        date: bucket.date,
        revenue: Number(pointMetrics.revenue.toFixed(2)),
        paid_tenants: pointMetrics.paidTenants,
      };
    });

    const currentSnapshotFiltered = computeRevenueAtPoint(now, { applyPlanFilter: true });
    const currentSnapshotAllPlans = computeRevenueAtPoint(now, { applyPlanFilter: false });

    const allTimeWindow = buildRevenueWindow({
      range: REVENUE_RANGE_TYPES.ALL_TIME,
      now,
      earliestBillingDate,
    });
    const allTimeBuckets = buildRevenueBuckets({
      start: allTimeWindow.start,
      end: allTimeWindow.end,
      interval: REVENUE_INTERVAL_TYPES.MONTHLY,
    });

    const totalRevenue = allTimeBuckets.reduce((total, bucket) => {
      const snapshot = computeRevenueAtPoint(bucket.pointDate);
      return total + snapshot.revenue;
    }, 0);

    const currentPeriodRevenue = trend.reduce(
      (total, row) => total + (Number(row?.revenue) || 0),
      0
    );

    let previousPeriodRevenue = 0;
    if (trendBuckets.length > 0) {
      const bucketCount = trendBuckets.length;
      const previousStart =
        revenueWindow.interval === REVENUE_INTERVAL_TYPES.DAILY
          ? startOfDay(addDays(revenueWindow.start, -bucketCount))
          : startOfMonth(addMonths(revenueWindow.start, -bucketCount));
      const previousEnd =
        revenueWindow.interval === REVENUE_INTERVAL_TYPES.DAILY
          ? endOfDay(addDays(previousStart, bucketCount - 1))
          : endOfMonth(addMonths(previousStart, bucketCount - 1));
      const previousBuckets = buildRevenueBuckets({
        start: previousStart,
        end: previousEnd,
        interval: revenueWindow.interval,
      });
      previousPeriodRevenue = previousBuckets.reduce((total, bucket) => {
        const snapshot = computeRevenueAtPoint(bucket.pointDate);
        return total + snapshot.revenue;
      }, 0);
    }

    const growthPercent =
      previousPeriodRevenue > 0
        ? ((currentPeriodRevenue - previousPeriodRevenue) / previousPeriodRevenue) * 100
        : currentPeriodRevenue > 0
          ? 100
          : 0;

    const paidTenantsCurrent = currentSnapshotAllPlans.paidTenants;
    const totalTenantCount = Array.isArray(tenants) ? tenants.length : 0;
    const freeTenantsCurrent = Math.max(0, totalTenantCount - paidTenantsCurrent);
    const conversionRate =
      totalTenantCount > 0 ? (paidTenantsCurrent / totalTenantCount) * 100 : 0;

    const planOrder = [
      SUBSCRIPTION_PLAN_TYPES.PRO,
      SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
      SUBSCRIPTION_PLAN_TYPES.LEGEND,
    ];
    const revenueByPlanAccumulator = new Map(
      planOrder.map((planType) => [planType, { revenue: 0, tenantCount: 0 }])
    );
    const revenueByTenant = [];

    (Array.isArray(tenants) ? tenants : []).forEach((tenant) => {
      const snapshot = evaluateTenantAtDate(tenant, now, { applyPlanFilter: false });
      if (!snapshot.isPaid) return;
      if (selectedPlanFilter !== 'all' && snapshot.planType !== selectedPlanFilter) return;

      const planEntry = revenueByPlanAccumulator.get(snapshot.planType) || {
        revenue: 0,
        tenantCount: 0,
      };
      planEntry.revenue += snapshot.monthlyPrice;
      planEntry.tenantCount += 1;
      revenueByPlanAccumulator.set(snapshot.planType, planEntry);

      revenueByTenant.push({
        tenant_id: tenant?._id ? String(tenant._id) : null,
        tenant_name: tenant?.name || 'Unknown Tenant',
        tenant_code: tenant?.code || 'N/A',
        plan_type: snapshot.planType,
        revenue: Number(snapshot.monthlyPrice.toFixed(2)),
      });
    });

    const revenueByPlan = planOrder
      .map((planType) => {
        const planDefinition = getSubscriptionPlanDefinition(planType);
        const aggregate = revenueByPlanAccumulator.get(planType) || {
          revenue: 0,
          tenantCount: 0,
        };
        return {
          plan_type: planType,
          plan_label: planDefinition?.label || String(planType || '').toUpperCase(),
          revenue: Number((aggregate.revenue || 0).toFixed(2)),
          tenant_count: Number(aggregate.tenantCount) || 0,
        };
      })
      .filter((row) => (selectedPlanFilter === 'all' ? true : row.plan_type === selectedPlanFilter));

    const topTenants = revenueByTenant
      .sort((left, right) => {
        const revenueDelta = (Number(right.revenue) || 0) - (Number(left.revenue) || 0);
        if (revenueDelta !== 0) return revenueDelta;
        return String(left.tenant_name || '').localeCompare(String(right.tenant_name || ''));
      })
      .slice(0, 5);

    const oneTimeRevenue = Array.from(planChangesByTenant.values()).reduce(
      (total, tenantChanges) => {
        return total + tenantChanges.reduce((tenantTotal, change) => {
          const changeTime = toValidDate(change?.timestamp);
          if (!changeTime) return tenantTotal;
          if (changeTime < revenueWindow.start || changeTime > revenueWindow.end) {
            return tenantTotal;
          }

          const beforePlanType = resolveSubscriptionPlanType(
            change?.beforePlan || SUBSCRIPTION_PLAN_TYPES.FREE
          );
          const afterPlanType = resolveSubscriptionPlanType(
            change?.afterPlan || beforePlanType
          );
          if (selectedPlanFilter !== 'all' && afterPlanType !== selectedPlanFilter) {
            return tenantTotal;
          }

          const beforePrice =
            Number(getSubscriptionPlanDefinition(beforePlanType)?.price) || 0;
          const afterPrice = Number(getSubscriptionPlanDefinition(afterPlanType)?.price) || 0;
          const delta = afterPrice - beforePrice;
          if (delta <= 0) return tenantTotal;

          return tenantTotal + delta;
        }, 0);
      },
      0
    );

    const recurringVsOneTime = [
      {
        type: 'Recurring',
        revenue: Number(currentSnapshotFiltered.revenue.toFixed(2)),
      },
      {
        type: 'One-time',
        revenue: Number(oneTimeRevenue.toFixed(2)),
      },
    ];

    const topPlan = [...revenueByPlan].sort((left, right) => right.revenue - left.revenue)[0];
    const topTenant = topTenants[0] || null;
    const currentRecurringRevenue = Number(currentSnapshotFiltered.revenue) || 0;
    const topPlanContributionPercent =
      topPlan && currentRecurringRevenue > 0
        ? (Number(topPlan.revenue) / currentRecurringRevenue) * 100
        : 0;
    const insights = [];

    if (Math.abs(growthPercent) >= 0.01) {
      insights.push(
        growthPercent >= 0
          ? `Revenue increased by ${Number(growthPercent.toFixed(2))}% compared to the previous period.`
          : `Revenue decreased by ${Number(Math.abs(growthPercent).toFixed(2))}% compared to the previous period.`
      );
    } else {
      insights.push('Revenue is stable compared to the previous period.');
    }

    if (topPlan && topPlan.revenue > 0) {
      insights.push(
        `${topPlan.plan_label} contributes ${Number(topPlanContributionPercent.toFixed(2))}% of current recurring revenue.`
      );
    }

    if (topTenant && Number(topTenant.revenue) > 0) {
      insights.push(`Top tenant: ${topTenant.tenant_name}.`);
    }

    const hasData =
      trend.some((row) => Number(row?.revenue) > 0) ||
      revenueByPlan.some((row) => Number(row?.revenue) > 0) ||
      topTenants.some((row) => Number(row?.revenue) > 0);

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
    });

    res.json({
      summary: {
        total_revenue: Number(totalRevenue.toFixed(2)),
        monthly_revenue: Number(currentSnapshotFiltered.revenue.toFixed(2)),
        current_period_revenue: Number(currentPeriodRevenue.toFixed(2)),
        previous_period_revenue: Number(previousPeriodRevenue.toFixed(2)),
        growth_percent: Number(growthPercent.toFixed(2)),
        paid_tenants: paidTenantsCurrent,
        free_tenants: freeTenantsCurrent,
        conversion_rate: Number(conversionRate.toFixed(2)),
        recurring_revenue: Number(currentSnapshotFiltered.revenue.toFixed(2)),
        one_time_revenue: Number(oneTimeRevenue.toFixed(2)),
      },
      trend,
      revenue_by_plan: revenueByPlan,
      revenue_by_tenant: topTenants,
      recurring_vs_one_time: recurringVsOneTime,
      insights,
      filters: {
        range: normalizedRange,
        tenantId: normalizedTenantId,
        planType: selectedPlanFilter,
        interval: revenueWindow.interval,
        startDate: revenueWindow.start.toISOString(),
        endDate: revenueWindow.end.toISOString(),
      },
      available_filters: {
        tenants: (Array.isArray(tenants) ? tenants : []).map((tenant) => ({
          id: tenant?._id ? String(tenant._id) : null,
          name: tenant?.name || 'Unknown Tenant',
          code: tenant?.code || 'N/A',
        })),
        plan_types: [
          SUBSCRIPTION_PLAN_TYPES.FREE,
          SUBSCRIPTION_PLAN_TYPES.PRO,
          SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
          SUBSCRIPTION_PLAN_TYPES.LEGEND,
        ],
      },
      currency: {
        code: 'INR',
        locale: 'en-IN',
        symbol: '₹',
      },
      meta: {
        generatedAt: now.toISOString(),
        hasData,
        tenantCount: totalTenantCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * CHANGE TENANT SUBSCRIPTION PLAN
 * PUT /api/super-admin/subscriptions/tenants/:tenantId
 */
router.put(
  '/subscriptions/tenants/:tenantId',
  [
    body('planType').optional().isString().withMessage('planType must be a string'),
    body('startedAt')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('startedAt must be a valid date');
        }
        return true;
      }),
    body('planStartDate')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('planStartDate must be a valid date');
        }
        return true;
      }),
    body('expiresAt')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('expiresAt must be a valid date');
        }
        return true;
      }),
    body('planExpiryDate')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('planExpiryDate must be a valid date');
        }
        return true;
      }),
    body('status')
      .optional()
      .isIn(SUBSCRIPTION_STATUS_VALUES)
      .withMessage('status must be one of ACTIVE, EXPIRED, or SUSPENDED'),
    body('subscriptionStatus')
      .optional()
      .isIn(SUBSCRIPTION_STATUS_VALUES)
      .withMessage('subscriptionStatus must be one of ACTIVE, EXPIRED, or SUSPENDED'),
    body('expireNow').optional().isBoolean().withMessage('expireNow must be a boolean'),
    body('resetUsage').optional().isBoolean().withMessage('resetUsage must be a boolean'),
    body('customLimits')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('customLimits must be an object');
        }
        const invalidKey = LEGEND_CUSTOM_LIMIT_KEYS.find(
          (key) => hasOwn(value, key) && !isValidLimitInput(value[key])
        );
        if (invalidKey) {
          throw new Error(`${invalidKey} must be a non-negative number or null`);
        }
        return true;
      }),
    body('customFeatures')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('customFeatures must be an object');
        }
        return true;
      }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const tenantId = req.params.tenantId;
      if (!isValidMongoId(tenantId)) {
        return res.status(400).json({ error: 'Invalid tenantId' });
      }

      const tenant = await Tenant.findById(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const previousSubscription = tenant.subscription || {};
      const previousPlanType = resolveSubscriptionPlanType(
        previousSubscription.planType || SUBSCRIPTION_PLAN_TYPES.FREE
      );

      const hasPlanTypePayload =
        hasOwn(req.body, 'planType') && String(req.body.planType || '').trim() !== '';
      const normalizedPlanType = hasPlanTypePayload
        ? resolveSubscriptionPlanType(req.body.planType)
        : previousPlanType;
      if (!SUBSCRIPTION_PLANS[normalizedPlanType]) {
        return res.status(400).json({
          error: 'Invalid planType. Use one of: free, pro, ultimate, legend.',
        });
      }

      const now = new Date();
      const hasStartDatePayload = hasOwn(req.body, 'planStartDate') || hasOwn(req.body, 'startedAt');
      const rawStartDate = hasOwn(req.body, 'planStartDate')
        ? req.body.planStartDate
        : req.body.startedAt;
      let startedAt = previousSubscription.startedAt || null;
      if (hasStartDatePayload) {
        if (rawStartDate === null || rawStartDate === '') {
          startedAt = null;
        } else {
          const parsedStartedAt = new Date(rawStartDate);
          if (Number.isNaN(parsedStartedAt.getTime())) {
            return res.status(400).json({ error: 'planStartDate must be a valid date' });
          }
          startedAt = parsedStartedAt;
        }
      }

      if (!startedAt || Number.isNaN(new Date(startedAt).getTime())) {
        startedAt = now;
      }

      if (normalizedPlanType !== previousPlanType && !hasStartDatePayload) {
        startedAt = now;
      }

      const expireNowRequested = Boolean(req.body?.expireNow);
      const hasExpiryPayload = hasOwn(req.body, 'planExpiryDate') || hasOwn(req.body, 'expiresAt');
      const rawExpiryDate = hasOwn(req.body, 'planExpiryDate')
        ? req.body.planExpiryDate
        : req.body.expiresAt;
      let expiresAt = previousSubscription.expiresAt || null;

      if (expireNowRequested) {
        expiresAt = now;
      } else if (hasExpiryPayload) {
        if (rawExpiryDate === null || rawExpiryDate === '') {
          expiresAt = null;
        } else {
          const parsedExpiresAt = new Date(rawExpiryDate);
          if (Number.isNaN(parsedExpiresAt.getTime())) {
            return res.status(400).json({ error: 'planExpiryDate must be a valid date' });
          }
          expiresAt = parsedExpiresAt;
        }
      } else if (normalizedPlanType !== previousPlanType) {
        expiresAt = calculateDefaultSubscriptionExpiryDate(normalizedPlanType, startedAt);
      }

      const statusInputRaw = hasOwn(req.body, 'subscriptionStatus')
        ? req.body.subscriptionStatus
        : req.body.status;
      const hasStatusPayload = hasOwn(req.body, 'subscriptionStatus') || hasOwn(req.body, 'status');
      const normalizedStatusInput = normalizeSubscriptionStatusInput(statusInputRaw);
      if (hasStatusPayload && !normalizedStatusInput) {
        return res.status(400).json({
          error: 'subscriptionStatus must be one of ACTIVE, EXPIRED, or SUSPENDED',
        });
      }

      let requestedStatus =
        normalizedStatusInput ||
        normalizeSubscriptionStatusInput(previousSubscription.status) ||
        SUBSCRIPTION_STATUSES.ACTIVE;

      if (expireNowRequested) {
        requestedStatus = SUBSCRIPTION_STATUSES.EXPIRED;
      }

      if (requestedStatus === SUBSCRIPTION_STATUSES.EXPIRED && !expiresAt) {
        expiresAt = now;
      }

      const resetUsageRequested =
        typeof req.body.resetUsage === 'boolean' ? req.body.resetUsage : null;
      const shouldResetUsage =
        resetUsageRequested !== null
          ? resetUsageRequested
          : normalizedPlanType !== previousPlanType;

      const hasCustomLimitsPayload = hasOwn(req.body, 'customLimits');
      const hasCustomFeaturesPayload = hasOwn(req.body, 'customFeatures');
      const previousCustomLimits = normalizeOptionalObject(previousSubscription.customLimits);
      const previousCustomFeatures = normalizeOptionalObject(previousSubscription.customFeatures);
      const nextCustomLimits = hasCustomLimitsPayload
        ? {
            ...previousCustomLimits,
            ...extractLegendCustomLimits(req.body.customLimits),
          }
        : previousCustomLimits;
      const nextCustomFeatures = hasCustomFeaturesPayload
        ? {
            ...previousCustomFeatures,
            ...extractFeatureOverrides(req.body.customFeatures),
          }
        : previousCustomFeatures;

      const nextSubscription = {
        ...previousSubscription,
        planType: normalizedPlanType,
        startedAt,
        expiresAt,
        usageResetAt: shouldResetUsage ? now : previousSubscription.usageResetAt || null,
        customLimits: nextCustomLimits,
        customFeatures: nextCustomFeatures,
        updatedAt: now,
      };

      nextSubscription.status = resolveSubscriptionStatus({
        ...nextSubscription,
        status: requestedStatus,
      }, now);

      if (normalizedPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND) {
        const legendLimits = resolveLegendEffectiveLimits({
          planType: normalizedPlanType,
          tenant: {
            ...(tenant.toObject ? tenant.toObject() : tenant),
            subscription: nextSubscription,
          },
          baseLimits: getSubscriptionPlanDefinition(normalizedPlanType)?.limits || {},
        });
        tenant.examLimit = legendLimits.maxExamsPerMonth;
        tenant.attemptLimit = legendLimits.maxAttemptsPerMonth;
        tenant.aiUsageLimit = legendLimits.maxAiQuestionsPerMonth;
      }

      tenant.subscription = nextSubscription;
      await tenant.save();

      await User.updateMany(
        { tenantId: tenant._id, role: { $ne: 'SUPER_ADMIN' } },
        { $set: { planType: normalizedPlanType } }
      );

      await logAuditEvent(AUDIT_ACTIONS.TENANT_UPDATED, {
        ...buildActorAuditDetails(req),
        tenantId: tenant._id,
        tenantName: tenant.name,
        resourceType: 'Tenant',
        resourceId: tenant._id,
        details: {
          before: {
            planType: previousPlanType,
            startedAt: previousSubscription.startedAt || null,
            expiresAt: previousSubscription.expiresAt || null,
            status: previousSubscription.status || null,
            customLimits: previousCustomLimits,
            customFeatures: previousCustomFeatures,
          },
          after: {
            planType: normalizedPlanType,
            startedAt: nextSubscription.startedAt || null,
            expiresAt: nextSubscription.expiresAt || null,
            status: nextSubscription.status,
            customLimits: nextCustomLimits,
            customFeatures: nextCustomFeatures,
          },
          resetUsage: shouldResetUsage,
        },
      });

      const summary = await buildTenantSubscriptionSummary(
        tenant.toObject ? tenant.toObject() : tenant
      );

      res.json({ tenant: summary });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * TENANT FEATURE MANAGEMENT SNAPSHOT
 * GET /api/super-admin/tenants/:tenantId/features
 */
router.get('/tenants/:tenantId/features', async (req, res, next) => {
  try {
    const tenantId = req.params.tenantId;
    if (!isValidMongoId(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }

    const tenant = await Tenant.findById(tenantId).select(
      'name code subscription examLimit attemptLimit aiUsageLimit updatedAt'
    );
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantFeatures = buildTenantFeaturePayload(tenant);
    return res.json({ tenantFeatures });
  } catch (error) {
    return next(error);
  }
});

/**
 * TENANT FEATURE MANAGEMENT UPDATE
 * PUT /api/super-admin/tenants/:tenantId/features
 */
router.put('/tenants/:tenantId/features', async (req, res, next) => {
  try {
    const tenantId = req.params.tenantId;
    if (!isValidMongoId(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const incomingMain = normalizeOptionalObject(req.body?.main);
    const incomingAddons = normalizeOptionalObject(req.body?.addons);
    if (Object.keys(incomingMain).length === 0 && Object.keys(incomingAddons).length === 0) {
      return res.status(400).json({
        error: 'No feature updates provided. Include main and/or addons payload.',
      });
    }

    const validationErrors = [];
    Object.entries(incomingMain).forEach(([featureKey, patch]) => {
      const definition = MAIN_FEATURE_DEFINITIONS[featureKey];
      if (!definition) {
        validationErrors.push(`Unknown main feature: ${featureKey}`);
        return;
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        validationErrors.push(`main.${featureKey} must be an object`);
        return;
      }
      if (hasOwn(patch, 'overrideEnabled') && typeof patch.overrideEnabled !== 'boolean') {
        validationErrors.push(`main.${featureKey}.overrideEnabled must be a boolean`);
      }
      if (hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
        validationErrors.push(`main.${featureKey}.enabled must be a boolean`);
      }
    });

    Object.entries(incomingAddons).forEach(([featureKey, value]) => {
      const definition = ADDON_FEATURE_DEFINITIONS[featureKey];
      if (!definition) {
        validationErrors.push(`Unknown addon feature: ${featureKey}`);
        return;
      }
      if (typeof value !== 'boolean') {
        validationErrors.push(`addons.${featureKey} must be a boolean`);
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Invalid feature payload', details: validationErrors });
    }

    const tenantObject = tenant.toObject ? tenant.toObject() : tenant;
    const subscription = normalizeOptionalObject(tenantObject?.subscription);
    const assignedPlanType = resolveSubscriptionPlanType(
      subscription.planType || SUBSCRIPTION_PLAN_TYPES.FREE
    );
    const subscriptionStatus = resolveSubscriptionStatus(subscription);
    const effectivePlanType = resolveEffectivePlanType(assignedPlanType, subscriptionStatus);
    const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
    const planFeatures = normalizeOptionalObject(planDefinition?.features);
    const effectivePlanLimits = resolveLegendEffectiveLimits({
      planType: effectivePlanType,
      tenant: tenantObject,
      baseLimits: normalizeOptionalObject(planDefinition?.limits),
    });

    const previousCustomLimits = normalizeOptionalObject(subscription.customLimits);
    const previousCustomFeatures = normalizeOptionalObject(subscription.customFeatures);
    const nextCustomLimits = { ...previousCustomLimits };
    const nextCustomFeatures = { ...previousCustomFeatures };

    Object.entries(incomingMain).forEach(([featureKey, patch]) => {
      const definition = MAIN_FEATURE_DEFINITIONS[featureKey];
      const overrideProvided = hasOwn(patch, 'overrideEnabled');
      const enabledProvided = hasOwn(patch, 'enabled');

      if (definition.type === 'limit') {
        const limitKey = definition.limitKey;
        const currentlyOverride = hasOwn(nextCustomLimits, limitKey);
        const overrideEnabled = overrideProvided ? Boolean(patch.overrideEnabled) : currentlyOverride;

        if (!overrideEnabled) {
          delete nextCustomLimits[limitKey];
          return;
        }

        const planDefaultValue = parseOptionalLimitValue(effectivePlanLimits?.[limitKey]);
        if (enabledProvided) {
          if (patch.enabled) {
            const currentOverrideValue = currentlyOverride
              ? parseOptionalLimitValue(nextCustomLimits[limitKey])
              : null;
            const nextValue =
              currentOverrideValue !== null && currentOverrideValue > 0
                ? currentOverrideValue
                : planDefaultValue;
            nextCustomLimits[limitKey] = nextValue;
            return;
          }
          nextCustomLimits[limitKey] = 0;
          return;
        }

        if (!currentlyOverride) {
          nextCustomLimits[limitKey] = planDefaultValue;
        }
        return;
      }

      const customFeatureKey = definition.customFeatureKey;
      const currentlyOverride =
        hasOwn(nextCustomFeatures, customFeatureKey) &&
        typeof nextCustomFeatures[customFeatureKey] === 'boolean';
      const overrideEnabled = overrideProvided ? Boolean(patch.overrideEnabled) : currentlyOverride;

      if (!overrideEnabled) {
        delete nextCustomFeatures[customFeatureKey];
        return;
      }

      const planDefaultValue = resolvePlanMainBooleanValue(definition, planFeatures);
      const currentValue = currentlyOverride
        ? Boolean(nextCustomFeatures[customFeatureKey])
        : planDefaultValue;
      nextCustomFeatures[customFeatureKey] = enabledProvided
        ? Boolean(patch.enabled)
        : currentValue;
    });

    Object.entries(incomingAddons).forEach(([featureKey, enabled]) => {
      const definition = ADDON_FEATURE_DEFINITIONS[featureKey];
      nextCustomFeatures[definition.customFeatureKey] = Boolean(enabled);
    });

    tenant.subscription = tenant.subscription || {};
    tenant.subscription.customLimits = nextCustomLimits;
    tenant.subscription.customFeatures = nextCustomFeatures;
    tenant.subscription.updatedAt = new Date();

    const currentPlanType = resolveSubscriptionPlanType(
      tenant?.subscription?.planType || SUBSCRIPTION_PLAN_TYPES.FREE
    );
    if (currentPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND) {
      const legendLimits = resolveLegendEffectiveLimits({
        planType: currentPlanType,
        tenant: tenant.toObject ? tenant.toObject() : tenant,
        baseLimits: getSubscriptionPlanDefinition(currentPlanType)?.limits || {},
      });
      tenant.examLimit = legendLimits.maxExamsPerMonth;
      tenant.attemptLimit = legendLimits.maxAttemptsPerMonth;
      tenant.aiUsageLimit = legendLimits.maxAiQuestionsPerMonth;
    }

    await tenant.save();

    await logAuditEvent(AUDIT_ACTIONS.TENANT_UPDATED, {
      ...buildActorAuditDetails(req),
      tenantId: tenant._id,
      tenantName: tenant.name,
      resourceType: 'Tenant',
      resourceId: tenant._id,
      details: {
        type: 'FEATURE_MANAGEMENT',
        before: {
          customLimits: previousCustomLimits,
          customFeatures: previousCustomFeatures,
        },
        after: {
          customLimits: nextCustomLimits,
          customFeatures: nextCustomFeatures,
        },
      },
    });

    const tenantFeatures = buildTenantFeaturePayload(tenant);
    return res.json({ tenantFeatures });
  } catch (error) {
    return next(error);
  }
});

/**
 * SUPER ADMIN DASHBOARD STATS
 * GET /api/super-admin/stats
 */
router.get('/stats', async (req, res, next) => {
  try {
    // Calculate today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [
      totalTenants,
      activeTenants,
      totalExams,
      totalExamAttempts,
      todayAttempts,
    ] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ status: 'ACTIVE' }),
      Exam.countDocuments(),
      ExamAttempt.countDocuments(),
      ExamAttempt.countDocuments({
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
    ]);

    // Get recent tenants (last 5, ordered by updatedAt)
    const recentTenants = await Tenant.find()
      .select('name code status updatedAt')
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();

    // Get recent exams (last 5, ordered by createdAt)
    const recentExams = await Exam.find()
      .select('title tenantId isActive createdAt')
      .populate('tenantId', 'name code')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const latestSystemAlerts = await SystemAlert.find({})
      .select('title message severity category created_at')
      .sort({ created_at: -1 })
      .limit(5)
      .lean();

    const systemAlerts = (Array.isArray(latestSystemAlerts) ? latestSystemAlerts : []).map(
      (alert) => {
        const normalizedSeverity = String(alert?.severity || 'info').toLowerCase();
        return {
          type: alert?.category || 'system',
          message: alert?.message || alert?.title || '',
          severity:
            normalizedSeverity === 'critical'
              ? 'high'
              : normalizedSeverity === 'warning'
                ? 'medium'
                : 'low',
          createdAt: alert?.created_at || null,
        };
      }
    );

    res.json({
      tenants: {
        total: totalTenants,
        active: activeTenants,
      },
      exams: {
        total: totalExams,
      },
      attempts: {
        total: totalExamAttempts,
        todayAttempts,
      },
      recentTenants: recentTenants.map(t => ({
        _id: t._id,
        name: t.name,
        code: t.code,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
      recentExams: recentExams.map(e => ({
        _id: e._id,
        title: e.title,
        tenantId: e.tenantId?._id || e.tenantId,
        tenantName: e.tenantId?.name || 'N/A',
        isActive: e.isActive,
        createdAt: e.createdAt,
      })),
      systemAlerts,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * SUPER ADMIN AI USAGE ANALYTICS
 * GET /api/super-admin/ai-usage
 * Optional query params:
 * - range: 24h | 7d | 30d | lifetime
 * - model: all | <configured model>
 * - period: daily | monthly (legacy compatibility)
 * - startDate: YYYY-MM-DD or ISO date
 * - endDate: YYYY-MM-DD or ISO date
 */
router.get('/ai-usage', async (req, res, next) => {
  try {
    const now = new Date();
    const { range, period, startDate, endDate, model } = req.query;
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
    });

    const normalizeRange = (value) => String(value || '').trim().toLowerCase();
    const normalizePeriod = (value) => String(value || '').trim().toLowerCase();
    const normalizeModel = (value) => normalizeModelName(value);
    const normalizedRange = normalizeRange(range);
    const normalizedPeriod = normalizePeriod(period);
    const normalizedModel = normalizeModel(model);

    const configuredModel = normalizeModelName(config.openaiModel) || 'gpt-4o-mini';
    const allowedModels = new Set([
      configuredModel,
      ...Object.keys(MODEL_PRICING_REFERENCE || {}).map((modelName) =>
        normalizeModelName(modelName)
      ),
    ]);
    let resolvedModel = 'all';
    if (normalizedModel && normalizedModel !== 'all') {
      if (!allowedModels.has(normalizedModel)) {
        const allowedModelList = Array.from(allowedModels).filter(Boolean).sort().join(', ');
        return res.status(400).json({
          error: `Invalid model. Use one of: all, ${allowedModelList}.`,
        });
      }
      resolvedModel = normalizedModel;
    }

    let resolvedRange = normalizedRange;
    if (!resolvedRange) {
      // Backward compatibility for existing clients.
      if (normalizedPeriod === 'daily') {
        resolvedRange = '24h';
      } else if (normalizedPeriod === 'monthly') {
        resolvedRange = '30d';
      } else {
        resolvedRange = 'lifetime';
      }
    }

    let rangeStart = null;
    let rangeEnd = null;

    if (resolvedRange === '24h') {
      rangeStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      rangeEnd = now;
    } else if (resolvedRange === '7d') {
      rangeStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      rangeEnd = now;
    } else if (resolvedRange === '30d') {
      rangeStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      rangeEnd = now;
    } else if (resolvedRange === 'lifetime') {
      rangeStart = null;
      rangeEnd = null;
    } else {
      return res.status(400).json({
        error: 'Invalid range. Use one of: 24h, 7d, 30d, lifetime.',
      });
    }

    if (startDate) {
      const parsedStart = new Date(startDate);
      if (Number.isNaN(parsedStart.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate. Use YYYY-MM-DD or ISO date format.' });
      }
      rangeStart = parsedStart;
    }

    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (Number.isNaN(parsedEnd.getTime())) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD or ISO date format.' });
      }

      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate).trim());
      if (isDateOnly) {
        parsedEnd.setHours(23, 59, 59, 999);
      }
      rangeEnd = parsedEnd;

      if (rangeStart) {
        resolvedRange = 'custom';
      }
    }

    if (startDate && !endDate) {
      rangeEnd = now;
      resolvedRange = 'custom';
    }

    if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
      return res.status(400).json({ error: 'startDate must be earlier than or equal to endDate.' });
    }

    const buildCreatedAtMatch = ({ start, end }) => {
      const match = {};
      if (start || end) {
        match.created_at = {};
        if (start) {
          match.created_at.$gte = start;
        }
        if (end) {
          match.created_at.$lte = end;
        }
      }
      return match;
    };

    const buildUsageMatch = ({ start, end }) => {
      const match = buildCreatedAtMatch({ start, end });
      if (resolvedModel !== 'all') {
        match.$expr = {
          $eq: [
            getMongoNormalizedModelExpression({ modelField: '$model' }),
            resolvedModel,
          ],
        };
      }
      return match;
    };

    const selectedRangeMatch = buildUsageMatch({ start: rangeStart, end: rangeEnd });

    const toNonNegativeDoubleExpression = (input, fallback = 0) => ({
      $let: {
        vars: {
          parsedValue: {
            $convert: {
              input,
              to: 'double',
              onError: fallback,
              onNull: fallback,
            },
          },
        },
        in: {
          $cond: [{ $gt: ['$$parsedValue', 0] }, '$$parsedValue', 0],
        },
      },
    });

    const usageCountExpression = {
      $let: {
        vars: {
          parsedValue: {
            $convert: {
              input: '$usage_count',
              to: 'double',
              onError: 1,
              onNull: 1,
            },
          },
        },
        in: {
          $cond: [
            { $gte: ['$$parsedValue', 1] },
            { $max: [1, { $floor: '$$parsedValue' }] },
            1,
          ],
        },
      },
    };

    const requestStatusExpression = {
      $let: {
        vars: {
          statusValue: {
            $toUpper: {
              $trim: {
                input: { $ifNull: ['$request_status', 'SUCCESS'] },
              },
            },
          },
        },
        in: {
          $cond: [{ $eq: ['$$statusValue', 'FAILED'] }, 'FAILED', 'SUCCESS'],
        },
      },
    };

    const featureExpression = {
      $let: {
        vars: {
          featureValue: {
            $trim: {
              input: {
                $ifNull: ['$feature_type', { $ifNull: ['$feature', ''] }],
              },
            },
          },
        },
        in: {
          $cond: [
            { $eq: ['$$featureValue', ''] },
            'unknown',
            { $toLower: '$$featureValue' },
          ],
        },
      },
    };

    const tenantIdExpression = {
      $let: {
        vars: {
          rawTenantId: {
            $ifNull: ['$tenant_id', '$tenantId'],
          },
        },
        in: {
          $let: {
            vars: {
              normalizedTenantId: {
                $trim: {
                  input: {
                    $convert: {
                      input: '$$rawTenantId',
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
            },
            in: {
              $cond: [
                { $eq: ['$$normalizedTenantId', ''] },
                null,
                '$$normalizedTenantId',
              ],
            },
          },
        },
      },
    };

    const promptTokensExpression = toNonNegativeDoubleExpression('$prompt_tokens');
    const completionTokensExpression = toNonNegativeDoubleExpression('$completion_tokens');
    const totalTokensExpression = {
      $let: {
        vars: {
          totalTokenValue: toNonNegativeDoubleExpression('$total_tokens'),
          fallbackTokenValue: toNonNegativeDoubleExpression('$tokens_used'),
        },
        in: {
          $cond: [
            { $gt: ['$$totalTokenValue', 0] },
            '$$totalTokenValue',
            '$$fallbackTokenValue',
          ],
        },
      },
    };

    const costExpression = {
      $max: [
        0,
        getMongoEstimatedCostExpression({
          promptTokensField: promptTokensExpression,
          completionTokensField: completionTokensExpression,
          totalTokensField: totalTokensExpression,
        }),
      ],
    };

    const aggregateTokenTotals = async (match = {}) => {
      const [totals] = await AITokenUsage.aggregate([
        ...(Object.keys(match).length ? [{ $match: match }] : []),
        {
          $group: {
            _id: null,
            prompt_tokens: { $sum: promptTokensExpression },
            completion_tokens: { $sum: completionTokensExpression },
            total_tokens: { $sum: totalTokensExpression },
            request_count: { $sum: usageCountExpression },
            failed_requests: {
              $sum: {
                $cond: [{ $eq: [requestStatusExpression, 'FAILED'] }, usageCountExpression, 0],
              },
            },
            success_requests: {
              $sum: {
                $cond: [{ $ne: [requestStatusExpression, 'FAILED'] }, usageCountExpression, 0],
              },
            },
            total_cost_usd: { $sum: costExpression },
          },
        },
      ]);

      return (
        totals || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          request_count: 0,
          failed_requests: 0,
          success_requests: 0,
          total_cost_usd: 0,
        }
      );
    };

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [selectedTotals, todayTotals, monthTotals, lifetimeTotals, trendDailyRaw, featureUsageRaw, modelUsageRaw, tenantUsageRaw, tenants] =
      await Promise.all([
        aggregateTokenTotals(selectedRangeMatch),
        aggregateTokenTotals(buildUsageMatch({ start: startOfToday, end: now })),
        aggregateTokenTotals(buildUsageMatch({ start: startOfMonth, end: now })),
        aggregateTokenTotals(buildUsageMatch({})),
        AITokenUsage.aggregate([
          ...(Object.keys(selectedRangeMatch).length ? [{ $match: selectedRangeMatch }] : []),
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$created_at',
                },
              },
              total_tokens: { $sum: totalTokensExpression },
              total_requests: { $sum: usageCountExpression },
              total_cost_usd: { $sum: costExpression },
            },
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              date: '$_id',
              total_tokens: 1,
              total_requests: 1,
              total_cost_usd: 1,
            },
          },
        ]),
        AITokenUsage.aggregate([
          ...(Object.keys(selectedRangeMatch).length ? [{ $match: selectedRangeMatch }] : []),
          {
            $group: {
              _id: featureExpression,
              total_tokens: { $sum: totalTokensExpression },
              request_count: { $sum: usageCountExpression },
              total_cost_usd: { $sum: costExpression },
            },
          },
          { $sort: { request_count: -1, total_tokens: -1, _id: 1 } },
          {
            $project: {
              _id: 0,
              feature: '$_id',
              total_tokens: 1,
              request_count: 1,
              total_cost_usd: 1,
            },
          },
        ]),
        AITokenUsage.aggregate([
          ...(Object.keys(selectedRangeMatch).length ? [{ $match: selectedRangeMatch }] : []),
          {
            $group: {
              _id: getMongoNormalizedModelExpression({ modelField: '$model' }),
              total_tokens: { $sum: totalTokensExpression },
              request_count: { $sum: usageCountExpression },
              total_cost_usd: { $sum: costExpression },
            },
          },
          { $sort: { request_count: -1, total_tokens: -1, _id: 1 } },
          {
            $project: {
              _id: 0,
              model: '$_id',
              total_tokens: 1,
              request_count: 1,
              total_cost_usd: 1,
            },
          },
        ]),
        AITokenUsage.aggregate([
          ...(Object.keys(selectedRangeMatch).length ? [{ $match: selectedRangeMatch }] : []),
          {
            $group: {
              _id: tenantIdExpression,
              prompt_tokens: { $sum: promptTokensExpression },
              completion_tokens: { $sum: completionTokensExpression },
              total_tokens: { $sum: totalTokensExpression },
              request_count: { $sum: usageCountExpression },
              failed_requests: {
                $sum: {
                  $cond: [{ $eq: [requestStatusExpression, 'FAILED'] }, usageCountExpression, 0],
                },
              },
              success_requests: {
                $sum: {
                  $cond: [{ $ne: [requestStatusExpression, 'FAILED'] }, usageCountExpression, 0],
                },
              },
              total_cost_usd: { $sum: costExpression },
              last_used: { $max: '$created_at' },
            },
          },
          { $sort: { request_count: -1, total_tokens: -1 } },
        ]),
        Tenant.find({}).select('_id name code').sort({ name: 1 }).lean(),
      ]);

    const ensureCurrencyFields = (row) => ({
      ...row,
      total_cost_usd: Number(row?.total_cost_usd) || 0,
      total_cost_inr: usdToInr(row?.total_cost_usd),
    });

    const trendMap = new Map(
      (Array.isArray(trendDailyRaw) ? trendDailyRaw : []).map((row) => [
        row.date,
        ensureCurrencyFields({
          date: row.date,
          total_tokens: Number(row.total_tokens) || 0,
          total_requests: Number(row.total_requests) || 0,
          total_cost_usd: Number(row.total_cost_usd) || 0,
        }),
      ])
    );

    let trendDaily = Array.from(trendMap.values());
    if (
      ['24h', '7d', '30d'].includes(resolvedRange) &&
      rangeStart &&
      rangeEnd
    ) {
      const filled = [];
      const startDay = new Date(rangeStart);
      startDay.setHours(0, 0, 0, 0);
      const endDay = new Date(rangeEnd);
      endDay.setHours(0, 0, 0, 0);

      for (let cursor = new Date(startDay); cursor <= endDay; cursor.setDate(cursor.getDate() + 1)) {
        const key = cursor.toISOString().slice(0, 10);
        filled.push(
          trendMap.get(key) ||
            ensureCurrencyFields({
              date: key,
              total_tokens: 0,
              total_requests: 0,
              total_cost_usd: 0,
            })
        );
      }
      trendDaily = filled;
    }

    const selectedRangeTotalRequests = Number(selectedTotals.request_count) || 0;
    const hasSingleFeature =
      Array.isArray(featureUsageRaw) &&
      featureUsageRaw.length === 1 &&
      selectedRangeTotalRequests > 0;
    const usageByFeature = (Array.isArray(featureUsageRaw) ? featureUsageRaw : []).map((row) => {
      const featureTokens = Number(row.total_tokens) || 0;
      const featureRequests = Number(row.request_count) || 0;
      const rawPercent = hasSingleFeature
        ? 100
        : selectedRangeTotalRequests > 0
          ? (featureRequests / selectedRangeTotalRequests) * 100
          : 0;
      const normalizedPercent = Number(rawPercent.toFixed(2));

      return ensureCurrencyFields({
        feature: row.feature || 'unknown',
        tokens: featureTokens,
        total_tokens: featureTokens,
        request_count: featureRequests,
        total_cost_usd: Number(row.total_cost_usd) || 0,
        percentage: normalizedPercent,
        percent: normalizedPercent,
      });
    });

    const usageByModel = (Array.isArray(modelUsageRaw) ? modelUsageRaw : []).map((row) =>
      ensureCurrencyFields({
        model: row.model || 'unknown',
        total_tokens: Number(row.total_tokens) || 0,
        request_count: Number(row.request_count) || 0,
        total_cost_usd: Number(row.total_cost_usd) || 0,
      })
    );

    const usageByTenantId = new Map(
      (Array.isArray(tenantUsageRaw) ? tenantUsageRaw : []).map((row) => [
        row?._id ? String(row._id) : '',
        {
          prompt_tokens: Number(row?.prompt_tokens) || 0,
          completion_tokens: Number(row?.completion_tokens) || 0,
          total_tokens: Number(row?.total_tokens) || 0,
          request_count: Number(row?.request_count) || 0,
          failed_requests: Number(row?.failed_requests) || 0,
          success_requests: Number(row?.success_requests) || 0,
          total_cost_usd: Number(row?.total_cost_usd) || 0,
          last_used: row?.last_used || null,
        },
      ])
    );

    const knownTenantIds = new Set(
      (Array.isArray(tenants) ? tenants : []).map((tenant) => String(tenant._id))
    );

    const usageByTenant = (Array.isArray(tenants) ? tenants : []).map((tenant) => {
      const tenantId = String(tenant._id);
      const usage = usageByTenantId.get(tenantId) || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        request_count: 0,
        failed_requests: 0,
        success_requests: 0,
        total_cost_usd: 0,
        last_used: null,
      };
      const resolvedUsage = ensureCurrencyFields(usage);

      return {
        tenant_id: tenantId,
        tenant_name: tenant?.name || 'Unknown Tenant',
        tenant_code: tenant?.code || 'N/A',
        ...resolvedUsage,
        estimated_cost_usd: resolvedUsage.total_cost_usd,
        estimated_cost_inr: resolvedUsage.total_cost_inr,
        // Keep backward-compatible field used by existing UI.
        last_used_date: resolvedUsage.last_used,
      };
    });

    const unknownTenantAggregate = (Array.isArray(tenantUsageRaw) ? tenantUsageRaw : []).find(
      (row) => !row?._id
    );
    if (unknownTenantAggregate) {
      const resolvedUsage = ensureCurrencyFields({
        prompt_tokens: Number(unknownTenantAggregate?.prompt_tokens) || 0,
        completion_tokens: Number(unknownTenantAggregate?.completion_tokens) || 0,
        total_tokens: Number(unknownTenantAggregate?.total_tokens) || 0,
        request_count: Number(unknownTenantAggregate?.request_count) || 0,
        failed_requests: Number(unknownTenantAggregate?.failed_requests) || 0,
        success_requests: Number(unknownTenantAggregate?.success_requests) || 0,
        total_cost_usd: Number(unknownTenantAggregate?.total_cost_usd) || 0,
        last_used: unknownTenantAggregate?.last_used || null,
      });

      usageByTenant.push({
        tenant_id: null,
        tenant_name: 'Unknown Tenant',
        tenant_code: 'N/A',
        ...resolvedUsage,
        estimated_cost_usd: resolvedUsage.total_cost_usd,
        estimated_cost_inr: resolvedUsage.total_cost_inr,
        last_used_date: resolvedUsage.last_used,
      });
    }

    const orphanTenantRows = (Array.isArray(tenantUsageRaw) ? tenantUsageRaw : [])
      .filter((row) => row?._id && !knownTenantIds.has(String(row._id)))
      .map((row) => {
        const tenantId = String(row._id);
        const resolvedUsage = ensureCurrencyFields({
          prompt_tokens: Number(row?.prompt_tokens) || 0,
          completion_tokens: Number(row?.completion_tokens) || 0,
          total_tokens: Number(row?.total_tokens) || 0,
          request_count: Number(row?.request_count) || 0,
          failed_requests: Number(row?.failed_requests) || 0,
          success_requests: Number(row?.success_requests) || 0,
          total_cost_usd: Number(row?.total_cost_usd) || 0,
          last_used: row?.last_used || null,
        });

        return {
          tenant_id: tenantId,
          tenant_name: `Deleted Tenant (${tenantId.slice(-6)})`,
          tenant_code: 'N/A',
          ...resolvedUsage,
          estimated_cost_usd: resolvedUsage.total_cost_usd,
          estimated_cost_inr: resolvedUsage.total_cost_inr,
          last_used_date: resolvedUsage.last_used,
        };
      });

    if (orphanTenantRows.length > 0) {
      usageByTenant.push(...orphanTenantRows);
    }

    usageByTenant.sort((left, right) => {
      const requestDelta =
        (Number(right.request_count) || 0) - (Number(left.request_count) || 0);
      if (requestDelta !== 0) return requestDelta;
      const tokenDelta =
        (Number(right.total_tokens) || 0) - (Number(left.total_tokens) || 0);
      if (tokenDelta !== 0) return tokenDelta;
      return String(left.tenant_name || '').localeCompare(
        String(right.tenant_name || '')
      );
    });

    const metrics = {
      tokens_today: Number(todayTotals.total_tokens) || 0,
      tokens_this_month: Number(monthTotals.total_tokens) || 0,
      total_tokens_lifetime: Number(lifetimeTotals.total_tokens) || 0,
      requests_today: Number(todayTotals.request_count) || 0,
      requests_this_month: Number(monthTotals.request_count) || 0,
      total_requests_lifetime: Number(lifetimeTotals.request_count) || 0,
      failed_requests_lifetime: Number(lifetimeTotals.failed_requests) || 0,
      success_requests_lifetime: Number(lifetimeTotals.success_requests) || 0,
      total_cost_usd: Number(lifetimeTotals.total_cost_usd) || 0,
      total_cost_inr: usdToInr(lifetimeTotals.total_cost_usd),
      prompt_tokens_lifetime: Number(lifetimeTotals.prompt_tokens) || 0,
      completion_tokens_lifetime: Number(lifetimeTotals.completion_tokens) || 0,
    };

    const summary = ensureCurrencyFields({
      prompt_tokens: Number(selectedTotals.prompt_tokens) || 0,
      completion_tokens: Number(selectedTotals.completion_tokens) || 0,
      total_tokens: Number(selectedTotals.total_tokens) || 0,
      request_count: Number(selectedTotals.request_count) || 0,
      failed_requests: Number(selectedTotals.failed_requests) || 0,
      success_requests: Number(selectedTotals.success_requests) || 0,
      total_cost_usd: Number(selectedTotals.total_cost_usd) || 0,
    });

    res.json({
      metrics,
      trend_daily: trendDaily,
      usage_by_feature: usageByFeature,
      usage_by_model: usageByModel,
      usageByTenant,
      usage_by_tenant: usageByTenant,
      summary,
      filters: {
        range: resolvedRange,
        model: resolvedModel,
        period: normalizedPeriod || null,
        startDate: rangeStart ? rangeStart.toISOString() : null,
        endDate: rangeEnd ? rangeEnd.toISOString() : null,
      },
      currency: {
        usd_to_inr_rate: USD_TO_INR_RATE,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * BACKUP & RESTORE MANAGEMENT (SUPER ADMIN)
 */

router.post(
  '/backups',
  [
    body('type')
      .trim()
      .isIn(['full_system', 'company', 'specific_company', 'tenant'])
      .withMessage('type must be either full_system, company, specific_company, or tenant'),
    body('companyId')
      .optional({ nullable: true, checkFalsy: true })
      .isMongoId()
      .withMessage('companyId must be a valid ID'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const rawType = String(req.body?.type || '').trim();
      const type = rawType === 'specific_company' ? 'company' : rawType;
      const companyId = req.body?.companyId || null;

      if (type === 'tenant') {
        const batch = await createTenantBackupsForAll({
          createdBy: req.user?._id,
        });
        const failures = Array.isArray(batch.failed) ? batch.failed : [];

        await emitBackupOperationAlert({
          title:
            failures.length > 0
              ? 'Tenant Backup Batch Completed With Failures'
              : 'Tenant Backup Batch Completed',
          message:
            failures.length > 0
              ? `Tenant backup batch created ${batch?.created?.length || 0} backups with ${failures.length} failures.`
              : `Tenant backup batch created ${batch?.created?.length || 0} backups successfully.`,
          severity: failures.length > 0 ? 'warning' : 'info',
          entityId: 'tenant-batch',
          metadata: {
            total: batch.total || 0,
            created: (batch.created || []).length,
            failed: failures.length,
            initiated_by: req.user?._id ? String(req.user._id) : null,
          },
        });

        return res.status(201).json({
          message:
            failures.length > 0
              ? 'Tenant backups created with some failures.'
              : 'Tenant backups created successfully.',
          summary: {
            total: batch.total || 0,
            created: (batch.created || []).length,
            failed: failures.length,
          },
          backups: (batch.created || []).map((entry) => toFormattedBackupRecord(entry)),
          failures,
        });
      }

      if (type === 'company' && !companyId) {
        return res.status(400).json({
          error: 'companyId is required for company backup.',
        });
      }

      const backup = await createBackup({
        scope: type,
        companyId,
        createdBy: req.user?._id,
      });

      await emitBackupOperationAlert({
        title: 'Backup Created Successfully',
        message: `Backup ${backup?.backup_name || ''} was created successfully.`,
        severity: 'info',
        entityId: backup?._id ? String(backup._id) : '',
        metadata: {
          backup_id: backup?._id ? String(backup._id) : null,
          backup_name: backup?.backup_name || '',
          type,
          company_id: companyId || null,
          initiated_by: req.user?._id ? String(req.user._id) : null,
        },
      });

      return res.status(201).json({
        message: 'Backup created successfully.',
        backup: toFormattedBackupRecord(backup),
      });
    } catch (error) {
      await emitBackupOperationAlert({
        title: 'Backup Creation Failed',
        message: error?.message || 'Backup creation failed.',
        severity: 'critical',
        entityId: String(req.body?.companyId || req.body?.type || 'backup-create'),
        metadata: {
          type: req.body?.type || null,
          company_id: req.body?.companyId || null,
          initiated_by: req.user?._id ? String(req.user._id) : null,
        },
      });
      next(error);
    }
  }
);

router.get('/backups', async (req, res, next) => {
  try {
    const history = await listBackupHistory({
      page: req.query?.page,
      limit: req.query?.limit,
      type: req.query?.type,
      companyId: req.query?.companyId,
      status: req.query?.status,
    });

    res.json({
      backups: (history.items || []).map((entry) => toFormattedBackupRecord(entry)),
      pagination: history.pagination,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/backups/:backupId/download', async (req, res, next) => {
  try {
    const { backupId } = req.params;
    if (!isValidMongoId(backupId)) {
      return res.status(400).json({ error: 'backupId must be a valid ID.' });
    }

    const backup = await BackupHistory.findById(backupId).lean();
    if (!backup) {
      return res.status(404).json({ error: 'Backup not found.' });
    }

    const backupFilePath = getBackupDownloadPath(backup);
    if (!backupFilePath) {
      return res.status(404).json({ error: 'Backup file path is invalid.' });
    }

    try {
      await fs.access(backupFilePath);
    } catch {
      return res.status(404).json({ error: 'Backup file does not exist.' });
    }

    return res.download(backupFilePath, backup.backup_name || 'backup.zip');
  } catch (error) {
    next(error);
  }
});

router.post('/backups/:backupId/restore', async (req, res, next) => {
  try {
    const { backupId } = req.params;
    if (!isValidMongoId(backupId)) {
      return res.status(400).json({ error: 'backupId must be a valid ID.' });
    }

    const restored = await restoreBackupFromHistory({
      backupId,
      initiatedBy: req.user?._id,
    });

    await emitBackupOperationAlert({
      title: 'Backup Restored Successfully',
      message:
        'Backup restore completed and a pre-restore safety backup was created successfully.',
      severity: 'info',
      entityId: backupId,
      metadata: {
        backup_id: backupId,
        scope: restored?.manifest?.scope_type || 'full_system',
        company_id: restored?.manifest?.company_id || null,
        company_name: restored?.manifest?.company_name || null,
        initiated_by: req.user?._id ? String(req.user._id) : null,
      },
    });

    res.json({
      message:
        'Backup restored successfully. Current data was overwritten and a pre-restore safety backup was created.',
      restore: {
        scope: restored?.manifest?.scope_type || 'full_system',
        company_id: restored?.manifest?.company_id || null,
        company_name: restored?.manifest?.company_name || null,
        inserted_collections: restored?.inserted_collections || [],
        safety_backup: toFormattedBackupRecord(restored?.safety_backup),
      },
    });
  } catch (error) {
    await emitBackupOperationAlert({
      title: 'Backup Restore Failed',
      message: error?.message || 'Backup restore failed.',
      severity: 'critical',
      entityId: String(req.params?.backupId || 'backup-restore'),
      metadata: {
        backup_id: req.params?.backupId || null,
        initiated_by: req.user?._id ? String(req.user._id) : null,
      },
    });
    next(error);
  }
});

router.post(
  '/backups/restore-upload',
  backupUpload.single('backup_file'),
  async (req, res, next) => {
    const uploadedFilePath = req.file?.path;

    try {
      if (!uploadedFilePath) {
        return res.status(400).json({ error: 'backup_file is required.' });
      }

      const manifest = await parseBackupManifest({ zipPath: uploadedFilePath });
      const restored = await restoreBackupFromUploadedFile({
        uploadedZipPath: uploadedFilePath,
        initiatedBy: req.user?._id,
      });

      await emitBackupOperationAlert({
        title: 'Uploaded Backup Restored Successfully',
        message:
          'Uploaded backup restore completed and a pre-restore safety backup was created successfully.',
        severity: 'info',
        entityId: String(manifest?.company_id || 'uploaded-backup'),
        metadata: {
          scope: restored?.manifest?.scope_type || 'full_system',
          company_id: manifest?.company_id || null,
          company_name: manifest?.company_name || null,
          initiated_by: req.user?._id ? String(req.user._id) : null,
        },
      });

      res.json({
        message:
          'Uploaded backup restored successfully. Current data was overwritten and a pre-restore safety backup was created.',
        uploaded_manifest: {
          type: manifest?.type || '',
          scope_type: manifest?.scope_type || '',
          company_id: manifest?.company_id || null,
          company_name: manifest?.company_name || null,
          created_at: manifest?.created_at || null,
        },
        restore: {
          scope: restored?.manifest?.scope_type || 'full_system',
          company_id: restored?.manifest?.company_id || null,
          company_name: restored?.manifest?.company_name || null,
          inserted_collections: restored?.inserted_collections || [],
          safety_backup: toFormattedBackupRecord(restored?.safety_backup),
        },
      });
    } catch (error) {
      await emitBackupOperationAlert({
        title: 'Uploaded Backup Restore Failed',
        message: error?.message || 'Uploaded backup restore failed.',
        severity: 'critical',
        entityId: String(req.file?.originalname || 'uploaded-backup'),
        metadata: {
          uploaded_file: req.file?.originalname || null,
          initiated_by: req.user?._id ? String(req.user._id) : null,
        },
      });
      next(error);
    } finally {
      if (uploadedFilePath) {
        await fs.rm(uploadedFilePath, { force: true });
      }
    }
  }
);

router.delete('/backups/:backupId', async (req, res, next) => {
  try {
    const { backupId } = req.params;
    if (!isValidMongoId(backupId)) {
      return res.status(400).json({ error: 'backupId must be a valid ID.' });
    }

    const deleted = await deleteBackup({ backupId });
    res.json({
      message: 'Backup deleted successfully.',
      backup: deleted,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * TENANT MANAGEMENT
 */

// List all tenants
router.get('/tenants', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { contactEmail: { $regex: search, $options: 'i' } },
      ];
    }

    const [tenants, total] = await Promise.all([
      Tenant.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Tenant.countDocuments(filter),
    ]);

    res.json({
      tenants,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Create tenant - Only SUPER_ADMIN can create tenants
 * 
 * Simple flow:
 * 1. Only SUPER_ADMIN can create tenants (enforced by requireRole middleware)
 * 2. Tenant requires: name, code, type (SCHOOL|COLLEGE|COMPANY|INSTITUTE|GOVERNMENT|OTHER)
 * 3. Tenant cannot self-register - must be created by SUPER_ADMIN
 * 4. After creation, SUPER_ADMIN assigns users to tenants
 */
router.post(
  '/tenants',
  [
    body('name').trim().notEmpty().withMessage('Tenant name is required'),
    body('code')
      .trim()
      .notEmpty()
      .matches(/^[A-Z0-9_-]+$/)
      .withMessage('Code must contain only uppercase letters, numbers, hyphens, and underscores'),
    body('type').isIn(['SCHOOL', 'COLLEGE', 'COMPANY', 'INSTITUTE', 'GOVERNMENT', 'OTHER']).withMessage('Valid tenant type is required'),
    body('contactEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('planType').optional().isString().withMessage('planType must be a string'),
    body('startedAt')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('startedAt must be a valid date');
        }
        return true;
      }),
    body('planStartDate')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('planStartDate must be a valid date');
        }
        return true;
      }),
    body('examLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('examLimit must be a non-negative number or null'),
    body('attemptLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('attemptLimit must be a non-negative number or null'),
    body('aiUsageLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('aiUsageLimit must be a non-negative number or null'),
    body('customLimits')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return !LEGEND_CUSTOM_LIMIT_KEYS.some(
          (key) => hasOwn(value, key) && !isValidLimitInput(value[key])
        );
      })
      .withMessage('customLimits must contain non-negative values or null'),
    body('customFeatures')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return !Object.values(value).some(
          (featureValue) =>
            featureValue !== null &&
            featureValue !== undefined &&
            typeof featureValue !== 'boolean'
        );
      })
      .withMessage('customFeatures must be an object with boolean values'),
    body('expiresAt')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('expiresAt must be a valid date');
        }
        return true;
      }),
    body('planExpiryDate')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('planExpiryDate must be a valid date');
        }
        return true;
      }),
    body('status')
      .optional()
      .isIn(SUBSCRIPTION_STATUS_VALUES)
      .withMessage('status must be one of ACTIVE, EXPIRED, or SUSPENDED'),
    body('subscriptionStatus')
      .optional()
      .isIn(SUBSCRIPTION_STATUS_VALUES)
      .withMessage('subscriptionStatus must be one of ACTIVE, EXPIRED, or SUSPENDED'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        name,
        code,
        type,
        contactEmail,
        contactPhone,
        address,
        examLimit,
        attemptLimit,
        aiUsageLimit,
        customLimits,
        customFeatures,
        metadata,
        planType,
        startedAt,
        planStartDate,
        expiresAt,
        planExpiryDate,
        status,
        subscriptionStatus,
      } = req.body;

      // Check if code already exists
      const existing = await Tenant.findOne({ code: code.toUpperCase() });
      if (existing) {
        return res.status(409).json({ error: 'Tenant code already exists' });
      }

      const normalizedPlanType = resolveSubscriptionPlanType(
        planType || SUBSCRIPTION_PLAN_TYPES.FREE
      );

      if (!SUBSCRIPTION_PLANS[normalizedPlanType]) {
        return res.status(400).json({
          error: 'Invalid planType. Use one of: free, pro, ultimate, legend.',
        });
      }

      let parsedStartedAt = new Date();
      const rawStartDate = planStartDate ?? startedAt;
      if (rawStartDate) {
        const parsedDate = new Date(rawStartDate);
        if (Number.isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: 'planStartDate must be a valid date' });
        }
        parsedStartedAt = parsedDate;
      }

      let parsedExpiresAt = null;
      const rawExpiryDate = planExpiryDate ?? expiresAt;
      if (rawExpiryDate) {
        const parsedDate = new Date(rawExpiryDate);
        if (Number.isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: 'planExpiryDate must be a valid date' });
        }
        parsedExpiresAt = parsedDate;
      } else {
        parsedExpiresAt = calculateDefaultSubscriptionExpiryDate(
          normalizedPlanType,
          parsedStartedAt
        );
      }

      const requestedStatus =
        normalizeSubscriptionStatusInput(subscriptionStatus ?? status) ||
        SUBSCRIPTION_STATUSES.ACTIVE;
      if (requestedStatus === SUBSCRIPTION_STATUSES.EXPIRED && !parsedExpiresAt) {
        parsedExpiresAt = new Date();
      }

      const legacyExamLimit = parseOptionalLimitValue(examLimit);
      const legacyAttemptLimit = parseOptionalLimitValue(attemptLimit);
      const legacyAiLimit = parseOptionalLimitValue(aiUsageLimit);
      const requestedCustomLimits = extractLegendCustomLimits(customLimits);
      const requestedCustomFeatures = extractFeatureOverrides(customFeatures);

      const resolvedCustomLimits =
        normalizedPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND
          ? {
              ...requestedCustomLimits,
              ...(hasOwn(requestedCustomLimits, 'maxExamsPerMonth')
                ? {}
                : { maxExamsPerMonth: legacyExamLimit }),
              ...(hasOwn(requestedCustomLimits, 'maxAttemptsPerMonth')
                ? {}
                : { maxAttemptsPerMonth: legacyAttemptLimit }),
              ...(hasOwn(requestedCustomLimits, 'maxAiQuestionsPerMonth')
                ? {}
                : { maxAiQuestionsPerMonth: legacyAiLimit }),
            }
          : {};

      const subscriptionPayload = {
        planType: normalizedPlanType,
        status: resolveSubscriptionStatus({ expiresAt: parsedExpiresAt, status: requestedStatus }),
        startedAt: parsedStartedAt,
        expiresAt: parsedExpiresAt,
        usageResetAt: new Date(),
        customLimits: resolvedCustomLimits,
        customFeatures: requestedCustomFeatures,
        updatedAt: new Date(),
      };

      const tenant = new Tenant({
        name,
        code: code.toUpperCase(),
        type,
        contactEmail,
        contactPhone,
        address,
        examLimit: parseOptionalLimitValue(resolvedCustomLimits.maxExamsPerMonth ?? legacyExamLimit),
        attemptLimit: parseOptionalLimitValue(
          resolvedCustomLimits.maxAttemptsPerMonth ?? legacyAttemptLimit
        ),
        aiUsageLimit: parseOptionalLimitValue(
          resolvedCustomLimits.maxAiQuestionsPerMonth ?? legacyAiLimit
        ),
        metadata: metadata || {},
        subscription: subscriptionPayload,
        createdBy: req.user._id,
      });

      await tenant.save();
      await tenant.populate('createdBy', 'name email');

      await logAuditEvent(AUDIT_ACTIONS.TENANT_CREATED, {
        ...buildActorAuditDetails(req),
        tenantId: tenant._id,
        tenantName: tenant.name,
        resourceType: 'Tenant',
        resourceId: tenant._id,
        details: {
          tenantName: tenant.name,
          tenantCode: tenant.code,
          tenantType: tenant.type,
          tenantStatus: tenant.status,
          planType: subscriptionPayload.planType,
          subscriptionStatus: subscriptionPayload.status,
        },
      });

      try {
        const { createRoleNotification } = await import('../services/notificationService.js');
        await createRoleNotification({
          title: 'Tenant Created',
          message: `Tenant "${tenant.name}" (${tenant.code}) was created by ${req.user.name || req.user.email}.`,
          type: 'tenant_created',
          roles: ['SUPER_ADMIN'],
          tenantId: tenant._id,
          createdBy: req.user._id,
          metadata: {
            tenantId: tenant._id,
            tenantName: tenant.name,
            tenantCode: tenant.code,
          },
        });
      } catch (notifyError) {
        console.error('[NOTIFICATIONS] Failed to log tenant creation:', notifyError?.message || notifyError);
      }

      res.status(201).json({ tenant });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Tenant code already exists' });
      }
      next(error);
    }
  }
);

// Get single tenant with details
router.get('/tenants/:tenantId', async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.tenantId)
      .populate('createdBy', 'name email');

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Get detailed stats and data
    const [usersCount, users, examsCount, exams, attemptsCount, sessionsCount, sessions] = await Promise.all([
      User.countDocuments({ tenantId: tenant._id }),
      User.find({ tenantId: tenant._id })
        .select('name email role status createdAt')
        .sort({ createdAt: -1 })
        .limit(100), // Limit to 100 users for performance
      Exam.countDocuments({ tenantId: tenant._id }),
      Exam.find({ tenantId: tenant._id })
        .select('title isActive duration maxAttempts createdAt')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(50), // Limit to 50 exams
      ExamAttempt.countDocuments({ tenantId: tenant._id }),
      ExamSession.countDocuments({ tenantId: tenant._id }),
      ExamSession.find({ tenantId: tenant._id })
        .populate('examId', 'title duration maxAttempts')
        .populate('questionPaperId', 'setName')
        .populate('questionPaperIds', 'setName')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(50), // Limit to 50 sessions
    ]);

    res.json({
      tenant,
      stats: {
        users: usersCount,
        exams: examsCount,
        attempts: attemptsCount,
        sessions: sessionsCount,
      },
      users,
      exams,
      sessions,
    });
  } catch (error) {
    next(error);
  }
});

// Update tenant
router.put(
  '/tenants/:tenantId',
  [
    body('name').optional().trim().notEmpty(),
    body('code')
      .optional()
      .trim()
      .matches(/^[A-Z0-9_-]+$/)
      .withMessage('Code must contain only uppercase letters, numbers, hyphens, and underscores'),
    body('type').optional().isIn(['SCHOOL', 'COLLEGE', 'COMPANY', 'INSTITUTE', 'GOVERNMENT', 'OTHER']),
    body('contactEmail').optional().isEmail().normalizeEmail(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
    body('examLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('examLimit must be a non-negative number or null'),
    body('attemptLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('attemptLimit must be a non-negative number or null'),
    body('aiUsageLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('aiUsageLimit must be a non-negative number or null'),
    body('customLimits')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return !LEGEND_CUSTOM_LIMIT_KEYS.some(
          (key) => hasOwn(value, key) && !isValidLimitInput(value[key])
        );
      })
      .withMessage('customLimits must contain non-negative values or null'),
    body('customFeatures')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return !Object.values(value).some(
          (featureValue) =>
            featureValue !== null &&
            featureValue !== undefined &&
            typeof featureValue !== 'boolean'
        );
      })
      .withMessage('customFeatures must be an object with boolean values'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const tenant = await Tenant.findById(req.params.tenantId);
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const beforeState = {
        name: tenant.name,
        code: tenant.code,
        type: tenant.type,
        contactEmail: tenant.contactEmail,
        contactPhone: tenant.contactPhone,
        address: tenant.address,
        status: tenant.status,
        examLimit: tenant.examLimit,
        attemptLimit: tenant.attemptLimit,
        aiUsageLimit: tenant.aiUsageLimit,
        customLimits: normalizeOptionalObject(tenant?.subscription?.customLimits),
        customFeatures: normalizeOptionalObject(tenant?.subscription?.customFeatures),
      };

      const {
        name,
        code,
        type,
        contactEmail,
        contactPhone,
        address,
        status,
        examLimit,
        attemptLimit,
        aiUsageLimit,
        customLimits,
        customFeatures,
        metadata,
      } = req.body;

      if (name) tenant.name = name;
      if (code) {
        // Check if new code conflicts
        const existing = await Tenant.findOne({ code: code.toUpperCase(), _id: { $ne: tenant._id } });
        if (existing) {
          return res.status(409).json({ error: 'Tenant code already exists' });
        }
        tenant.code = code.toUpperCase();
      }
      if (type) tenant.type = type;
      if (contactEmail) tenant.contactEmail = contactEmail;
      if (contactPhone !== undefined) tenant.contactPhone = contactPhone;
      if (address !== undefined) tenant.address = address;
      if (status) tenant.status = status;
      if (examLimit !== undefined) tenant.examLimit = parseOptionalLimitValue(examLimit);
      if (attemptLimit !== undefined) tenant.attemptLimit = parseOptionalLimitValue(attemptLimit);
      if (aiUsageLimit !== undefined) tenant.aiUsageLimit = parseOptionalLimitValue(aiUsageLimit);
      if (customLimits !== undefined || customFeatures !== undefined) {
        tenant.subscription = tenant.subscription || {};
      }
      const currentPlanType = resolveSubscriptionPlanType(
        tenant?.subscription?.planType || SUBSCRIPTION_PLAN_TYPES.FREE
      );
      if (
        currentPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND &&
        (examLimit !== undefined || attemptLimit !== undefined || aiUsageLimit !== undefined)
      ) {
        tenant.subscription = tenant.subscription || {};
        tenant.subscription.customLimits = {
          ...normalizeOptionalObject(tenant.subscription.customLimits),
          ...(examLimit !== undefined
            ? { maxExamsPerMonth: parseOptionalLimitValue(examLimit) }
            : {}),
          ...(attemptLimit !== undefined
            ? { maxAttemptsPerMonth: parseOptionalLimitValue(attemptLimit) }
            : {}),
          ...(aiUsageLimit !== undefined
            ? { maxAiQuestionsPerMonth: parseOptionalLimitValue(aiUsageLimit) }
            : {}),
        };
      }
      if (customLimits !== undefined) {
        tenant.subscription.customLimits = {
          ...normalizeOptionalObject(tenant.subscription.customLimits),
          ...extractLegendCustomLimits(customLimits),
        };
      }
      if (customFeatures !== undefined) {
        tenant.subscription.customFeatures = {
          ...normalizeOptionalObject(tenant.subscription.customFeatures),
          ...extractFeatureOverrides(customFeatures),
        };
      }
      if (currentPlanType === SUBSCRIPTION_PLAN_TYPES.LEGEND) {
        const legendLimits = resolveLegendEffectiveLimits({
          planType: currentPlanType,
          tenant: tenant.toObject ? tenant.toObject() : tenant,
          baseLimits: getSubscriptionPlanDefinition(currentPlanType)?.limits || {},
        });
        tenant.examLimit = legendLimits.maxExamsPerMonth;
        tenant.attemptLimit = legendLimits.maxAttemptsPerMonth;
        tenant.aiUsageLimit = legendLimits.maxAiQuestionsPerMonth;
      }
      if (metadata) tenant.metadata = { ...tenant.metadata, ...metadata };

      await tenant.save();
      await tenant.populate('createdBy', 'name email');

      const updatedFields = [];
      Object.entries({
        name: tenant.name,
        code: tenant.code,
        type: tenant.type,
        contactEmail: tenant.contactEmail,
        contactPhone: tenant.contactPhone,
        address: tenant.address,
        status: tenant.status,
        examLimit: tenant.examLimit,
        attemptLimit: tenant.attemptLimit,
        aiUsageLimit: tenant.aiUsageLimit,
        customLimits: normalizeOptionalObject(tenant?.subscription?.customLimits),
        customFeatures: normalizeOptionalObject(tenant?.subscription?.customFeatures),
      }).forEach(([field, value]) => {
        const beforeValue = beforeState[field];
        if (String(beforeValue ?? '') !== String(value ?? '')) {
          updatedFields.push(field);
        }
      });

      await logAuditEvent(AUDIT_ACTIONS.TENANT_UPDATED, {
        ...buildActorAuditDetails(req),
        tenantId: tenant._id,
        tenantName: tenant.name,
        resourceType: 'Tenant',
        resourceId: tenant._id,
        details: {
          updatedFields,
          tenantName: tenant.name,
          tenantCode: tenant.code,
          beforeStatus: beforeState.status,
          afterStatus: tenant.status,
        },
      });

      res.json({ tenant });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: 'Tenant code already exists' });
      }
      next(error);
    }
  }
);

// Delete tenant (soft delete by setting status to INACTIVE)
router.delete('/tenants/:tenantId', async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Check if tenant has active users or exams
    const [activeUsers, activeExams] = await Promise.all([
      User.countDocuments({ tenantId: tenant._id, status: 'ACTIVE' }),
      Exam.countDocuments({ tenantId: tenant._id, isActive: true }),
    ]);

    if (activeUsers > 0 || activeExams > 0) {
      return res.status(400).json({
        error: 'Cannot delete tenant with active users or exams. Deactivate them first.',
      });
    }

    const beforeStatus = tenant.status;
    tenant.status = 'INACTIVE';
    await tenant.save();

    await logAuditEvent(AUDIT_ACTIONS.TENANT_DEACTIVATED, {
      ...buildActorAuditDetails(req),
      tenantId: tenant._id,
      tenantName: tenant.name,
      resourceType: 'Tenant',
      resourceId: tenant._id,
      details: {
        tenantName: tenant.name,
        tenantCode: tenant.code,
        beforeStatus,
        afterStatus: tenant.status,
      },
    });

    res.json({ message: 'Tenant deactivated successfully', tenant });
  } catch (error) {
    next(error);
  }
});

/**
 * USER MANAGEMENT (Global)
 */

// List all users (with filters)
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, tenantId, role, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { role: { $ne: 'SUPER_ADMIN' } }; // Exclude SUPER_ADMIN from listings
    if (tenantId) filter.tenantId = tenantId;
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password')
        .populate('tenantId', 'name code type')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(filter),
    ]);

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get single user
router.get('/users/:userId', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('-password')
      .populate('tenantId', 'name code type');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent viewing SUPER_ADMIN details
    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot view SUPER_ADMIN user details' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Create user
router.post(
  '/users',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['TENANT_ADMIN', 'EXAM_CREATOR', 'CANDIDATE']).withMessage('Invalid role. Must be TENANT_ADMIN, EXAM_CREATOR, or CANDIDATE'),
    body('tenantId')
      .optional({ checkFalsy: true })
      .custom((value) => {
        if (!value || value === '') return true; // Allow empty string/null
        return /^[0-9a-fA-F]{24}$/.test(value); // MongoDB ObjectId format
      })
      .withMessage('Valid tenant ID is required if provided'),
  ],
  checkTenantLimits,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, tenantId, mobile } = req.body;

      // Check if user exists
      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Normalize empty strings to null/undefined
      const normalizedTenantId = tenantId && tenantId.trim() !== '' ? tenantId : null;

      // TENANT_ADMIN must have a tenantId
      if (role === 'TENANT_ADMIN' && !normalizedTenantId) {
        return res.status(400).json({ error: 'TENANT_ADMIN must be assigned to a tenant' });
      }

      // Verify tenant exists (if provided)
      if (normalizedTenantId) {
        const tenant = await Tenant.findById(normalizedTenantId);
        if (!tenant) {
          return res.status(404).json({ error: 'Tenant not found' });
        }
      }

      // Allow users to be created without tenant initially (they can be assigned later)
      // Exception: TENANT_ADMIN must have tenantId (checked above)
      const user = new User({
        name,
        email,
        password,
        role,
        tenantId: normalizedTenantId,
        mobile,
        status: 'ACTIVE',
      });

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      await user.populate('tenantId', 'name code type');

      await logAuditEvent(AUDIT_ACTIONS.USER_CREATED, {
        ...buildActorAuditDetails(req),
        tenantId: user.tenantId || null,
        resourceType: 'User',
        resourceId: user._id,
        details: {
          createdUserName: user.name,
          createdUserEmail: user.email,
          createdUserRole: user.role,
          createdUserTenantId: user.tenantId || null,
        },
      });

      res.status(201).json({ user: { ...userObj, tenantId: user.tenantId } });
    } catch (error) {
      next(error);
    }
  }
);

// Role mapping for old roles to new roles
const roleMapping = {
  // Admin/creator roles → EXAM_CREATOR
  'ORG_ADMIN': 'EXAM_CREATOR',
  'INSTITUTE_ADMIN': 'EXAM_CREATOR',
  'ADMIN': 'EXAM_CREATOR',
  'DESIGNER': 'EXAM_CREATOR',
  'TEACHER': 'EXAM_CREATOR',
  
  // User roles → CANDIDATE
  'USER': 'CANDIDATE',
  'STUDENT': 'CANDIDATE',
};

// Helper function to convert old roles to new roles
function convertRole(oldRole) {
  return roleMapping[oldRole] || oldRole;
}

// Update user
router.put(
  '/users/:userId',
  [
    body('name').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('role')
      .optional()
      .custom((value) => {
        // Allow new roles and old roles (will be converted in handler)
        const validRoles = ['EXAM_CREATOR', 'CANDIDATE', 'TENANT_ADMIN', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'ADMIN', 'DESIGNER', 'TEACHER', 'USER', 'STUDENT'];
        return validRoles.includes(value);
      })
      .withMessage('Invalid role'),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED']),
    body('tenantId')
      .optional({ checkFalsy: true })
      .custom((value) => {
        if (!value || value === '') return true; // Allow empty string/null
        return /^[0-9a-fA-F]{24}$/.test(value); // MongoDB ObjectId format
      })
      .withMessage('Valid tenant ID is required if provided'),
  ],
  checkTenantLimits,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent modifying SUPER_ADMIN
      if (user.role === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Cannot modify SUPER_ADMIN user' });
      }

      const beforeState = {
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        mobile: user.mobile,
        tenantId: user.tenantId,
      };

      const { name, email, password, role, tenantId, status, mobile } = req.body;

      if (name) user.name = name;
      if (email) {
        // Check if email conflicts
        const existing = await User.findOne({ email, _id: { $ne: user._id } });
        if (existing) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        user.email = email;
      }
      if (password) user.password = password; // Will be hashed by pre-save hook
      
      // Handle role: convert old roles to new roles
      if (role !== undefined) {
        // Convert role if it's an old role, otherwise use the provided role
        const convertedRole = convertRole(role);
        user.role = convertedRole;
      } else {
        // No role provided in request - check if current role needs conversion
        const currentRole = user.role;
        const convertedCurrentRole = convertRole(currentRole);
        if (convertedCurrentRole !== currentRole) {
          // User has an old role, convert it automatically
          user.role = convertedCurrentRole;
        }
      }
      // Normalize empty strings to null
      const normalizedTenantId = tenantId !== undefined 
        ? (tenantId && tenantId.trim() !== '' ? tenantId : null)
        : undefined;

      if (normalizedTenantId !== undefined) {
        if (normalizedTenantId) {
          const tenant = await Tenant.findById(normalizedTenantId);
          if (!tenant) {
            return res.status(404).json({ error: 'Tenant not found' });
          }
          user.tenantId = normalizedTenantId;
        } else {
          // Setting to null explicitly
          user.tenantId = null;
        }
      }
      if (status) user.status = status;
      if (mobile !== undefined) user.mobile = mobile;

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      await user.populate('tenantId', 'name code type');

      const updatedFields = [];
      Object.entries({
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        mobile: user.mobile,
        tenantId: user.tenantId,
      }).forEach(([field, value]) => {
        const beforeValue = beforeState[field];
        if (String(beforeValue ?? '') !== String(value ?? '')) {
          updatedFields.push(field);
        }
      });

      const roleChanged = beforeState.role !== user.role;
      const action = roleChanged ? AUDIT_ACTIONS.USER_ROLE_CHANGED : AUDIT_ACTIONS.USER_UPDATED;

      await logAuditEvent(action, {
        ...buildActorAuditDetails(req),
        tenantId: user.tenantId || beforeState.tenantId || null,
        resourceType: 'User',
        resourceId: user._id,
        details: {
          updatedFields,
          roleChanged,
          beforeRole: beforeState.role,
          afterRole: user.role,
          targetUserName: user.name,
          targetUserEmail: user.email,
          targetUserStatus: user.status,
          targetUserTenantId: user.tenantId || null,
        },
      });

      res.json({ user: { ...userObj, tenantId: user.tenantId } });
    } catch (error) {
      next(error);
    }
  }
);

// Delete user (permanent delete)
router.delete('/users/:userId', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot delete SUPER_ADMIN user' });
    }

    if (user._id.toString() === req.user._id.toString()) {
      return res.status(403).json({ error: 'Cannot delete your own account' });
    }

    const userObj = user.toObject();
    delete userObj.password;

    await logAuditEvent(AUDIT_ACTIONS.USER_DELETED, {
      ...buildActorAuditDetails(req),
      tenantId: user.tenantId || null,
      resourceType: 'User',
      resourceId: user._id,
      details: {
        deletedUserName: user.name,
        deletedUserEmail: user.email,
        deletedUserRole: user.role,
        deletedUserStatus: user.status,
        deletedUserTenantId: user.tenantId || null,
      },
    });

    await deleteUserAndCleanup(user._id);

    res.json({ message: 'User deleted successfully', user: userObj });
  } catch (error) {
    next(error);
  }
});

// Reset user password
router.post(
  '/users/:userId/reset-password',
  [body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.role === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Cannot reset SUPER_ADMIN password' });
      }

      user.password = req.body.newPassword; // Will be hashed by pre-save hook
      await user.save();

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * EXAM OVERSIGHT
 */

// List all exams (with filters)
router.get('/exams', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, tenantId, createdBy, isActive, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (tenantId) filter.tenantId = tenantId;
    if (createdBy) filter.createdBy = createdBy;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const [exams, total] = await Promise.all([
      Exam.find(filter)
        .populate('tenantId', 'name code type')
        .populate('createdBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Exam.countDocuments(filter),
    ]);

    res.json({
      exams,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get single exam with full details
router.get('/exams/:examId', async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId)
      .populate('tenantId', 'name code type')
      .populate('createdBy', 'name email role');

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // Get question papers for this exam
    const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
    const questionPapers = await QuestionPaper.find({ examId: exam._id, isActive: true });

    // Get sections and question counts for each question paper
    const Section = (await import('../models/Section.js')).default;
    const Question = (await import('../models/Question.js')).default;

    const examDetails = {
      ...exam.toObject(),
      questionPapers: [],
      totalQuestions: 0,
      totalMarks: 0,
      sections: [],
    };

    // Process each question paper
    for (const qp of questionPapers) {
      const sections = await Section.find({ questionPaperId: qp._id, isActive: true })
        .sort({ order: 1 })
        .lean();

      const sectionDetails = [];
      let paperTotalQuestions = 0;
      let paperTotalMarks = 0;

      for (const section of sections) {
        const questionCount = await Question.countDocuments({
          questionPaperId: qp._id,
          sectionId: section._id,
        });

        const sectionMarks = await Question.aggregate([
          {
            $match: {
              questionPaperId: qp._id,
              sectionId: section._id,
            },
          },
          {
            $group: {
              _id: null,
              totalMarks: { $sum: '$points' },
            },
          },
        ]);

        const marks = sectionMarks.length > 0 ? sectionMarks[0].totalMarks : 0;

        sectionDetails.push({
          ...section,
          questionCount,
          totalMarks: marks,
        });

        paperTotalQuestions += questionCount;
        paperTotalMarks += marks;
      }

      // Also count questions without sections
      const questionsWithoutSection = await Question.countDocuments({
        questionPaperId: qp._id,
        sectionId: { $exists: false },
      });

      const marksWithoutSection = await Question.aggregate([
        {
          $match: {
            questionPaperId: qp._id,
            sectionId: { $exists: false },
          },
        },
        {
          $group: {
            _id: null,
            totalMarks: { $sum: '$points' },
          },
        },
      ]);

      const marksNoSection = marksWithoutSection.length > 0 ? marksWithoutSection[0].totalMarks : 0;

      examDetails.questionPapers.push({
        ...qp.toObject(),
        sections: sectionDetails,
        questionCount: paperTotalQuestions + questionsWithoutSection,
        totalMarks: paperTotalMarks + marksNoSection,
      });

      examDetails.totalQuestions += paperTotalQuestions + questionsWithoutSection;
      examDetails.totalMarks += paperTotalMarks + marksNoSection;
      examDetails.sections.push(...sectionDetails);
    }

    // Get all attempts for this exam with candidate details
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    
    const attempts = await ExamAttempt.find({ examId: exam._id })
      .populate('userId', 'name email uniqueId')
      .sort({ createdAt: -1 })
      .lean();

    // Aggregate candidate data
    const candidatesMap = new Map();
    
    for (const attempt of attempts) {
      const userId = attempt.userId?._id?.toString() || attempt.userId?.toString();
      if (!userId) continue;

      if (!candidatesMap.has(userId)) {
        candidatesMap.set(userId, {
          _id: userId,
          name: attempt.userId?.name || 'Unknown',
          email: attempt.userId?.email || '',
          uniqueId: attempt.userId?.uniqueId || '',
          attempts: [],
          totalAttempts: 0,
          bestScore: 0,
          bestPercentage: 0,
          latestAttempt: null,
        });
      }

      const candidate = candidatesMap.get(userId);
      candidate.totalAttempts++;

      // Get answers for this attempt to calculate questions attempted
      const answers = await Answer.find({ attemptId: attempt._id }).lean();
      const questionsAttempted = answers.length;
      const marksObtained = attempt.scoreSummary?.totalScore || 0;
      const totalMarks = attempt.scoreSummary?.maxScore || examDetails.totalMarks || 0;
      const percentage = attempt.scoreSummary?.percentage || 0;

      candidate.attempts.push({
        attemptId: attempt._id,
        isCompleted: attempt.isCompleted || false,
        isDisqualified: attempt.isDisqualified || false,
        questionsAttempted,
        marksObtained,
        totalMarks,
        percentage,
        startTime: attempt.startTime,
        submitTime: attempt.submitTime,
      });

      // Track best score
      if (marksObtained > candidate.bestScore) {
        candidate.bestScore = marksObtained;
        candidate.bestPercentage = percentage;
      }

      // Track latest attempt
      if (!candidate.latestAttempt || new Date(attempt.createdAt) > new Date(candidate.latestAttempt.createdAt)) {
        candidate.latestAttempt = {
          attemptId: attempt._id,
          questionsAttempted,
          marksObtained,
          totalMarks,
          percentage,
          isCompleted: attempt.isCompleted || false,
          isDisqualified: attempt.isDisqualified || false,
          createdAt: attempt.createdAt,
        };
      }
    }

    // Convert map to array and format for response
    const candidates = Array.from(candidatesMap.values()).map(candidate => ({
      _id: candidate._id,
      name: candidate.name,
      email: candidate.email,
      uniqueId: candidate.uniqueId,
      totalAttempts: candidate.totalAttempts,
      latestAttempt: candidate.latestAttempt ? {
        questionsAttempted: candidate.latestAttempt.questionsAttempted,
        marksObtained: candidate.latestAttempt.marksObtained,
        totalMarks: candidate.latestAttempt.totalMarks,
        percentage: candidate.latestAttempt.percentage,
        isCompleted: candidate.latestAttempt.isCompleted,
        isDisqualified: candidate.latestAttempt.isDisqualified,
        attemptId: candidate.latestAttempt.attemptId,
      } : null,
      bestScore: candidate.bestScore,
      bestPercentage: candidate.bestPercentage,
    }));

    examDetails.candidates = candidates;
    examDetails.totalCandidates = candidates.length;

    res.json({ exam: examDetails });
  } catch (error) {
    next(error);
  }
});

// Disable exam (Super Admin can disable any exam)
router.put('/exams/:examId/disable', async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const beforeState = { isActive: exam.isActive };
    exam.isActive = false;
    await exam.save();

    // Log audit
    await logAuditEvent(AUDIT_ACTIONS.EXAM_DISABLED, {
      ...buildActorAuditDetails(req),
      tenantId: exam.tenantId || null,
      resourceType: 'Exam',
      resourceId: exam._id,
      details: {
        before: beforeState,
        after: { isActive: false },
      },
    });

    res.json({ message: 'Exam disabled successfully', exam });
  } catch (error) {
    next(error);
  }
});

// Enable exam (Super Admin can enable any exam)
router.put('/exams/:examId/enable', async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const beforeState = { isActive: exam.isActive };
    exam.isActive = true;
    await exam.save();

    // Log audit
    await logAuditEvent(AUDIT_ACTIONS.EXAM_ENABLED, {
      ...buildActorAuditDetails(req),
      tenantId: exam.tenantId || null,
      resourceType: 'Exam',
      resourceId: exam._id,
      details: {
        before: beforeState,
        after: { isActive: true },
      },
    });

    res.json({ message: 'Exam enabled successfully', exam });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM ATTEMPTS & RESULTS MONITORING
 */

// Get single attempt with full details
router.get('/attempts/:attemptId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const Section = (await import('../models/Section.js')).default;
    const Question = (await import('../models/Question.js')).default;
    const AnswerKey = (await import('../models/AnswerKey.js')).default;

    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate({
        path: 'examId',
        select: 'title duration description passingPercentage',
        populate: {
          path: 'tenantId',
          select: 'name code type'
        }
      })
      .populate('sessionId', 'startTime endTime qrCode')
      .populate('userId', 'name email')
      .populate('questionPaperId', 'setName')
      .populate('adminFlags.flaggedBy', 'name email')
      .populate('adminNotes.addedBy', 'name email');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Get all answers with question details
    const answers = await Answer.find({ attemptId: attempt._id })
      .populate('questionId', 'questionText questionType options points sectionId order passage imageUrl correctAnswer')
      .sort({ 'questionId.order': 1 })
      .lean();

    // Get sections if question paper exists
    let sections = [];
    if (attempt.questionPaperId) {
      sections = await Section.find({ questionPaperId: attempt.questionPaperId._id, isActive: true })
        .sort({ order: 1 })
        .lean();
    }

    // Get answer key for this exam with full details
    let answerKey = null;
    let answerKeyDetails = null;
    try {
      answerKey = await AnswerKey.findOne({ examId: attempt.examId._id, isActive: true })
        .populate('importedBy', 'name email')
        .lean();
      
      if (answerKey) {
        // Convert Map to object for JSON serialization
        const answersMap = answerKey.answers || new Map();
        const answersObj = {};
        if (answersMap instanceof Map) {
          answersMap.forEach((value, key) => {
            answersObj[key] = value;
          });
        } else if (typeof answersMap === 'object') {
          Object.assign(answersObj, answersMap);
        }
        
        answerKeyDetails = {
          _id: answerKey._id,
          version: answerKey.version,
          source: answerKey.source,
          appliedAt: answerKey.appliedAt,
          importedAt: answerKey.importedAt,
          importedBy: answerKey.importedBy,
          notes: answerKey.notes,
          answers: answersObj,
        };
      }
    } catch (err) {
      // Answer key might not exist
    }

    // Build section-wise breakdown
    const sectionBreakdown = {};
    const sectionTimers = attempt.sectionTimers || {};

    for (const section of sections) {
      const sectionAnswers = answers.filter(a => {
        if (!a.questionId || !a.questionId.sectionId) return false;
        const qSectionId = a.questionId.sectionId.toString();
        const sId = section._id?.toString() || section._id;
        return qSectionId === sId;
      });

      const sectionIdStr = section._id?.toString() || section._id;
      const timer = sectionTimers[section._id] || sectionTimers[sectionIdStr] || {};

      sectionBreakdown[sectionIdStr] = {
        section: {
          _id: section._id?.toString() || section._id,
          name: section.name || '',
          description: section.description || '',
          order: section.order || 0,
          duration: section.duration || 0,
          marks: section.marks || 0,
          negativeMarking: section.negativeMarking || 0,
        },
        questionsAttempted: sectionAnswers.length,
        timeSpent: timer.timeSpent || 0,
        marksObtained: sectionAnswers.reduce((sum, a) => sum + (Number(a.pointsEarned) || 0), 0),
        maxMarks: sectionAnswers.reduce((sum, a) => sum + (Number(a.questionId?.points) || 0), 0),
        isLocked: timer.isLocked || false,
        startTime: timer.startTime || null,
        endTime: timer.endTime || null,
      };
    }

    // Questions without sections
    const questionsWithoutSection = answers.filter(a => !a.questionId || !a.questionId.sectionId);
    if (questionsWithoutSection.length > 0) {
      sectionBreakdown['no-section'] = {
        section: null,
        questionsAttempted: questionsWithoutSection.length,
        timeSpent: 0,
        marksObtained: questionsWithoutSection.reduce((sum, a) => sum + (Number(a.pointsEarned) || 0), 0),
        maxMarks: questionsWithoutSection.reduce((sum, a) => sum + (Number(a.questionId?.points) || 0), 0),
        isLocked: false,
      };
    }

    // Calculate duration used
    let durationUsed = 0;
    if (attempt.startTime && attempt.submitTime) {
      durationUsed = Math.floor((new Date(attempt.submitTime) - new Date(attempt.startTime)) / 1000 / 60);
    } else if (attempt.startTime) {
      durationUsed = Math.floor((new Date() - new Date(attempt.startTime)) / 1000 / 60);
    }

    // Get violation summary
    const { getSuspiciousActivitySummary } = await import('../services/proctoringService.js');
    let violationSummary = null;
    try {
      violationSummary = await getSuspiciousActivitySummary(attempt._id);
    } catch (err) {
      // Violation summary might fail
    }

    // Convert attempt to object safely
    const attemptObj = attempt.toObject ? attempt.toObject() : attempt;

    res.json({
      attempt: {
        ...attemptObj,
        durationUsed,
      },
      answers: answers.map(a => {
        const question = a.questionId;
        return {
          _id: a._id?.toString() || a._id,
          questionId: question?._id?.toString() || question?._id || null,
          question: question ? {
            _id: question._id?.toString() || question._id,
            questionText: question.questionText || '',
            questionType: question.questionType || '',
            options: question.options || null,
            points: question.points || 0,
            sectionId: question.sectionId?.toString() || question.sectionId || null,
            order: question.order || 0,
            passage: question.passage || null,
            imageUrl: question.imageUrl || null,
            correctAnswer: question.correctAnswer || null,
          } : null,
          answerText: a.answerText || '',
          isCorrect: a.isCorrect || false,
          pointsEarned: a.pointsEarned || 0,
          timeSpent: a.timeSpent || 0,
          createdAt: a.createdAt || new Date(),
        };
      }),
      sectionBreakdown,
      answerKey: answerKeyDetails,
      violationSummary,
    });
  } catch (error) {
    next(error);
  }
});

// List all exam attempts (with filters)
router.get('/attempts', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, tenantId, examId, userId, isCompleted } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (tenantId) filter.tenantId = tenantId;
    if (examId) filter.examId = examId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';

    const [attempts, total] = await Promise.all([
      ExamAttempt.find(filter)
        .populate({
          path: 'examId',
          select: 'title tenantId',
          populate: {
            path: 'tenantId',
            select: 'name code type'
          }
        })
        .populate('userId', 'name email role')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ExamAttempt.countDocuments(filter),
    ]);

    res.json({
      attempts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get exam results with statistics (Super Admin - all tenants)
router.get('/results/exams', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;

    // Get all exams across all tenants
    const exams = await Exam.find()
      .populate('createdBy', 'name email')
      .populate('tenantId', 'name code')
      .sort({ createdAt: -1 });

    // Get statistics for each exam
    const examsWithStats = await Promise.all(
      exams.map(async (exam) => {
        const attempts = await ExamAttempt.find({
          examId: exam._id,
          isCompleted: true,
          isDisqualified: false,
        }).populate('userId', 'name email uniqueId');

        if (attempts.length === 0) {
          return {
            _id: exam._id,
            title: exam.title,
            description: exam.description,
            createdAt: exam.createdAt,
            tenantId: exam.tenantId,
            tenantName: exam.tenantId?.name || 'N/A',
            totalCandidates: 0,
            overallPercentage: 0,
            averageScore: 0,
            maxScore: 0,
            minScore: 0,
            averagePercentile: 0,
            averageNormalizedScore: 0,
          };
        }

        const scores = await Promise.all(
          attempts.map(async (attempt) => {
            const answers = await Answer.find({ attemptId: attempt._id })
              .populate('questionId', 'points');
            const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
            const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
            const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

            return {
              attemptId: attempt._id,
              userId: attempt.userId,
              totalScore,
              maxScore,
              percentage,
              normalizedScore: attempt.normalizedScore || null,
              percentile: attempt.percentile || null,
            };
          })
        );

        const totalScores = scores.reduce((sum, s) => sum + s.totalScore, 0);
        const totalMaxScores = scores.reduce((sum, s) => sum + s.maxScore, 0);
        const overallPercentage = totalMaxScores > 0 ? (totalScores / totalMaxScores) * 100 : 0;
        const averageScore = scores.reduce((sum, s) => sum + s.totalScore, 0) / scores.length;
        const maxScore = Math.max(...scores.map(s => s.totalScore));
        const minScore = Math.min(...scores.map(s => s.totalScore));
        const percentiles = scores.map(s => s.percentile).filter(p => p !== null);
        const normalizedScores = scores.map(s => s.normalizedScore).filter(s => s !== null);
        const averagePercentile = percentiles.length > 0
          ? percentiles.reduce((sum, p) => sum + p, 0) / percentiles.length
          : 0;
        const averageNormalizedScore = normalizedScores.length > 0
          ? normalizedScores.reduce((sum, s) => sum + s, 0) / normalizedScores.length
          : 0;

        return {
          _id: exam._id,
          title: exam.title,
          description: exam.description,
          createdAt: exam.createdAt,
          tenantId: exam.tenantId?._id || exam.tenantId,
          tenantName: exam.tenantId?.name || 'N/A',
          totalCandidates: attempts.length,
          overallPercentage: Math.round(overallPercentage * 100) / 100,
          averageScore: Math.round(averageScore * 100) / 100,
          maxScore,
          minScore,
          averagePercentile: Math.round(averagePercentile * 100) / 100,
          averageNormalizedScore: Math.round(averageNormalizedScore * 100) / 100,
        };
      })
    );

    res.json({ exams: examsWithStats });
  } catch (error) {
    next(error);
  }
});

// Get detailed results for a specific exam (Super Admin)
router.get('/results/exams/:examId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const { getNormalizationStats } = await import('../services/normalizationService.js');

    const exam = await Exam.findById(req.params.examId)
      .populate('tenantId', 'name code');

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const attempts = await ExamAttempt.find({
      examId: exam._id,
      isCompleted: true,
      isDisqualified: false,
    })
      .populate('userId', 'name email uniqueId')
      .sort({ createdAt: -1 });

    const candidates = await Promise.all(
      attempts.map(async (attempt) => {
        const answers = await Answer.find({ attemptId: attempt._id })
          .populate('questionId', 'points');
        const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
        const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
        const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

        return {
          attemptId: attempt._id,
          userId: attempt.userId._id,
          name: attempt.userId.name,
          email: attempt.userId.email,
          uniqueId: attempt.userId.uniqueId,
          totalScore,
          maxScore,
          percentage: Math.round(percentage * 100) / 100,
          normalizedScore: attempt.normalizedScore || null,
          percentile: attempt.percentile || null,
          sessionPercentile: attempt.sessionPercentile || null,
          rank: null,
        };
      })
    );

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    candidates.forEach((candidate, index) => {
      candidate.rank = index + 1;
    });

    const top5 = candidates.slice(0, 5);
    const bottom5 = candidates.slice(-5).reverse();

    const normalizationStats = await getNormalizationStats(exam._id);

    const scores = candidates.map(c => c.totalScore).sort((a, b) => a - b);
    const normalizedScores = candidates
      .map(c => c.normalizedScore)
      .filter(s => s !== null)
      .sort((a, b) => a - b);
    const percentiles = candidates
      .map(c => c.percentile)
      .filter(p => p !== null)
      .sort((a, b) => a - b);

    res.json({
      exam: {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        createdAt: exam.createdAt,
        tenantId: exam.tenantId?._id || exam.tenantId,
        tenantName: exam.tenantId?.name || 'N/A',
      },
      candidates,
      top5,
      bottom5,
      normalizationStats,
      scoreDistribution: {
        rawScores: scores,
        normalizedScores,
        percentiles,
      },
      totalCandidates: candidates.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
