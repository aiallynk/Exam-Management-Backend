import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamSession from '../models/ExamSession.js';
import AITokenUsage from '../models/AITokenUsage.js';
import Answer from '../models/Answer.js';
import SubTenant from '../models/SubTenant.js';
import SystemConfig from '../models/SystemConfig.js';
import TenantFeatureBilling from '../models/TenantFeatureBilling.js';
import CreditRequest from '../models/CreditRequest.js';
import { validatePasswordStrength, generateSecurePassword } from '../utils/passwordValidator.js';
import { createTenantUser, addRole, removeRole, assertEvaluatorRoleAllowed, UserRoleError } from '../services/userRoleService.js';
import { resolveTargetLocationForUserCreation, UserProvisioningScopeError } from '../services/userProvisioningScopeService.js';
import { AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { checkTenantLimits } from '../middleware/planLimits.js';
import {
  FREE_PLAN_MESSAGES,
  FREE_TRIAL_LIMITS,
  getSubscriptionPlanDefinition,
  isPlanFeatureEnabled,
  isTrialRestrictedPlan,
  resolveEffectivePlanType,
  resolveSubscriptionPlanType,
  resolveSubscriptionStatus,
} from '../config/planLimits.js';
import {
  blockFreePlanByUser,
  resolveUserEffectivePlanType,
  sendPlanRestriction,
} from '../middleware/planRestrictions.js';
import { getTenantAnalyticsDashboard } from '../services/analyticsService.js';
import { deleteUserAndCleanup } from '../services/userDeletionService.js';
import { normalizeCandidateAcademicProfile } from '../utils/candidateAcademicProfile.js';
import {
  getTenantAiGradingUsageSnapshot,
  toAiUsageResponsePayload,
} from '../services/aiGradingUsageService.js';
import {
  CREDIT_REQUEST_STATUSES,
  CREDIT_REQUEST_TYPES,
  applyExtraCreditsToPlanLimits,
  computeExtraUsageCost,
  normalizeCreditRequestType,
  normalizeTenantExtraCredits,
  resolveExtraCreditUnitPrice,
} from '../utils/creditSystem.js';
import {
  getAttemptCountForTenantByWindow,
  getCurrentMonthRange,
  getExamCountForTenantByWindow,
} from '../utils/planUsage.js';
import { getAIQuestionCountForTenantByWindow } from '../services/aiTokenUsageService.js';
import { resolveSessionEndTime } from './sessions.js';
import { hasRole } from '../utils/userRoles.js';

const router = express.Router();
const requireMultiTenantFeature = blockFreePlanByUser(
  FREE_PLAN_MESSAGES.MULTI_TENANT_LOCKED,
  'multiTenant'
);

// Organization-administration APIs are Tenant Admin owned. Exam Creator,
// Academic Admin, and Teacher work through their domain APIs/workspaces and
// never inherit tenant settings/users/backup access from this router.
router.use(requireAuth);
router.use(requireRole('TENANT_ADMIN'));

// Middleware to ensure tenant-scoped users have tenantId
router.use((req, res, next) => {
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'Tenant-scoped account must be assigned to a tenant' });
  }
  next();
});

// Organization identity (name / code / contact) — editable by the Tenant
// Admin from Settings → Organization Profile. Additive; email is the account
// email and is NOT changed here.
router.put(
  '/organization-profile',
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('contactPhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('contactEmail').optional().isString().trim().isEmail(),
    body('address').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const tenant = await Tenant.findById(req.user.tenantId);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

      // `code` (unique routing key) and `type` are deliberately NOT editable here.
      const before = { name: tenant.name, contactPhone: tenant.contactPhone, contactEmail: tenant.contactEmail, address: tenant.address };
      if (typeof req.body.name === 'string' && req.body.name.trim()) tenant.name = req.body.name.trim();
      if (typeof req.body.contactEmail === 'string' && req.body.contactEmail.trim()) tenant.contactEmail = req.body.contactEmail.trim().toLowerCase();
      if (req.body.contactPhone !== undefined) tenant.contactPhone = String(req.body.contactPhone || '').trim();
      if (req.body.address !== undefined) tenant.address = String(req.body.address || '').trim();
      await tenant.save();
      await logAuditEvent(AUDIT_ACTIONS.TENANT_UPDATED, {
        userId: req.user._id, tenantId: tenant._id, resourceType: 'Tenant', resourceId: tenant._id,
        method: req.method, path: req.path, before,
        after: { name: tenant.name, contactPhone: tenant.contactPhone, contactEmail: tenant.contactEmail, address: tenant.address },
      }).catch(() => {});

      res.json({
        tenant: {
          _id: tenant._id, name: tenant.name, code: tenant.code, type: tenant.type,
          contactPhone: tenant.contactPhone, contactEmail: tenant.contactEmail, address: tenant.address,
        },
      });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: 'That contact email is already in use.' });
      next(error);
    }
  }
);

const BULK_IMPORT_MAX_ROWS = 500;
const BULK_IMPORT_ALLOWED_ROLES = new Set(['EXAM_CREATOR', 'CANDIDATE']);
const BULK_IMPORT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BULK_IMPORT_ROLE_LIMITS = Object.freeze({
  EXAM_CREATOR: FREE_TRIAL_LIMITS.maxExamCreators,
  CANDIDATE: FREE_TRIAL_LIMITS.maxCandidates,
});

const BULK_IMPORT_ROLE_QUERY_VALUES = Object.freeze({
  EXAM_CREATOR: ['EXAM_CREATOR', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'ADMIN', 'DESIGNER', 'TEACHER'],
  CANDIDATE: ['CANDIDATE', 'USER', 'STUDENT'],
});
const SUB_TENANT_ALLOWED_STATUS = new Set(['ACTIVE', 'INACTIVE']);
const FEATURE_BILLING_ALLOWED_PLAN_TYPES = new Set(['legend', 'enterprise']);
const FEATURE_BILLING_ALLOWED_ROLE = 'TENANT_ADMIN';
const FEATURE_BILLING_AI_UNIT_PRICE_INR = 0.5;
const FEATURE_BILLING_UPGRADE_PATH = '/pricing';
const FEATURE_BILLING_FEATURES = Object.freeze([
  { key: 'examCreation', label: 'Exam Creation', price: 50 },
  { key: 'analytics', label: 'Analytics', price: 40 },
  { key: 'proctoring', label: 'Proctoring', price: 100 },
]);
const FEATURE_BILLING_DEFAULT_SELECTION = Object.freeze({
  examCreation: true,
  analytics: true,
  proctoring: false,
});
const CREDIT_REQUEST_ALLOWED_TYPES = new Set(Object.values(CREDIT_REQUEST_TYPES));
const CREDIT_REQUEST_ALLOWED_STATUSES = new Set(Object.values(CREDIT_REQUEST_STATUSES));
const CREDIT_REQUEST_MAX_AMOUNT = 1000000;
const DUPLICATE_EXAM_NAME_MESSAGE =
  'Exam name already exists. Please use a different name.';
const CREDIT_REQUEST_TYPE_CONFIG = Object.freeze({
  [CREDIT_REQUEST_TYPES.AI]: {
    limitKey: 'maxAiQuestionsPerMonth',
    extraCreditKey: 'ai',
    usageLabel: 'AI Questions',
  },
  [CREDIT_REQUEST_TYPES.ATTEMPTS]: {
    limitKey: 'maxAttemptsPerMonth',
    extraCreditKey: 'attempts',
    usageLabel: 'Attempts',
  },
  [CREDIT_REQUEST_TYPES.EXAMS]: {
    limitKey: 'maxExamsPerMonth',
    extraCreditKey: 'exams',
    usageLabel: 'Exams',
  },
});

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const resolveExamCode = (examDoc) =>
  String(examDoc?.exam_code || examDoc?.uniqueId || examDoc?.examCode || '').trim();

const parseDateBoundary = (value, boundary = 'start') => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly
    ? `${raw}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}`
    : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseQueryDateRange = (query = {}) => {
  const startDate = parseDateBoundary(
    query.startDate || query.fromDate || query.dateFrom || query.from,
    'start'
  );
  const endDate = parseDateBoundary(
    query.endDate || query.toDate || query.dateTo || query.to,
    'end'
  );
  return { startDate, endDate };
};

const withExamCode = (examDoc) => {
  if (!examDoc) return examDoc;

  const normalized =
    typeof examDoc?.toObject === 'function' ? examDoc.toObject() : { ...examDoc };
  if (!normalized || typeof normalized !== 'object') {
    return normalized;
  }

  return {
    ...normalized,
    exam_id: normalized._id ? String(normalized._id) : normalized.exam_id || '',
    exam_code: resolveExamCode(normalized),
  };
};

const buildTenantScopedExamNameFilter = ({ title, tenantId, excludeExamId = null }) => {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle || !tenantId) {
    return null;
  }

  const filter = {
    title: new RegExp(`^${escapeRegExp(normalizedTitle)}$`, 'i'),
    tenantId,
    isActive: true,
  };

  if (excludeExamId) {
    filter._id = { $ne: excludeExamId };
  }

  return filter;
};

const findDuplicateExamByTitle = async ({ title, tenantId, excludeExamId = null }) => {
  const duplicateFilter = buildTenantScopedExamNameFilter({
    title,
    tenantId,
    excludeExamId,
  });
  if (!duplicateFilter) return null;

  return Exam.findOne(duplicateFilter).select('_id').lean();
};

const toFiniteLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const normalizeFeatureBillingPlanType = (value) => String(value || '').trim().toLowerCase();

const isFeatureBillingPlanAllowed = (planTypeValue) => {
  const normalized = normalizeFeatureBillingPlanType(planTypeValue);
  if (!normalized) return false;
  if (FEATURE_BILLING_ALLOWED_PLAN_TYPES.has(normalized)) return true;
  const resolved = resolveSubscriptionPlanType(normalized);
  return FEATURE_BILLING_ALLOWED_PLAN_TYPES.has(resolved);
};

const normalizeFeatureBillingSelection = (value) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = { ...FEATURE_BILLING_DEFAULT_SELECTION };

  FEATURE_BILLING_FEATURES.forEach((feature) => {
    if (typeof source[feature.key] === 'boolean') {
      normalized[feature.key] = source[feature.key];
    }
  });

  return normalized;
};

const toMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
};

const resolveTenantPlanLimitsWithoutExtraCredits = (tenant = null, effectivePlanType = null) => {
  const resolvedPlanType = resolveSubscriptionPlanType(
    effectivePlanType || tenant?.subscription?.planType || 'free'
  );
  const planDefinition = getSubscriptionPlanDefinition(resolvedPlanType);
  const baseLimits = planDefinition?.limits || {};
  const customLimits =
    tenant?.subscription?.customLimits &&
    typeof tenant.subscription.customLimits === 'object' &&
    !Array.isArray(tenant.subscription.customLimits)
      ? tenant.subscription.customLimits
      : {};

  const resolvePlanLimitWithOverride = (key, legacyValue = null, baseValue = null) => {
    if (Object.prototype.hasOwnProperty.call(customLimits, key)) {
      const rawValue = customLimits[key];
      if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
        if (Number(rawValue) === -1) return null;
        return toFiniteLimit(rawValue);
      }
    }
    if (
      key === 'maxImportFiles' &&
      Object.prototype.hasOwnProperty.call(customLimits, 'importQuestionsPerMonth')
    ) {
      const aliasValue = customLimits.importQuestionsPerMonth;
      if (aliasValue !== null && aliasValue !== undefined && aliasValue !== '') {
        if (Number(aliasValue) === -1) return null;
        return toFiniteLimit(aliasValue);
      }
    }
    const legacy = toFiniteLimit(legacyValue);
    if (legacy !== null) return legacy;
    return toFiniteLimit(baseValue);
  };

  return {
    maxExamsPerMonth: resolvePlanLimitWithOverride(
      'maxExamsPerMonth',
      tenant?.examLimit,
      baseLimits?.maxExamsPerMonth
    ),
    maxAttemptsPerMonth: resolvePlanLimitWithOverride(
      'maxAttemptsPerMonth',
      tenant?.attemptLimit,
      baseLimits?.maxAttemptsPerMonth
    ),
    maxAiQuestionsPerMonth: resolvePlanLimitWithOverride(
      'maxAiQuestionsPerMonth',
      tenant?.aiUsageLimit,
      baseLimits?.maxAiQuestionsPerMonth
    ),
    maxImportFiles: resolvePlanLimitWithOverride(
      'maxImportFiles',
      null,
      baseLimits?.importQuestionsPerMonth ?? baseLimits?.maxImportFiles
    ),
  };
};

const resolveCreditRequestTypeSummary = async ({
  type,
  tenantId,
  tenant = null,
  effectivePlanType = null,
} = {}) => {
  const normalizedType = normalizeCreditRequestType(type);
  if (!normalizedType || !CREDIT_REQUEST_TYPE_CONFIG[normalizedType]) {
    return null;
  }

  const planLimits = resolveTenantPlanLimitsWithoutExtraCredits(tenant, effectivePlanType);
  const extraCredits = normalizeTenantExtraCredits(tenant?.extraCredits);
  const totalLimits = applyExtraCreditsToPlanLimits(planLimits, extraCredits);
  const config = CREDIT_REQUEST_TYPE_CONFIG[normalizedType];
  const limitKey = config.limitKey;

  const { start, end } = getCurrentMonthRange();
  const [usage] = await Promise.all([
    normalizedType === CREDIT_REQUEST_TYPES.EXAMS
      ? getExamCountForTenantByWindow(tenantId, start, end)
      : normalizedType === CREDIT_REQUEST_TYPES.ATTEMPTS
        ? getAttemptCountForTenantByWindow(tenantId, start, end)
        : getAIQuestionCountForTenantByWindow(tenantId, start, end),
  ]);

  const baseLimit = planLimits?.[limitKey] ?? null;
  const totalLimit = totalLimits?.[limitKey] ?? null;
  const extraCreditAmount = Number(extraCredits?.[config.extraCreditKey]) || 0;
  const { extraUsage, unitPrice, extraCost } = computeExtraUsageCost({
    usage,
    baseLimit,
    type: normalizedType,
  });

  return {
    type: normalizedType,
    label: config.usageLabel,
    usage: Number(usage) || 0,
    baseLimit,
    totalLimit,
    extraCredits: extraCreditAmount,
    extraUsage,
    unitPrice,
    extraCost,
    monthWindow: {
      start,
      end,
    },
  };
};

const toMongoObjectId = (value) => {
  const raw = String(value || '').trim();
  if (!/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
};

const getCurrentIstMonthRange = (referenceDate = new Date()) => {
  const IST_OFFSET_MINUTES = 330;
  const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
  const safeNow =
    referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
  const istNow = new Date(safeNow.getTime() + offsetMs);

  const istMonthStart = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1, 0, 0, 0, 0)
  );
  const istNextMonthStart = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  );

  return {
    start: new Date(istMonthStart.getTime() - offsetMs),
    end: new Date(istNextMonthStart.getTime() - offsetMs),
  };
};

const buildFeatureBillingAccessState = (req, tenantPlanType) => {
  const roleAllowed = req.user?.role === FEATURE_BILLING_ALLOWED_ROLE;
  const planAllowed = isFeatureBillingPlanAllowed(tenantPlanType || req.user?.planType);
  return {
    roleAllowed,
    planAllowed,
    allowed: roleAllowed && planAllowed,
  };
};

const buildFeatureBillingDeniedPayload = (accessState) => {
  const roleMessage =
    'This feature is available only for tenant administrators on LEGEND / ENTERPRISE plans.';
  const planMessage = 'This feature is available only for LEGEND / ENTERPRISE plans.';
  return {
    error: accessState?.planAllowed ? roleMessage : planMessage,
    allowedPlans: ['LEGEND', 'ENTERPRISE'],
    upgradePath: FEATURE_BILLING_UPGRADE_PATH,
  };
};

const buildFeatureBillingSummary = async ({
  tenantId,
  tenantPlanType,
  selectedFeatures,
}) => {
  const normalizedSelection = normalizeFeatureBillingSelection(selectedFeatures);
  const resolvedPlanType = resolveSubscriptionPlanType(tenantPlanType || '');
  const effectivePlanType = resolvedPlanType || 'legend';
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const basePlanPrice = toMoney(planDefinition?.price ?? 0);

  const features = FEATURE_BILLING_FEATURES.map((feature) => ({
    key: feature.key,
    label: feature.label,
    price: feature.price,
    enabled: Boolean(normalizedSelection[feature.key]),
  }));

  const selectedFeatureTotal = toMoney(
    features.reduce(
      (sum, feature) => sum + (feature.enabled ? Number(feature.price) || 0 : 0),
      0
    )
  );

  const { start, end } = getCurrentIstMonthRange();
  const tenantObjectId = toMongoObjectId(tenantId);
  const aiUsagePipeline =
    tenantObjectId
      ? [
          {
            $match: {
              tenant_id: tenantObjectId,
              request_status: 'SUCCESS',
              created_at: { $gte: start, $lt: end },
            },
          },
          {
            $group: {
              _id: null,
              questionCount: { $sum: { $ifNull: ['$question_count', 0] } },
              usageCount: { $sum: { $ifNull: ['$usage_count', 0] } },
            },
          },
        ]
      : [];
  const [aiUsageAggregate] = aiUsagePipeline.length
    ? await AITokenUsage.aggregate(aiUsagePipeline)
    : [];

  const questionCount = Number(aiUsageAggregate?.questionCount) || 0;
  const usageCount = Number(aiUsageAggregate?.usageCount) || 0;
  const aiUsedThisMonth = questionCount > 0 ? questionCount : usageCount;
  const aiUsageCost = toMoney(aiUsedThisMonth * FEATURE_BILLING_AI_UNIT_PRICE_INR);

  const total = toMoney(basePlanPrice + selectedFeatureTotal + aiUsageCost);

  return {
    planType: String(resolvedPlanType || tenantPlanType || '')
      .trim()
      .toUpperCase(),
    basePlanPrice,
    features,
    selectedFeatures: normalizedSelection,
    aiUsage: {
      used: aiUsedThisMonth,
      unitPrice: FEATURE_BILLING_AI_UNIT_PRICE_INR,
      cost: aiUsageCost,
      monthWindow: { start, end },
    },
    totals: {
      basePlan: basePlanPrice,
      features: selectedFeatureTotal,
      aiUsage: aiUsageCost,
      total,
    },
    currency: 'INR',
  };
};

const buildActorAuditDetails = (req) => ({
  userId: req.user?._id || null,
  userEmail: req.user?.email || null,
  userName: req.user?.name || null,
  userRole: req.user?.role || null,
  tenantId: req.user?.tenantId || null,
  ip: req.ip,
  userAgent: req.get('user-agent'),
  method: req.method,
  path: req.path,
});

const normalizeBulkHeader = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

const getBulkRowValue = (row, key) => {
  if (!row || typeof row !== 'object') return '';
  if (row[key] !== undefined) return row[key];

  const expected = normalizeBulkHeader(key);
  const matchedEntry = Object.entries(row).find(([header]) => normalizeBulkHeader(header) === expected);
  return matchedEntry ? matchedEntry[1] : '';
};

const toTrimmedString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeSubTenantCode = (value = '') =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);

const normalizeBulkImportRow = (row) => {
  const name = toTrimmedString(getBulkRowValue(row, 'Name'));
  const email = toTrimmedString(getBulkRowValue(row, 'Email')).toLowerCase();
  const password = toTrimmedString(getBulkRowValue(row, 'Password'));
  const requestedRole = toTrimmedString(getBulkRowValue(row, 'Role')).toUpperCase();
  const normalizedRole = requestedRole.replace(/[\s-]+/g, '_');
  const role = normalizedRole || 'CANDIDATE';

  const academicProfile = normalizeCandidateAcademicProfile({
    rollNumber: getBulkRowValue(row, 'Roll Number') || getBulkRowValue(row, 'Roll No'),
    grade: getBulkRowValue(row, 'Grade'),
    section: getBulkRowValue(row, 'Section') || getBulkRowValue(row, 'Division') || getBulkRowValue(row, 'Class'),
    externalStudentId: getBulkRowValue(row, 'Student ID') || getBulkRowValue(row, 'External Student ID'),
  });

  return { name, email, password, role, academicProfile };
};

const ensureTenantAdminBulkAccess = (req, res) => {
  if (!hasRole(req.user, 'TENANT_ADMIN')) {
    res.status(403).json({ error: 'Only tenant admins can bulk import users' });
    return false;
  }
  return true;
};

const ensureTenantAdminAccess = (req, res, message = 'Only tenant admins can access this resource') => {
  if (!hasRole(req.user, 'TENANT_ADMIN')) {
    res.status(403).json({ error: message });
    return false;
  }
  return true;
};

const resolveValidatedSubTenantId = async ({
  tenantId,
  subTenantId,
  allowInactive = false,
} = {}) => {
  const normalizedSubTenantId = String(subTenantId || '').trim();
  if (!normalizedSubTenantId) return null;

  if (!/^[a-fA-F0-9]{24}$/.test(normalizedSubTenantId)) {
    return null;
  }

  const filter = {
    _id: normalizedSubTenantId,
    tenantId,
  };
  if (!allowInactive) {
    filter.status = 'ACTIVE';
  }

  const subTenant = await SubTenant.findOne(filter).select('_id').lean();
  return subTenant?._id || null;
};

const getBulkImportRoleAllowance = async (req) => {
  const [currentActor, tenant] = await Promise.all([
    User.findById(req.user._id).select('planType').lean(),
    Tenant.findById(req.user.tenantId).select('subscription').lean(),
  ]);

  const subscription = tenant?.subscription || {};
  const effectivePlanType = resolveEffectivePlanType(
    subscription?.planType || currentActor?.planType || null,
    resolveSubscriptionStatus(subscription)
  );

  let examCreatorLimit = null;
  let candidateLimit = null;

  if (isTrialRestrictedPlan(effectivePlanType)) {
    examCreatorLimit = BULK_IMPORT_ROLE_LIMITS.EXAM_CREATOR;
    candidateLimit = BULK_IMPORT_ROLE_LIMITS.CANDIDATE;
  } else {
    const planLimits = getSubscriptionPlanDefinition(effectivePlanType)?.limits || {};
    examCreatorLimit = toFiniteLimit(planLimits.maxExamCreators);
    candidateLimit = toFiniteLimit(planLimits.maxCandidates);
  }

  if (examCreatorLimit === null && candidateLimit === null) {
    return {
      EXAM_CREATOR: Number.POSITIVE_INFINITY,
      CANDIDATE: Number.POSITIVE_INFINITY,
    };
  }

  const [existingCreators, existingCandidates] = await Promise.all([
    User.countDocuments({
      tenantId: req.user.tenantId,
      role: { $in: BULK_IMPORT_ROLE_QUERY_VALUES.EXAM_CREATOR },
      status: { $ne: 'INACTIVE' },
    }),
    User.countDocuments({
      tenantId: req.user.tenantId,
      role: { $in: BULK_IMPORT_ROLE_QUERY_VALUES.CANDIDATE },
      status: { $ne: 'INACTIVE' },
    }),
  ]);

  return {
    EXAM_CREATOR:
      examCreatorLimit === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, examCreatorLimit - existingCreators),
    CANDIDATE:
      candidateLimit === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, candidateLimit - existingCandidates),
  };
};

const toPreviewRow = (preparedRow) => ({
  rowNumber: preparedRow.rowNumber,
  status: preparedRow.status,
  data: {
    name: preparedRow.name,
    email: preparedRow.email,
    role: preparedRow.role,
    academicProfile: preparedRow.academicProfile,
  },
  errors: preparedRow.errors,
  warning: preparedRow.warning,
});

const toFailureReason = (preparedRow) => {
  if (preparedRow.errors.length > 0) return preparedRow.errors.join(' ');
  if (preparedRow.warning) return preparedRow.warning;
  return 'Row skipped.';
};

const prepareBulkImportRows = async (rows, req) => {
  const limitedRows = rows.slice(0, BULK_IMPORT_MAX_ROWS);
  const truncated = rows.length > BULK_IMPORT_MAX_ROWS;

  const preparedRows = limitedRows.map((row, index) => {
    const normalized = normalizeBulkImportRow(row);
    return {
      rowNumber: index + 2, // +1 for 1-based row index and +1 for header row
      ...normalized,
      status: 'valid',
      errors: [],
      warning: '',
    };
  });

  const fileEmailToRowNumbers = new Map();
  for (const row of preparedRows) {
    if (!row.email) continue;
    const currentRows = fileEmailToRowNumbers.get(row.email) || [];
    currentRows.push(row.rowNumber);
    fileEmailToRowNumbers.set(row.email, currentRows);
  }

  const roleAllowance = await getBulkImportRoleAllowance(req);
  const candidateEmails = preparedRows
    .map((row) => row.email)
    .filter((email) => Boolean(email));
  const uniqueCandidateEmails = [...new Set(candidateEmails)];

  const existingUsers = uniqueCandidateEmails.length
    ? await User.find({ email: { $in: uniqueCandidateEmails } }).select('email').lean()
    : [];
  const existingEmailSet = new Set(
    existingUsers.map((user) => toTrimmedString(user.email).toLowerCase()).filter(Boolean)
  );

  for (const row of preparedRows) {
    if (!row.name) {
      row.errors.push('Name is required.');
    }

    if (!row.email) {
      row.errors.push('Email is required.');
    } else if (!BULK_IMPORT_EMAIL_PATTERN.test(row.email)) {
      row.errors.push('Valid email is required.');
    }

    if (!row.password) {
      row.errors.push('Password is required.');
    } else if (row.password.length < 6) {
      row.errors.push('Password must be at least 6 characters.');
    }

    if (!BULK_IMPORT_ALLOWED_ROLES.has(row.role)) {
      row.errors.push('Role must be EXAM_CREATOR or CANDIDATE.');
    }
    if (
      false
    ) {}

    if (row.errors.length > 0) {
      row.status = 'invalid';
      continue;
    }

    if (existingEmailSet.has(row.email)) {
      row.status = 'duplicate';
      row.warning = 'Email already registered.';
      continue;
    }

    const matchingRowNumbers = fileEmailToRowNumbers.get(row.email) || [];
    if (matchingRowNumbers.length > 1) {
      row.status = 'duplicate';
      row.warning = `Duplicate email in uploaded file (rows ${matchingRowNumbers.join(', ')}).`;
      continue;
    }

    const remainingForRole = roleAllowance[row.role];
    if (Number.isFinite(remainingForRole) && remainingForRole <= 0) {
      row.status = 'invalid';
      row.errors.push(`${row.role.replace('_', ' ')} limit reached for current plan.`);
      continue;
    }

    if (Number.isFinite(roleAllowance[row.role])) {
      roleAllowance[row.role] -= 1;
    }
  }

  const summary = {
    totalRows: preparedRows.length,
    validRows: preparedRows.filter((row) => row.status === 'valid').length,
    invalidRows: preparedRows.filter((row) => row.status === 'invalid').length,
    duplicateRows: preparedRows.filter((row) => row.status === 'duplicate').length,
  };
  summary.failedRows = summary.invalidRows + summary.duplicateRows;

  return {
    preparedRows,
    previewRows: preparedRows.map(toPreviewRow),
    summary,
    truncated,
    maxRows: BULK_IMPORT_MAX_ROWS,
  };
};

/**
 * TENANT ADMIN DASHBOARD STATS
 * GET /api/tenant-admin/stats
 */
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;

    // Calculate today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Calculate today's sessions range
    const now = new Date();

    const [
      totalExams,
      activeExams,
      totalExamAttempts,
      completedAttempts,
      todayAttempts,
      totalSessions,
      activeSessions,
      totalCandidates,
    ] = await Promise.all([
      Exam.countDocuments({ tenantId }),
      Exam.countDocuments({ tenantId, isActive: true }),
      ExamAttempt.countDocuments({ tenantId }),
      ExamAttempt.countDocuments({ tenantId, isCompleted: true }),
      ExamAttempt.countDocuments({
        tenantId,
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      ExamSession.countDocuments({ tenantId }),
      ExamSession.countDocuments({ tenantId, endTime: { $gte: now } }),
      User.countDocuments({ tenantId, role: 'CANDIDATE' }),
    ]);

    // Get pending results: completed attempts where results not released
    const completedAttemptsNotReleased = await ExamAttempt.aggregate([
      {
        $match: {
          tenantId,
          isCompleted: true,
          isDisqualified: false,
        },
      },
      {
        $lookup: {
          from: 'exams',
          localField: 'examId',
          foreignField: '_id',
          as: 'exam',
        },
      },
      {
        $unwind: '$exam',
      },
      {
        $match: {
          $or: [
            { 'exam.showResultsImmediately': false, 'exam.resultsReleasedAt': null },
            { 'exam.showResultsImmediately': false, 'exam.resultsReleasedAt': { $exists: false } },
          ],
        },
      },
      {
        $count: 'count',
      },
    ]);

    const completedNotReleased = completedAttemptsNotReleased[0]?.count || 0;
    const inProgress = totalExamAttempts - completedAttempts;

    // Get active exams list (last 5)
    const activeExamsList = await Exam.find({ tenantId, isActive: true })
      .select('_id title isActive createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Get today's sessions
    const todaySessions = await ExamSession.find({
      tenantId,
      startTime: { $lte: todayEnd },
      endTime: { $gte: todayStart },
    })
      .select('_id examId startTime endTime isActive')
      .populate('examId', 'title')
      .sort({ startTime: 1 })
      .limit(10)
      .lean();

    // Get recent attempts (last 5)
    const recentAttempts = await ExamAttempt.find({ tenantId })
      .select('_id userId examId isCompleted isDisqualified createdAt')
      .populate('userId', 'name email')
      .populate('examId', 'title')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Get tenant info
    const tenant = await Tenant.findById(tenantId)
      .select(
        'name code type status subscription ai_usage_count ai_usage_limit ai_usage_reset_date'
      )
      .lean();
    const aiUsageSnapshot = await getTenantAiGradingUsageSnapshot({
      tenantId,
      tenant,
    });

    res.json({
      tenant,
      ai_usage: toAiUsageResponsePayload(aiUsageSnapshot),
      exams: {
        total: totalExams,
        active: activeExams,
      },
      attempts: {
        total: totalExamAttempts,
        completed: completedAttempts,
        todayAttempts,
      },
      sessions: {
        total: totalSessions,
        active: activeSessions,
      },
      totalCandidates,
      pendingResults: {
        completedNotReleased,
        inProgress,
      },
      activeExamsList: activeExamsList.map(e => ({
        _id: e._id,
        title: e.title,
        isActive: e.isActive,
        createdAt: e.createdAt,
      })),
      todaySessions: todaySessions.map(s => ({
        _id: s._id,
        examId: s.examId?._id || s.examId,
        examTitle: s.examId?.title || 'N/A',
        startTime: s.startTime,
        endTime: s.endTime,
        isActive: s.isActive,
      })),
      recentAttempts: recentAttempts.map(a => ({
        _id: a._id,
        userId: a.userId?._id || a.userId,
        userName: a.userId?.name || 'N/A',
        userEmail: a.userId?.email || 'N/A',
        examId: a.examId?._id || a.examId,
        examTitle: a.examId?.title || 'N/A',
        isCompleted: a.isCompleted,
        isDisqualified: a.isDisqualified,
        createdAt: a.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/analytics',
  blockFreePlanByUser(FREE_PLAN_MESSAGES.ANALYTICS_LOCKED, 'analytics'),
  async (req, res, next) => {
  try {
    const effectivePlanType = await resolveUserEffectivePlanType(req.user);
    const includeAdvancedAnalytics = isPlanFeatureEnabled(
      effectivePlanType,
      'advancedAnalytics'
    );
    const requestedExamId = req.query.examId || req.query.specificExamId || null;
    const { startDate, endDate } = parseQueryDateRange(req.query);

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
      planContext: {
        planType: effectivePlanType,
        advancedAnalytics: includeAdvancedAnalytics,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * FEATURE BILLING (LEGEND / ENTERPRISE ONLY)
 */

router.get('/feature-billing/eligibility', async (req, res, next) => {
  try {
    const accessState = buildFeatureBillingAccessState(req, req.user?.subscriptionPlanType);
    const resolvedPlanType = resolveSubscriptionPlanType(
      req.user?.subscriptionPlanType || req.user?.planType || ''
    );

    return res.json({
      success: true,
      allowed: accessState.allowed,
      roleAllowed: accessState.roleAllowed,
      planAllowed: accessState.planAllowed,
      planType: String(resolvedPlanType || req.user?.planType || '')
        .trim()
        .toUpperCase(),
      allowedPlans: ['LEGEND', 'ENTERPRISE'],
      upgradePath: FEATURE_BILLING_UPGRADE_PATH,
      message: accessState.allowed
        ? ''
        : buildFeatureBillingDeniedPayload(accessState).error,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/feature-billing', async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.user.tenantId)
      .select('name code subscription')
      .lean();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantPlanType =
      tenant?.subscription?.planType ||
      req.user?.subscriptionPlanType ||
      req.user?.planType ||
      '';
    const accessState = buildFeatureBillingAccessState(req, tenantPlanType);
    if (!accessState.allowed) {
      return res.status(403).json(buildFeatureBillingDeniedPayload(accessState));
    }

    const savedSettings = await TenantFeatureBilling.findOne({
      tenantId: req.user.tenantId,
    }).lean();
    const selectedFeatures = normalizeFeatureBillingSelection(savedSettings?.selectedFeatures);

    const summary = await buildFeatureBillingSummary({
      tenantId: req.user.tenantId,
      tenantPlanType,
      selectedFeatures,
    });

    return res.json({
      success: true,
      data: {
        tenantId: String(req.user.tenantId),
        tenantName: tenant.name || '',
        tenantCode: tenant.code || '',
        ...summary,
        updatedAt: savedSettings?.updatedAt || savedSettings?.createdAt || null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/feature-billing', async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.user.tenantId)
      .select('name code subscription')
      .lean();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantPlanType =
      tenant?.subscription?.planType ||
      req.user?.subscriptionPlanType ||
      req.user?.planType ||
      '';
    const accessState = buildFeatureBillingAccessState(req, tenantPlanType);
    if (!accessState.allowed) {
      return res.status(403).json(buildFeatureBillingDeniedPayload(accessState));
    }

    const incomingFeatures =
      req.body?.features && typeof req.body.features === 'object'
        ? req.body.features
        : req.body?.selectedFeatures;

    if (!incomingFeatures || typeof incomingFeatures !== 'object' || Array.isArray(incomingFeatures)) {
      return res.status(400).json({
        error: 'features payload is required and must be an object.',
      });
    }

    const normalizedSelection = normalizeFeatureBillingSelection(incomingFeatures);

    const savedSettings = await TenantFeatureBilling.findOneAndUpdate(
      { tenantId: req.user.tenantId },
      {
        $set: {
          selectedFeatures: normalizedSelection,
          updatedBy: req.user?._id || null,
        },
        $setOnInsert: {
          createdBy: req.user?._id || null,
        },
      },
      {
        new: true,
        upsert: true,
      }
    ).lean();

    const summary = await buildFeatureBillingSummary({
      tenantId: req.user.tenantId,
      tenantPlanType,
      selectedFeatures: savedSettings?.selectedFeatures,
    });

    return res.json({
      success: true,
      data: {
        tenantId: String(req.user.tenantId),
        tenantName: tenant.name || '',
        tenantCode: tenant.code || '',
        ...summary,
        updatedAt: savedSettings?.updatedAt || savedSettings?.createdAt || null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * CREDIT REQUESTS
 */

router.get('/credit-requests/overview', async (req, res, next) => {
  if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can request extra credits')) return;

  try {
    const tenant = await Tenant.findById(req.user.tenantId)
      .select('name code subscription examLimit attemptLimit aiUsageLimit extraCredits')
      .lean();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const subscription = tenant?.subscription || {};
    const effectivePlanType = resolveEffectivePlanType(
      subscription?.planType || req.user?.planType || null,
      resolveSubscriptionStatus(subscription)
    );

    const [summaries, pendingCount, approvedCount, rejectedCount] = await Promise.all([
      Promise.all(
        Object.values(CREDIT_REQUEST_TYPES).map((type) =>
          resolveCreditRequestTypeSummary({
            type,
            tenantId: req.user.tenantId,
            tenant,
            effectivePlanType,
          })
        )
      ),
      CreditRequest.countDocuments({
        tenantId: req.user.tenantId,
        status: CREDIT_REQUEST_STATUSES.PENDING,
      }),
      CreditRequest.countDocuments({
        tenantId: req.user.tenantId,
        status: CREDIT_REQUEST_STATUSES.APPROVED,
      }),
      CreditRequest.countDocuments({
        tenantId: req.user.tenantId,
        status: CREDIT_REQUEST_STATUSES.REJECTED,
      }),
    ]);

    return res.json({
      success: true,
      data: {
        tenantId: String(req.user.tenantId),
        tenantName: tenant?.name || '',
        tenantCode: tenant?.code || '',
        planType: String(effectivePlanType || '').toUpperCase(),
        summaryByType: summaries.filter(Boolean),
        totals: {
          pending: pendingCount,
          approved: approvedCount,
          rejected: rejectedCount,
        },
        extraCredits: normalizeTenantExtraCredits(tenant?.extraCredits),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/credit-requests', async (req, res, next) => {
  if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can view credit requests')) return;

  try {
    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
    const limit = Math.min(100, Math.max(parseInt(req.query?.limit, 10) || 20, 1));
    const skip = (page - 1) * limit;
    const statusFilterRaw = String(req.query?.status || 'all')
      .trim()
      .toUpperCase();
    const typeFilter = normalizeCreditRequestType(req.query?.type || '');

    const filter = { tenantId: req.user.tenantId };
    if (statusFilterRaw !== 'ALL') {
      if (!CREDIT_REQUEST_ALLOWED_STATUSES.has(statusFilterRaw)) {
        return res.status(400).json({
          error: 'status must be ALL, PENDING, APPROVED, or REJECTED',
        });
      }
      filter.status = statusFilterRaw;
    }
    if (typeFilter) {
      filter.type = typeFilter;
    }

    const [requests, total] = await Promise.all([
      CreditRequest.find(filter)
        .populate('requestedBy', 'name email')
        .populate('reviewedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CreditRequest.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      requests: (Array.isArray(requests) ? requests : []).map((request) => ({
        id: request?._id ? String(request._id) : null,
        tenantId: request?.tenantId ? String(request.tenantId) : null,
        type: request?.type || '',
        requestedAmount: Number(request?.requestedAmount) || 0,
        status: request?.status || CREDIT_REQUEST_STATUSES.PENDING,
        comment: request?.comment || '',
        reviewNote: request?.reviewNote || '',
        unitPriceInr: Number(request?.unitPriceInr) || 0,
        requestedBy: request?.requestedBy
          ? {
              id: request.requestedBy?._id ? String(request.requestedBy._id) : null,
              name: request.requestedBy?.name || '',
              email: request.requestedBy?.email || '',
            }
          : null,
        reviewedBy: request?.reviewedBy
          ? {
              id: request.reviewedBy?._id ? String(request.reviewedBy._id) : null,
              name: request.reviewedBy?.name || '',
              email: request.reviewedBy?.email || '',
            }
          : null,
        reviewedAt: request?.reviewedAt || null,
        createdAt: request?.createdAt || null,
        updatedAt: request?.updatedAt || null,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/credit-requests', async (req, res, next) => {
  if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can request extra credits')) return;

  try {
    const type = normalizeCreditRequestType(req.body?.type);
    const requestedAmount = Number(req.body?.requestedAmount);
    const comment = String(req.body?.comment || '')
      .trim()
      .slice(0, 500);

    if (!type || !CREDIT_REQUEST_ALLOWED_TYPES.has(type)) {
      return res.status(400).json({
        error: 'type must be one of AI, ATTEMPTS, or EXAMS',
      });
    }

    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return res.status(400).json({
        error: 'requestedAmount must be a positive number',
      });
    }

    if (requestedAmount > CREDIT_REQUEST_MAX_AMOUNT) {
      return res.status(400).json({
        error: `requestedAmount must be less than or equal to ${CREDIT_REQUEST_MAX_AMOUNT}`,
      });
    }

    const tenant = await Tenant.findById(req.user.tenantId)
      .select('subscription examLimit attemptLimit aiUsageLimit extraCredits')
      .lean();
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const subscription = tenant?.subscription || {};
    const effectivePlanType = resolveEffectivePlanType(
      subscription?.planType || req.user?.planType || null,
      resolveSubscriptionStatus(subscription)
    );
    const summary = await resolveCreditRequestTypeSummary({
      type,
      tenantId: req.user.tenantId,
      tenant,
      effectivePlanType,
    });

    if (!summary) {
      return res.status(400).json({ error: 'Invalid credit request type' });
    }

    if (summary.totalLimit === null) {
      return res.status(400).json({
        error: 'Current plan has no limit for this usage type, so extra credits are not required.',
      });
    }

    if ((Number(summary.usage) || 0) < (Number(summary.totalLimit) || 0)) {
      return res.status(400).json({
        error: 'Credits can be requested only after your current limit is exhausted.',
        usage: summary,
      });
    }

    const created = await CreditRequest.create({
      tenantId: req.user.tenantId,
      type,
      requestedAmount: Math.floor(requestedAmount),
      status: CREDIT_REQUEST_STATUSES.PENDING,
      requestedBy: req.user._id,
      comment,
      unitPriceInr: resolveExtraCreditUnitPrice(type),
    });

    return res.status(201).json({
      success: true,
      request: {
        id: String(created._id),
        tenantId: String(created.tenantId),
        type: created.type,
        requestedAmount: Number(created.requestedAmount) || 0,
        status: created.status,
        comment: created.comment || '',
        unitPriceInr: Number(created.unitPriceInr) || 0,
        createdAt: created.createdAt,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * SUB-TENANT (Department) MANAGEMENT
 */

router.get('/sub-tenants', requireMultiTenantFeature, async (req, res, next) => {
  if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can manage sub-tenants')) return;

  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;
    const statusQuery = String(req.query.status || 'ACTIVE').trim().toUpperCase();
    const search = String(req.query.search || '').trim();

    const filter = {
      tenantId: req.user.tenantId,
    };

    if (statusQuery && statusQuery !== 'ALL') {
      if (!SUB_TENANT_ALLOWED_STATUS.has(statusQuery)) {
        return res.status(400).json({ error: 'status must be ACTIVE, INACTIVE, or ALL' });
      }
      filter.status = statusQuery;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const [subTenants, total] = await Promise.all([
      SubTenant.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SubTenant.countDocuments(filter),
    ]);

    const subTenantIds = subTenants.map((item) => item._id);
    const [userUsage, examUsage] = await Promise.all([
      subTenantIds.length
        ? User.aggregate([
            {
              $match: {
                tenantId: req.user.tenantId,
                subTenantId: { $in: subTenantIds },
                status: { $ne: 'INACTIVE' },
              },
            },
            {
              $group: {
                _id: '$subTenantId',
                count: { $sum: 1 },
              },
            },
          ])
        : [],
      subTenantIds.length
        ? Exam.aggregate([
            {
              $match: {
                tenantId: req.user.tenantId,
                subTenantId: { $in: subTenantIds },
              },
            },
            {
              $group: {
                _id: '$subTenantId',
                count: { $sum: 1 },
              },
            },
          ])
        : [],
    ]);

    const userCountMap = new Map(
      userUsage.map((entry) => [String(entry._id), Number(entry.count) || 0])
    );
    const examCountMap = new Map(
      examUsage.map((entry) => [String(entry._id), Number(entry.count) || 0])
    );

    const normalizedSubTenants = subTenants.map((item) => ({
      ...item,
      userCount: userCountMap.get(String(item._id)) || 0,
      examCount: examCountMap.get(String(item._id)) || 0,
    }));

    return res.json({
      subTenants: normalizedSubTenants,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/sub-tenants',
  requireMultiTenantFeature,
  [
    body('name').trim().notEmpty().withMessage('name is required'),
    body('code').optional().isString().withMessage('code must be a string'),
    body('description').optional().isString().withMessage('description must be a string'),
    body('status')
      .optional()
      .isIn(['ACTIVE', 'INACTIVE'])
      .withMessage('status must be ACTIVE or INACTIVE'),
    body('metadata').optional().isObject().withMessage('metadata must be an object'),
  ],
  async (req, res, next) => {
    if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can manage sub-tenants')) return;

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const requestedCode =
        normalizeSubTenantCode(req.body.code) ||
        normalizeSubTenantCode(String(req.body.name || '').replace(/\s+/g, '_'));
      if (!requestedCode) {
        return res.status(400).json({ error: 'Unable to derive a valid department code.' });
      }

      const subTenant = await SubTenant.create({
        tenantId: req.user.tenantId,
        name: String(req.body.name || '').trim(),
        code: requestedCode,
        description: String(req.body.description || '').trim(),
        status: req.body.status || 'ACTIVE',
        metadata: req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {},
        createdBy: req.user._id,
      });

      await logAuditEvent(AUDIT_ACTIONS.RESOURCE_CREATED || 'SUB_TENANT_CREATED', {
        ...buildActorAuditDetails(req),
        tenantId: req.user.tenantId || null,
        resourceType: 'SubTenant',
        resourceId: subTenant._id,
        details: {
          subTenantName: subTenant.name,
          subTenantCode: subTenant.code,
          status: subTenant.status,
        },
      });

      return res.status(201).json({ subTenant });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ error: 'A sub-tenant with this code already exists.' });
      }
      return next(error);
    }
  }
);

router.put(
  '/sub-tenants/:subTenantId',
  requireMultiTenantFeature,
  [
    body('name').optional().trim().notEmpty().withMessage('name cannot be empty'),
    body('code').optional().isString().withMessage('code must be a string'),
    body('description').optional().isString().withMessage('description must be a string'),
    body('status')
      .optional()
      .isIn(['ACTIVE', 'INACTIVE'])
      .withMessage('status must be ACTIVE or INACTIVE'),
    body('metadata').optional().isObject().withMessage('metadata must be an object'),
  ],
  async (req, res, next) => {
    if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can manage sub-tenants')) return;

    try {
      if (!/^[a-fA-F0-9]{24}$/.test(String(req.params.subTenantId || '').trim())) {
        return res.status(400).json({ error: 'Invalid sub-tenant id.' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const subTenant = await SubTenant.findOne({
        _id: req.params.subTenantId,
        tenantId: req.user.tenantId,
      });
      if (!subTenant) {
        return res.status(404).json({ error: 'Sub-tenant not found.' });
      }

      const beforeState = {
        name: subTenant.name,
        code: subTenant.code,
        description: subTenant.description,
        status: subTenant.status,
      };

      if (req.body.name !== undefined) {
        subTenant.name = String(req.body.name || '').trim();
      }
      if (req.body.code !== undefined) {
        const normalizedCode = normalizeSubTenantCode(req.body.code);
        if (!normalizedCode) {
          return res.status(400).json({ error: 'code must contain alphanumeric characters.' });
        }
        subTenant.code = normalizedCode;
      }
      if (req.body.description !== undefined) {
        subTenant.description = String(req.body.description || '').trim();
      }
      if (req.body.status !== undefined) {
        subTenant.status = String(req.body.status).toUpperCase();
      }
      if (req.body.metadata !== undefined) {
        subTenant.metadata =
          req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
      }

      await subTenant.save();

      const updatedFields = [];
      Object.entries({
        name: subTenant.name,
        code: subTenant.code,
        description: subTenant.description,
        status: subTenant.status,
      }).forEach(([field, value]) => {
        if (String(beforeState[field] ?? '') !== String(value ?? '')) {
          updatedFields.push(field);
        }
      });

      await logAuditEvent(AUDIT_ACTIONS.RESOURCE_UPDATED || 'SUB_TENANT_UPDATED', {
        ...buildActorAuditDetails(req),
        tenantId: req.user.tenantId || null,
        resourceType: 'SubTenant',
        resourceId: subTenant._id,
        details: {
          updatedFields,
          before: beforeState,
          after: {
            name: subTenant.name,
            code: subTenant.code,
            description: subTenant.description,
            status: subTenant.status,
          },
        },
      });

      return res.json({ subTenant });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ error: 'A sub-tenant with this code already exists.' });
      }
      return next(error);
    }
  }
);

router.delete('/sub-tenants/:subTenantId', requireMultiTenantFeature, async (req, res, next) => {
  if (!ensureTenantAdminAccess(req, res, 'Only tenant admins can manage sub-tenants')) return;

  try {
    if (!/^[a-fA-F0-9]{24}$/.test(String(req.params.subTenantId || '').trim())) {
      return res.status(400).json({ error: 'Invalid sub-tenant id.' });
    }

    const subTenant = await SubTenant.findOne({
      _id: req.params.subTenantId,
      tenantId: req.user.tenantId,
    });
    if (!subTenant) {
      return res.status(404).json({ error: 'Sub-tenant not found.' });
    }

    subTenant.status = 'INACTIVE';
    await subTenant.save();

    await Promise.all([
      User.updateMany(
        {
          tenantId: req.user.tenantId,
          subTenantId: subTenant._id,
        },
        {
          $set: {
            subTenantId: null,
          },
        }
      ),
      Exam.updateMany(
        {
          tenantId: req.user.tenantId,
          subTenantId: subTenant._id,
        },
        {
          $set: {
            subTenantId: null,
          },
        }
      ),
    ]);

    await logAuditEvent(AUDIT_ACTIONS.RESOURCE_DELETED || 'SUB_TENANT_DEACTIVATED', {
      ...buildActorAuditDetails(req),
      tenantId: req.user.tenantId || null,
      resourceType: 'SubTenant',
      resourceId: subTenant._id,
      details: {
        subTenantName: subTenant.name,
        subTenantCode: subTenant.code,
        mode: 'soft_deactivate',
      },
    });

    return res.json({
      message: 'Sub-tenant deactivated successfully.',
      subTenant,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * USER MANAGEMENT (Tenant-scoped)
 */

// List all users in tenant
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, status, search, subTenantId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId, role: { $ne: 'SUPER_ADMIN' } };
    const andFilters = [];
    if (role) andFilters.push({ $or: [{ role }, { roles: role }] });
    if (status) filter.status = status;
    if (typeof subTenantId === 'string' && /^[a-fA-F0-9]{24}$/.test(subTenantId.trim())) {
      filter.subTenantId = subTenantId.trim();
    }
    if (search) {
      andFilters.push({ $or: [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ] });
    }
    if (andFilters.length) filter.$and = andFilters;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password')
        .populate('subTenantId', 'name code status')
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

// Download CSV template for tenant user bulk import
router.get('/users/bulk-import/template', (req, res) => {
  if (!ensureTenantAdminBulkAccess(req, res)) return;

  const templateRows = [
    'Name,Email,Password,Role,Roll Number,Grade,Section,Student ID',
    'Aarav Sharma,aarav.sharma@example.com,Test@12345,CANDIDATE,17,10,A,STU-17',
    'Neha Singh,neha.singh@example.com,Test@12345,EXAM_CREATOR,,,,',
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=\"tenant_users_bulk_import_template.csv\"');
  res.send(templateRows.join('\n'));
});

// Preview tenant user bulk import rows before creating users
router.post('/users/bulk-import/preview', async (req, res, next) => {
  if (!ensureTenantAdminBulkAccess(req, res)) return;

  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Rows array is required for preview.' });
    }

    const previewData = await prepareBulkImportRows(rows, req);

    res.json({
      preview: previewData.previewRows,
      summary: previewData.summary,
      truncated: previewData.truncated,
      maxRows: previewData.maxRows,
    });
  } catch (error) {
    next(error);
  }
});

// Import tenant users in bulk
router.post('/users/bulk-import', async (req, res, next) => {
  if (!ensureTenantAdminBulkAccess(req, res)) return;

  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Rows array is required for import.' });
    }

    const previewData = await prepareBulkImportRows(rows, req);
    const failures = previewData.preparedRows
      .filter((row) => row.status !== 'valid')
      .map((row) => ({
        rowNumber: row.rowNumber,
        email: row.email || '',
        reason: toFailureReason(row),
      }));

    let totalImported = 0;
    let duplicateRowsSkipped = previewData.summary.duplicateRows;
    for (const row of previewData.preparedRows) {
      if (row.status !== 'valid') continue;

      try {
        const user = new User({
          name: row.name,
          email: row.email,
          password: row.password,
          role: row.role,
          tenantId: req.user.tenantId,
          status: 'ACTIVE',
          ...(row.role === 'CANDIDATE' ? { academicProfile: row.academicProfile } : {}),
        });

        await user.save();
        totalImported += 1;

        logAuditEvent(AUDIT_ACTIONS.USER_CREATED, {
          ...buildActorAuditDetails(req),
          tenantId: user.tenantId || req.user.tenantId || null,
          resourceType: 'User',
          resourceId: user._id,
          details: {
            createdUserName: user.name,
            createdUserEmail: user.email,
            createdUserRole: user.role,
            source: 'bulk_import',
          },
        }).catch(err => {
          console.error('[AUDIT] Failed to log bulk user creation:', err);
        });
      } catch (error) {
        const isDuplicateEmail = error?.code === 11000;
        if (isDuplicateEmail) {
          duplicateRowsSkipped += 1;
        }
        failures.push({
          rowNumber: row.rowNumber,
          email: row.email || '',
          reason: isDuplicateEmail ? 'Email already registered.' : (error?.message || 'Failed to create user.'),
        });
      }
    }

    res.json({
      summary: {
        totalRows: previewData.summary.totalRows,
        totalImported,
        totalFailed: failures.length,
        duplicateRowsSkipped,
      },
      failures,
      truncated: previewData.truncated,
      maxRows: previewData.maxRows,
    });
  } catch (error) {
    next(error);
  }
});

// Get single user
router.get('/users/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne({
      _id: req.params.userId,
      tenantId: req.user.tenantId,
    })
      .select('-password')
      .populate('subTenantId', 'name code status');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Create user in tenant
router.post(
  '/users',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR', 'CANDIDATE', 'EVALUATOR']).withMessage('Invalid primary role.'),
    body('roles').optional().isArray({ min: 1 }).withMessage('roles must be a non-empty array'),
    body('roles.*').optional().isIn(['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR', 'CANDIDATE', 'EVALUATOR']),
    body('mobile').optional().trim(),
    body('subTenantId')
      .optional({ nullable: true })
      .custom((value) => value === null || value === '' || /^[a-fA-F0-9]{24}$/.test(String(value).trim()))
      .withMessage('subTenantId must be a valid id when provided'),
    body('accessExpiresAt').optional({ nullable: true }).isISO8601(),
    body('academicProfile').optional().isObject(),
    body('academicAdminScope').optional().isObject(),
    body('primaryOrganizationUnitId').optional({ nullable: true }).custom((value) => value === null || value === '' || /^[a-fA-F0-9]{24}$/.test(String(value))),
    body('organizationUnitAccess').optional().isArray(),
  ],
  checkTenantLimits,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, roles, mobile, subTenantId, accessExpiresAt, academicProfile, academicAdminScope, primaryOrganizationUnitId, organizationUnitAccess } = req.body;

      let resolvedSubTenantId = null;
      if (subTenantId !== undefined) {
        const effectivePlanType = await resolveUserEffectivePlanType(req.user);
        if (
          subTenantId !== null &&
          String(subTenantId || '').trim() !== '' &&
          !isPlanFeatureEnabled(effectivePlanType, 'multiTenant')
        ) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.MULTI_TENANT_LOCKED);
        }

        if (subTenantId !== null && String(subTenantId || '').trim() !== '') {
          resolvedSubTenantId = await resolveValidatedSubTenantId({
            tenantId: req.user.tenantId,
            subTenantId,
            allowInactive: false,
          });
          if (!resolvedSubTenantId) {
            return res.status(404).json({ error: 'Sub-tenant not found for this workspace.' });
          }
        }
      }

      // Every tenant user — including EVALUATOR — is created through this
      // single service, whether the request came from this normal
      // Create User form or the evaluator-management convenience API
      // (routes/tenantEvaluators.js). This is the fix for the defect where
      // a newly created evaluator used to be silently persisted as
      // role='CANDIDATE': createTenantUser never downgrades an unsupported
      // or not-yet-entitled role, it rejects with a typed error instead.
      let user;
      let resolvedLocationId = null;
      let scopeResolutionMethod = null;
      try {
        // Tenant Admin is the only role that reaches this router
        // (router.use(requireRole('TENANT_ADMIN')) above) and is tenant-wide,
        // so — unlike Academic Admin/Teacher provisioning below — a
        // client-selected location IS honored here, but it is now validated
        // against the canonical resolver (an ACTIVE unit belonging to this
        // tenant) instead of only regex-shape-checked as before.
        if (primaryOrganizationUnitId) {
          const resolved = await resolveTargetLocationForUserCreation({
            actor: req.user,
            requestedLocationId: primaryOrganizationUnitId,
          });
          resolvedLocationId = resolved.locationId;
          scopeResolutionMethod = resolved.method;
        }

        user = await createTenantUser({
          name,
          email,
          password,
          role,
          roles,
          tenantId: req.user.tenantId,
          mobile,
          subTenantId: resolvedSubTenantId,
          actorId: req.user._id,
          evaluatorAccess: (roles || [role]).includes('EVALUATOR') ? { accessExpiresAt: accessExpiresAt || null } : undefined,
          academicProfile: (roles || [role]).includes('CANDIDATE') ? academicProfile : undefined,
          academicAdminScope,
          primaryOrganizationUnitId: resolvedLocationId,
          organizationUnitAccess: Array.isArray(organizationUnitAccess)
            ? organizationUnitAccess.map((entry) => ({
              organizationUnitId: entry?.organizationUnitId || entry,
              grantedBy: req.user._id,
            })).filter((entry) => entry.organizationUnitId)
            : undefined,
        });
      } catch (roleError) {
        if (roleError instanceof UserProvisioningScopeError) {
          return res.status(roleError.status).json({ error: roleError.message, code: roleError.code });
        }
        if (roleError instanceof UserRoleError) {
          return res.status(roleError.status).json({ error: roleError.message });
        }
        throw roleError;
      }

      const userObj = user.toObject();
      delete userObj.password;

      await logAuditEvent((roles || [role]).includes('EVALUATOR') ? AUDIT_ACTIONS.EVALUATOR_USER_CREATED : AUDIT_ACTIONS.USER_CREATED, {
        ...buildActorAuditDetails(req),
        tenantId: user.tenantId || req.user.tenantId || null,
        resourceType: 'User',
        resourceId: user._id,
        details: {
          createdUserName: user.name,
          createdUserEmail: user.email,
          createdUserRole: user.role,
          createdUserRoles: user.roles,
          createdBy: String(req.user._id),
          createdRole: user.role,
          resolvedLocationId,
          scopeResolutionMethod,
        },
      });

      res.status(201).json({ user: userObj });
    } catch (error) {
      next(error);
    }
  }
);

// Update user in tenant
router.put(
  '/users/:userId',
  [
    body('name').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('role').optional().isIn(['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR', 'CANDIDATE', 'EVALUATOR']),
    body('roles').optional().isArray({ min: 1 }),
    body('roles.*').optional().isIn(['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR', 'CANDIDATE', 'EVALUATOR']),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED']),
    body('mobile').optional().trim(),
    body('subTenantId')
      .optional({ nullable: true })
      .custom((value) => value === null || value === '' || /^[a-fA-F0-9]{24}$/.test(String(value).trim()))
      .withMessage('subTenantId must be a valid id when provided'),
    body('academicProfile').optional().isObject(),
    body('academicAdminScope').optional().isObject(),
    body('primaryOrganizationUnitId').optional({ nullable: true }).custom((value) => value === null || value === '' || /^[a-fA-F0-9]{24}$/.test(String(value))),
    body('organizationUnitAccess').optional().isArray(),
  ],
  checkTenantLimits,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findOne({
        _id: req.params.userId,
        tenantId: req.user.tenantId,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent modifying SUPER_ADMIN or TENANT_ADMIN
      if (hasRole(user, 'SUPER_ADMIN') || hasRole(user, 'TENANT_ADMIN')) {
        return res.status(403).json({ error: 'Cannot modify this user' });
      }

      const beforeState = {
        name: user.name,
        email: user.email,
        role: user.role,
        roles: Array.isArray(user.roles) ? [...user.roles] : [user.role],
        status: user.status,
        mobile: user.mobile,
        tenantId: user.tenantId,
        subTenantId: user.subTenantId ? String(user.subTenantId) : null,
      };

      const { name, email, password, role, roles, status, mobile, subTenantId, academicProfile, academicAdminScope, primaryOrganizationUnitId, organizationUnitAccess } = req.body;

      if (name) user.name = name;
      if (email) {
        const existing = await User.findOne({ email, _id: { $ne: user._id } });
        if (existing) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        user.email = email;
      }
      if (password) user.password = password;
      const requestedRoles = roles
        ? Array.from(new Set(roles.map((value) => String(value || '').trim().toUpperCase())))
        : null;
      const nextPrimaryRole = role || user.role;
      if (requestedRoles && !requestedRoles.includes(nextPrimaryRole)) {
        return res.status(422).json({ error: 'The primary role must also be included in roles.' });
      }
      const nextRoles = requestedRoles || Array.from(new Set([...(user.roles || [user.role]), nextPrimaryRole]));
      if (nextRoles.includes('ACADEMIC_ADMIN')) {
        const scope = academicAdminScope || user.academicAdminScope;
        if (scope?.wholeTenant !== true && !(scope?.organizationUnitIds || []).length && !(scope?.programIds || []).length) {
          return res.status(422).json({ error: 'Academic Admin requires tenant-wide scope or at least one organization unit/program scope.' });
        }
      }
      if (role || roles) {
        if (nextRoles.includes('EVALUATOR')) {
          try {
            await assertEvaluatorRoleAllowed(req.user.tenantId);
          } catch (roleError) {
            if (roleError instanceof UserRoleError) {
              return res.status(roleError.status).json({ error: roleError.message });
            }
            throw roleError;
          }
        }
        user.role = nextPrimaryRole;
        user.roles = nextRoles;
        const previouslyEvaluator = beforeState.roles.includes('EVALUATOR');
        const nowEvaluator = nextRoles.includes('EVALUATOR');
        if (nowEvaluator && !previouslyEvaluator) {
          user.evaluatorAccess = {
            enabled: true,
            accessExpiresAt: user.evaluatorAccess?.accessExpiresAt || null,
            assignedAt: new Date(),
            assignedBy: req.user._id,
            removedAt: null,
            removedBy: null,
          };
        } else if (!nowEvaluator && previouslyEvaluator) {
          user.evaluatorAccess = {
            ...(user.evaluatorAccess?.toObject?.() || user.evaluatorAccess || {}),
            enabled: false,
            removedAt: new Date(),
            removedBy: req.user._id,
          };
        }
      }
      if (academicAdminScope !== undefined) user.academicAdminScope = academicAdminScope;
      if (primaryOrganizationUnitId !== undefined) {
        user.primaryOrganizationUnitId = primaryOrganizationUnitId || null;
      }
      if (organizationUnitAccess !== undefined) {
        user.organizationUnitAccess = Array.isArray(organizationUnitAccess)
          ? organizationUnitAccess.map((entry) => ({
            organizationUnitId: entry?.organizationUnitId || entry,
            grantedAt: entry?.grantedAt || new Date(),
            grantedBy: entry?.grantedBy || req.user._id,
          })).filter((entry) => entry.organizationUnitId)
          : [];
      }
      if (status) user.status = status;
      if (mobile !== undefined) user.mobile = mobile;
      if (academicProfile !== undefined && nextRoles.includes('CANDIDATE')) {
        user.academicProfile = normalizeCandidateAcademicProfile(academicProfile);
      }
      if (subTenantId !== undefined) {
        const effectivePlanType = await resolveUserEffectivePlanType(req.user);
        const normalizedSubTenantId = String(subTenantId || '').trim();
        if (normalizedSubTenantId) {
          if (!isPlanFeatureEnabled(effectivePlanType, 'multiTenant')) {
            return sendPlanRestriction(res, FREE_PLAN_MESSAGES.MULTI_TENANT_LOCKED);
          }
          const resolvedSubTenantId = await resolveValidatedSubTenantId({
            tenantId: req.user.tenantId,
            subTenantId: normalizedSubTenantId,
            allowInactive: false,
          });
          if (!resolvedSubTenantId) {
            return res.status(404).json({ error: 'Sub-tenant not found for this workspace.' });
          }
          user.subTenantId = resolvedSubTenantId;
        } else {
          user.subTenantId = null;
        }
      }

      await user.save();
      const userObj = user.toObject();
      delete userObj.password;

      const updatedFields = [];
      Object.entries({
        name: user.name,
        email: user.email,
        role: user.role,
        roles: Array.isArray(user.roles) ? [...user.roles] : [user.role],
        status: user.status,
        mobile: user.mobile,
        tenantId: user.tenantId,
        subTenantId: user.subTenantId ? String(user.subTenantId) : null,
      }).forEach(([field, value]) => {
        const beforeValue = beforeState[field];
        if (String(beforeValue ?? '') !== String(value ?? '')) {
          updatedFields.push(field);
        }
      });

      const roleChanged = beforeState.role !== user.role || beforeState.roles.join('|') !== (user.roles || []).join('|');
      const action = roleChanged ? AUDIT_ACTIONS.USER_ROLE_CHANGED : AUDIT_ACTIONS.USER_UPDATED;

      await logAuditEvent(action, {
        ...buildActorAuditDetails(req),
        tenantId: user.tenantId || req.user.tenantId || null,
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
        },
      });

      res.json({ user: userObj });
    } catch (error) {
      next(error);
    }
  }
);

// Delete user (permanent delete)
router.delete('/users/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne({
      _id: req.params.userId,
      tenantId: req.user.tenantId,
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (hasRole(user, 'SUPER_ADMIN') || hasRole(user, 'TENANT_ADMIN')) {
      return res.status(403).json({ error: 'Cannot delete this user' });
    }

    const userObj = user.toObject();
    delete userObj.password;

    await logAuditEvent(AUDIT_ACTIONS.USER_DELETED, {
      ...buildActorAuditDetails(req),
      tenantId: user.tenantId || req.user.tenantId || null,
      resourceType: 'User',
      resourceId: user._id,
      details: {
        deletedUserName: user.name,
        deletedUserEmail: user.email,
        deletedUserRole: user.role,
        deletedUserStatus: user.status,
      },
    });

    await deleteUserAndCleanup(user._id);

    res.json({ message: 'User deleted successfully', user: userObj });
  } catch (error) {
    next(error);
  }
});

// Block/Unblock user
router.post(
  '/users/:userId/block',
  [body('blocked').isBoolean().withMessage('Blocked status must be a boolean')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findOne({
        _id: req.params.userId,
        tenantId: req.user.tenantId,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { blocked } = req.body;
      const configKey = `blocked_user_${user._id}`;

      let config = await SystemConfig.findOne({ key: configKey });
      if (!config) {
        config = new SystemConfig({
          key: configKey,
          value: blocked ? 'true' : 'false',
          description: `Block status for user ${user.email}`,
          updatedBy: req.user._id,
        });
      } else {
        config.value = blocked ? 'true' : 'false';
        config.updatedBy = req.user._id;
      }

      await config.save();

      const action = blocked ? AUDIT_ACTIONS.USER_BLOCKED : AUDIT_ACTIONS.USER_UNBLOCKED;
      await logAuditEvent(action, {
        ...buildActorAuditDetails(req),
        tenantId: user.tenantId || req.user.tenantId || null,
        resourceType: 'User',
        resourceId: user._id,
        details: {
          blocked,
          targetUserName: user.name,
          targetUserEmail: user.email,
        },
      });

      res.json({
        message: `User ${blocked ? 'blocked' : 'unblocked'} successfully`,
        user: { ...user.toObject(), isBlocked: blocked },
      });
    } catch (error) {
      next(error);
    }
  }
);

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

      const user = await User.findOne({
        _id: req.params.userId,
        tenantId: req.user.tenantId,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (hasRole(user, 'SUPER_ADMIN') || hasRole(user, 'TENANT_ADMIN')) {
        return res.status(403).json({ error: 'Cannot reset password for this user' });
      }

      user.password = req.body.newPassword;
      await user.save();

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * EXAM MANAGEMENT (Tenant-scoped)
 */

// List all exams in tenant
router.get('/exams', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId };
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const [exams, total] = await Promise.all([
      Exam.find(filter)
        .populate('createdBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Exam.countDocuments(filter),
    ]);

    res.json({
      exams: exams.map((exam) => withExamCode(exam)),
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
    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    }).populate('createdBy', 'name email role');

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

    res.json({ exam: withExamCode(examDetails) });
  } catch (error) {
    next(error);
  }
});

// Update exam (enable/disable, etc.)
router.put(
  '/exams/:examId',
  [
    body('title').optional().trim().notEmpty(),
    body('description').optional().trim(),
    body('isActive').optional().isBoolean(),
    body('duration').optional().isInt({ min: 1 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findOne({
        _id: req.params.examId,
        tenantId: req.user.tenantId,
      });

      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const { title, description, isActive, duration, maxAttempts } = req.body;

      if (typeof title === 'string' && title.trim()) {
        const duplicateExam = await findDuplicateExamByTitle({
          title,
          tenantId: req.user.tenantId,
          excludeExamId: exam._id,
        });
        if (duplicateExam) {
          return res.status(409).json({
            success: false,
            message: DUPLICATE_EXAM_NAME_MESSAGE,
          });
        }
      }

      // Store before state for audit
      const beforeState = {
        title: exam.title,
        description: exam.description,
        isActive: exam.isActive,
        duration: exam.duration,
        maxAttempts: exam.maxAttempts,
      };

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (isActive !== undefined) exam.isActive = isActive;
      if (duration) exam.duration = duration;
      if (maxAttempts) exam.maxAttempts = maxAttempts;

      await exam.save();
      await exam.populate('createdBy', 'name email role');

      const updatedFields = [];
      Object.entries({
        title: exam.title,
        description: exam.description,
        isActive: exam.isActive,
        duration: exam.duration,
        maxAttempts: exam.maxAttempts,
      }).forEach(([field, value]) => {
        const beforeValue = beforeState[field];
        if (String(beforeValue ?? '') !== String(value ?? '')) {
          updatedFields.push(field);
        }
      });

      const isActiveChanged = isActive !== undefined && isActive !== beforeState.isActive;
      const action = isActiveChanged
        ? (exam.isActive ? AUDIT_ACTIONS.EXAM_ENABLED : AUDIT_ACTIONS.EXAM_DISABLED)
        : AUDIT_ACTIONS.EXAM_UPDATED;

      await logAuditEvent(action, {
        ...buildActorAuditDetails(req),
        tenantId: exam.tenantId || req.user.tenantId || null,
        resourceType: 'Exam',
        resourceId: exam._id,
        details: {
          updatedFields,
          before: { isActive: beforeState.isActive },
          after: { isActive: exam.isActive },
        },
      });

      res.json({ exam: withExamCode(exam) });
    } catch (error) {
      next(error);
    }
  }
);

// Delete exam (soft delete by setting isActive to false)
router.delete('/exams/:examId', async (req, res, next) => {
  try {
    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    });

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    exam.isActive = false;
    await exam.save();

    await logAuditEvent(AUDIT_ACTIONS.EXAM_DELETED, {
      ...buildActorAuditDetails(req),
      tenantId: exam.tenantId || req.user.tenantId || null,
      resourceType: 'Exam',
      resourceId: exam._id,
      details: {
        examTitle: exam.title,
        before: { isActive: true },
        after: { isActive: false },
        mode: 'soft_delete',
      },
    });

    res.json({ message: 'Exam deactivated successfully', exam: withExamCode(exam) });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM SESSIONS MANAGEMENT (Tenant-scoped)
 */

// List all sessions in tenant
router.get('/sessions', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { tenantId: req.user.tenantId };
    if (examId) filter.examId = examId;

    const [sessions, total] = await Promise.all([
      ExamSession.find(filter)
        .populate('examId', 'title duration')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ExamSession.countDocuments(filter),
    ]);

    res.json({
      sessions,
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

// Get a single session's details + candidate stats. No status filter is
// applied so this works identically for upcoming/active/expired sessions.
router.get('/sessions/:sessionId', async (req, res, next) => {
  try {
    const session = await ExamSession.findOne({
      _id: req.params.sessionId,
      tenantId: req.user.tenantId,
    })
      .populate('examId', 'title duration gracePeriod')
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName')
      .populate('createdBy', 'name email');

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const attempts = await ExamAttempt.find({
      sessionId: session._id,
      tenantId: req.user.tenantId,
    }).select('isCompleted isDisqualified');

    const totalCandidates = attempts.length;
    const disqualified = attempts.filter((a) => a.isDisqualified).length;
    const submitted = attempts.filter((a) => a.isCompleted && !a.isDisqualified).length;
    const inProgress = attempts.filter((a) => !a.isCompleted && !a.isDisqualified).length;

    res.json({
      session,
      stats: { totalCandidates, submitted, inProgress, disqualified },
    });
  } catch (error) {
    next(error);
  }
});

// Update a session: end it now, or extend/change its end time.
router.put('/sessions/:sessionId', async (req, res, next) => {
  try {
    const session = await ExamSession.findOne({
      _id: req.params.sessionId,
      tenantId: req.user.tenantId,
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const action = String(req.body?.action || '').trim().toLowerCase();
    const nextEndTimeRaw = req.body?.endTime;
    const now = new Date();

    if (action === 'end') {
      session.isActive = false;
      if (session.endTime > now) {
        session.endTime = now;
      }
    } else if (nextEndTimeRaw) {
      const exam = await Exam.findById(session.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      let nextEndTime;
      let durationOverride;
      try {
        ({ end: nextEndTime, durationOverride } = resolveSessionEndTime({
          exam,
          start: session.startTime,
          endTime: nextEndTimeRaw,
          overrideEndTime: req.body?.overrideEndTime,
          overrideReason: req.body?.overrideReason,
        }));
      } catch (resolveError) {
        return res.status(resolveError.status || 400).json({ error: resolveError.message });
      }

      if (nextEndTime <= session.startTime) {
        return res.status(400).json({ error: 'End time must be after start time' });
      }
      session.endTime = nextEndTime;
      session.durationOverride = durationOverride || { applied: false };
    } else {
      return res.status(400).json({ error: 'Nothing to update. Provide action="end" or a valid endTime.' });
    }

    await session.save();
    await session.populate('examId', 'title duration gracePeriod');
    await session.populate('questionPaperId', 'setName');
    await session.populate('questionPaperIds', 'setName');
    await session.populate('createdBy', 'name email');

    await logAuditEvent(AUDIT_ACTIONS.SESSION_UPDATED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: session.tenantId,
      resourceType: 'ExamSession',
      resourceId: session._id,
      method: req.method,
      path: req.path,
    });

    res.json({
      message: action === 'end' ? 'Session ended successfully' : 'Session updated successfully',
      session,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * EXAM ATTEMPTS & RESULTS (Tenant-scoped)
 */

// List all exam attempts in tenant
// Get single attempt with full details
router.get('/attempts/:attemptId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const Section = (await import('../models/Section.js')).default;
    const Question = (await import('../models/Question.js')).default;
    const AnswerKey = (await import('../models/AnswerKey.js')).default;

    const attempt = await ExamAttempt.findOne({
      _id: req.params.attemptId,
      tenantId: req.user.tenantId,
    })
      .populate('examId', 'title duration description passingPercentage')
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
    let answerKeyDetails = null;
    try {
      const answerKey = await AnswerKey.findOne({ examId: attempt.examId._id, isActive: true })
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
        } else if (typeof answersMap === 'object' && answersMap !== null) {
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
      console.error('Error loading answer key:', err);
      // Answer key might not exist - that's okay
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
      console.error('Error loading violation summary:', err);
      // Violation summary might fail - that's okay
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

// Get exam results with statistics
router.get('/results/exams', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;

    const exams = await Exam.find({ tenantId: req.user.tenantId })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    // Get statistics for each exam
    const examsWithStats = await Promise.all(
      exams.map(async (exam) => {
        // Get all completed attempts for this exam
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
            totalCandidates: 0,
            overallPercentage: 0,
            averageScore: 0,
            maxScore: 0,
            minScore: 0,
            averagePercentile: 0,
            averageNormalizedScore: 0,
          };
        }

        // Calculate scores for each attempt
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

// Get detailed results for a specific exam
router.get('/results/exams/:examId', async (req, res, next) => {
  try {
    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;
    const Answer = (await import('../models/Answer.js')).default;
    const { getNormalizationStats } = await import('../services/normalizationService.js');

    const exam = await Exam.findOne({
      _id: req.params.examId,
      tenantId: req.user.tenantId,
    });

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const passingPercentage = Number.isFinite(Number(exam.passingPercentage))
      ? Number(exam.passingPercentage)
      : 60;

    // Get all completed attempts for this exam
    const attempts = await ExamAttempt.find({
      examId: exam._id,
      isCompleted: true,
      isDisqualified: false,
    })
      .populate('userId', 'name email uniqueId')
      .sort({ createdAt: -1 });

    // Calculate scores and get candidate data
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
          isPassed: percentage >= passingPercentage,
          status: percentage >= passingPercentage ? 'PASSED' : 'FAILED',
          rank: null, // Will be calculated after sorting
        };
      })
    );

    // Sort by totalScore descending to calculate rank
    candidates.sort((a, b) => b.totalScore - a.totalScore);
    candidates.forEach((candidate, index) => {
      candidate.rank = index + 1;
    });

    // Get top 5 and bottom 5
    const top5 = candidates.slice(0, 5);
    const bottom5 = candidates.slice(-5).reverse();

    // Get normalization statistics
    const normalizationStats = await getNormalizationStats(exam._id);

    // Prepare data for normalization curve
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
        passingPercentage,
        createdAt: exam.createdAt,
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

router.get('/attempts', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId, userId, isCompleted } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const { startDate, endDate } = parseQueryDateRange(req.query);

    const filter = { tenantId: req.user.tenantId };
    if (examId) filter.examId = examId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';
    const createdAtRange = {};
    if (startDate) createdAtRange.$gte = startDate;
    if (endDate) createdAtRange.$lte = endDate;
    if (Object.keys(createdAtRange).length > 0) {
      filter.$or = [
        { createdAt: createdAtRange },
        { submittedAt: createdAtRange },
        { submitTime: createdAtRange },
      ];
    }

    const [attempts, total] = await Promise.all([
      ExamAttempt.find(filter)
        .populate({
          path: 'examId',
          select: 'title duration passingPercentage',
        })
        .populate('userId', 'name email role')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ExamAttempt.countDocuments(filter),
    ]);

    // Calculate scores for each attempt
    const attemptsWithScores = await Promise.all(
      attempts.map(async (attempt) => {
        const attemptObj = attempt.toObject();
        if (attempt.isCompleted) {
          try {
            const hasSummary =
              Number.isFinite(Number(attemptObj.scoreSummary?.percentage)) &&
              Number.isFinite(Number(attemptObj.scoreSummary?.totalScore)) &&
              Number.isFinite(Number(attemptObj.scoreSummary?.maxScore));

            let percentage = 0;
            let totalScore = 0;
            let maxScore = 0;

            if (hasSummary) {
              percentage = Number(attemptObj.scoreSummary.percentage) || 0;
              totalScore = Number(attemptObj.scoreSummary.totalScore) || 0;
              maxScore = Number(attemptObj.scoreSummary.maxScore) || 0;
            } else {
              const answers = await Answer.find({ attemptId: attempt._id })
                .populate('questionId', 'points');
              totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
              maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
              percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
            }

            const passingThreshold = Number(attemptObj.examId?.passingPercentage ?? 60);
            attemptObj.score = percentage;
            attemptObj.resultStatus = percentage >= passingThreshold ? 'PASSED' : 'FAILED';
            attemptObj.totalScore = totalScore;
            attemptObj.maxScore = maxScore;
          } catch (err) {
            console.error(`Error calculating score for attempt ${attempt._id}:`, err);
            attemptObj.score = null;
            attemptObj.resultStatus = null;
          }
        }
        return attemptObj;
      })
    );

    res.json({
      attempts: attemptsWithScores,
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

export default router;
