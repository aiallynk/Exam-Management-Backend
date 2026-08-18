import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
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
import CreditRequest from '../models/CreditRequest.js';
import AuditLog from '../models/AuditLog.js';
import BackupHistory from '../models/BackupHistory.js';
import SystemAlert from '../models/SystemAlert.js';
import TenantFeatureSetting from '../models/TenantFeatureSetting.js';
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
import { getAIQuestionCountForTenantByWindow } from '../services/aiTokenUsageService.js';
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
import {
  getSubscriptionGlobalLimits,
  getSubscriptionPlanCatalog,
  persistSubscriptionGlobalLimits,
  persistSubscriptionPlanOverride,
} from '../utils/subscriptionPlanCatalog.js';
import {
  CREDIT_REQUEST_STATUSES,
  CREDIT_REQUEST_TYPES,
  applyExtraCreditsToPlanLimits,
  computeExtraUsageCost,
  normalizeCreditRequestType,
  normalizeTenantExtraCredits,
  resolveExtraCreditUnitPrice,
  resolveTenantExtraCreditFieldByType,
} from '../utils/creditSystem.js';
import {
  CONTROL_CATEGORY_DEFINITIONS,
  TENANT_CAPABILITIES,
  WIZKIDS_CAPABILITY_KEYS,
  WIZKIDS_PLAN_FEATURE_KEYS,
} from '../services/tenantFeatureService.js';

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
  const triggerType =
    String(record?.trigger_type || '').trim().toUpperCase() === 'AUTO'
      ? 'AUTO'
      : 'MANUAL';
  const toIstDateTimeString = (value) => {
    if (!value) return '';
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return `${new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(parsed)} IST`;
  };
  return {
    id: record?._id || null,
    backup_name: record?.backup_name || '',
    type: record?.type || '',
    trigger_type: triggerType,
    backup_type: triggerType,
    company_id: company?._id || company || null,
    company_name: company?.name || null,
    company_code: company?.code || null,
    file_size: Number(record?.file_size) || 0,
    storage_path: record?.storage_url_path || record?.storage_path || '',
    status: record?.status || '',
    created_by: createdBy?._id || createdBy || null,
    created_by_name: triggerType === 'AUTO' ? 'System' : createdBy?.name || null,
    created_by_email: createdBy?.email || null,
    restored_by: restoredBy?._id || restoredBy || null,
    restored_by_name: restoredBy?.name || null,
    restored_by_email: restoredBy?.email || null,
    restored_at: record?.restored_at || null,
    restored_at_ist: toIstDateTimeString(record?.restored_at),
    created_at: record?.created_at || null,
    created_at_ist: toIstDateTimeString(record?.created_at),
    updated_at: record?.updated_at || null,
    error_message: record?.error_message || '',
    source_backup_id: record?.source_backup_id || null,
  };
};

const isValidMongoId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ''));

const normalizeTenantLifecycleStatus = (value) =>
  String(value || '')
    .trim()
    .toUpperCase();

const normalizeTenantTokenVersion = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const shouldIncrementTenantTokenVersionForInactivation = (previousStatus, nextStatus) =>
  normalizeTenantLifecycleStatus(previousStatus) !== 'INACTIVE' &&
  normalizeTenantLifecycleStatus(nextStatus) === 'INACTIVE';

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
  'maxAiGradingsPerMonth',
  'maxImportFiles',
  'importQuestionsPerMonth',
  'maxCandidates',
]);

const PLAN_LIMIT_EDITABLE_KEYS = Object.freeze([
  'maxExamsPerMonth',
  'maxUsers',
  'maxAttemptsPerMonth',
  'maxAiQuestionsPerMonth',
  'maxAiGradingsPerMonth',
  'maxImportFiles',
  'importQuestionsPerMonth',
  'maxExamCreators',
  'maxCandidates',
  'maxQuestionsPerExam',
]);

const AI_TYPES_ALLOWED_ALIASES = Object.freeze({
  short: 'short',
  short_answer: 'short',
  paragraph: 'paragraph',
  essay: 'essay',
  essay_letter: 'essay_letter',
  letter: 'essay_letter',
  letter_writing: 'essay_letter',
  essay_story: 'essay_story',
  story: 'essay_story',
  story_writing: 'essay_story',
});

const PLAN_GLOBAL_OVERRIDE_KEYS = Object.freeze([
  'aiQuestionsPerMonth',
  'maxImportFiles',
  'importQuestionsPerMonth',
]);

const SUBSCRIPTION_STATUS_VALUES = Object.freeze([
  SUBSCRIPTION_STATUSES.ACTIVE,
  SUBSCRIPTION_STATUSES.EXPIRED,
  SUBSCRIPTION_STATUSES.SUSPENDED,
  SUBSCRIPTION_STATUSES.CANCELLED,
]);

const PLAN_DEFAULT_DURATIONS_DAYS = Object.freeze({
  [SUBSCRIPTION_PLAN_TYPES.FREE]: 30,
  [SUBSCRIPTION_PLAN_TYPES.PRO]: 30,
  [SUBSCRIPTION_PLAN_TYPES.ULTIMATE]: 180,
  [SUBSCRIPTION_PLAN_TYPES.LEGEND]: 365,
});

const AI_NOT_AVAILABLE_IN_PLAN_MESSAGE = 'AI not available in your plan';

const hasOwn = (target, key) =>
  Boolean(target && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key));

const normalizeOptionalObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const toPlainOptionalObject = (value) => {
  const normalized = normalizeOptionalObject(value);
  if (typeof normalized.toObject === 'function') {
    return normalizeOptionalObject(normalized.toObject());
  }
  return { ...normalized };
};

const parseOptionalLimitValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

// A negative value (conventionally -1) is the established "unlimited"
// sentinel throughout this file's own resolution logic
// (parseOptionalLimitValue above, and resolvePlanLimitWithOverride in
// middleware/planLimits.js, and resolveFiniteLimit in routes/ai.js all
// special-case `parsed < 0` -> unlimited) — this validator must accept
// the same values it will later be asked to resolve, or an admin setting
// -1 for "unlimited" gets rejected before it's ever saved, silently
// leaving the previous (finite) limit in effect.
const isValidLimitInput = (value) => {
  if (value === null || value === undefined || value === '') return true;
  const parsed = Number(value);
  return Number.isFinite(parsed);
};

const normalizeAiTypeKey = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return '';
  return AI_TYPES_ALLOWED_ALIASES[normalized] || '';
};

const normalizeAiTypesAllowedInput = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n;|]/)
      : [];
  if (source.length === 0) return [];

  return Array.from(
    new Set(
      source
        .map((entry) => normalizeAiTypeKey(entry))
        .filter(Boolean)
    )
  );
};

// Keys that accept -1 as an explicit "unlimited" sentinel. maxImportFiles/
// importQuestionsPerMonth (the same limit under its two historical
// aliases — see resolveTenantImportFileLimit in routes/ai.js) belongs
// here alongside the AI limits: parseOptionalLimitValue below already
// treats any negative value as unlimited for every key, so restricting
// which keys are allowed to actually SUBMIT -1 to only the AI limits was
// an inconsistent, narrower gate than the resolver it feeds.
const UNLIMITED_SENTINEL_LIMIT_KEYS = new Set([
  'maxAiGradingsPerMonth',
  'maxAiQuestionsPerMonth',
  'maxImportFiles',
  'importQuestionsPerMonth',
]);

const isValidPlanLimitInput = (limitKey, value) => {
  if (value === null || value === undefined || value === '') return true;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return false;
  if (parsed >= 0) return true;
  return parsed === -1 && UNLIMITED_SENTINEL_LIMIT_KEYS.has(limitKey);
};

const parsePlanLimitInputValue = (limitKey, value) => {
  if (UNLIMITED_SENTINEL_LIMIT_KEYS.has(limitKey) && Number(value) === -1) {
    return null;
  }
  return parseOptionalLimitValue(value);
};

const resolveAiEnabledFromPlanDefinition = (planDefinition = {}) =>
  planDefinition?.features?.aiGrading !== false;

const resolveAiTypesAllowedFromPlanDefinition = (planDefinition = {}) => {
  const rawValue =
    planDefinition?.features?.aiTypesAllowed ??
    planDefinition?.features?.ai_types_allowed ??
    [];
  const normalized = normalizeAiTypesAllowedInput(rawValue);
  return Array.isArray(normalized) ? normalized : [];
};

const resolveAiUsageLimitFromPlanDefinition = (planDefinition = {}) => {
  const aiGradingLimit = parseOptionalLimitValue(planDefinition?.limits?.maxAiGradingsPerMonth);
  if (
    aiGradingLimit !== null ||
    planDefinition?.limits?.maxAiGradingsPerMonth === null
  ) {
    return aiGradingLimit;
  }
  return parseOptionalLimitValue(planDefinition?.limits?.maxAiQuestionsPerMonth);
};

const buildPlanAiSettings = (planDefinition = {}) => {
  const aiEnabled = resolveAiEnabledFromPlanDefinition(planDefinition);
  const aiUsageLimit = resolveAiUsageLimitFromPlanDefinition(planDefinition);
  const aiTypesAllowed = resolveAiTypesAllowedFromPlanDefinition(planDefinition);
  return {
    ai_enabled: aiEnabled,
    ai_usage_limit: aiUsageLimit === null ? -1 : aiUsageLimit,
    ai_types_allowed: aiTypesAllowed,
  };
};

const extractLegendCustomLimits = (input) => {
  const source = normalizeOptionalObject(input);
  const result = {};
  if (hasOwn(source, 'maxExamsPerMonth')) {
    result.maxExamsPerMonth = parseOptionalLimitValue(source.maxExamsPerMonth);
  }
  if (hasOwn(source, 'maxAttemptsPerMonth')) {
    result.maxAttemptsPerMonth = parseOptionalLimitValue(source.maxAttemptsPerMonth);
  }
  if (hasOwn(source, 'maxAiQuestionsPerMonth')) {
    result.maxAiQuestionsPerMonth = parseOptionalLimitValue(source.maxAiQuestionsPerMonth);
  }
  if (hasOwn(source, 'maxAiGradingsPerMonth')) {
    result.maxAiGradingsPerMonth = parsePlanLimitInputValue(
      'maxAiGradingsPerMonth',
      source.maxAiGradingsPerMonth
    );
  }
  if (hasOwn(source, 'maxCandidates')) {
    result.maxCandidates = parseOptionalLimitValue(source.maxCandidates);
  }

  // Canonicalize import question limit aliases to maxImportFiles for backward compatibility.
  if (hasOwn(source, 'importQuestionsPerMonth')) {
    result.maxImportFiles = parseOptionalLimitValue(source.importQuestionsPerMonth);
  } else if (hasOwn(source, 'maxImportFiles')) {
    result.maxImportFiles = parseOptionalLimitValue(source.maxImportFiles);
  }

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

const PLAN_FEATURE_TOGGLE_DEFINITIONS = Object.freeze([
  {
    canonicalKey: 'codingCompiler',
    aliases: ['codingCompiler'],
  },
  {
    canonicalKey: 'omrAutoGrading',
    aliases: ['omrAutoGrading', 'omrGrading'],
  },
  {
    canonicalKey: 'aiRubricScoring',
    aliases: ['aiRubricScoring', 'aiRubric'],
  },
  {
    canonicalKey: 'secureBrowser',
    aliases: ['secureBrowser'],
  },
  {
    canonicalKey: 'multiTenant',
    aliases: ['multiTenant'],
  },
  {
    canonicalKey: 'advancedAnalytics',
    aliases: ['advancedAnalytics', 'analytics'],
  },
]);

const PLAN_FEATURE_TOGGLE_ALIAS_TO_CANONICAL = Object.freeze(
  PLAN_FEATURE_TOGGLE_DEFINITIONS.reduce((accumulator, entry) => {
    entry.aliases.forEach((aliasKey) => {
      accumulator[aliasKey] = entry.canonicalKey;
    });
    accumulator[entry.canonicalKey] = entry.canonicalKey;
    return accumulator;
  }, {})
);

const PLAN_FEATURE_TOGGLE_CANONICAL_KEYS = Object.freeze(
  PLAN_FEATURE_TOGGLE_DEFINITIONS.map((entry) => entry.canonicalKey)
);

const PLAN_FEATURE_TOGGLE_NON_CANONICAL_ALIAS_KEYS = Object.freeze(
  Array.from(
    new Set(
      Object.keys(PLAN_FEATURE_TOGGLE_ALIAS_TO_CANONICAL).filter(
        (key) => !PLAN_FEATURE_TOGGLE_CANONICAL_KEYS.includes(key)
      )
    )
  )
);

const extractManagedPlanFeatureValues = (input, sourceLabel) => {
  const source = normalizeOptionalObject(input);
  const values = {};
  const validationErrors = [];

  Object.entries(source).forEach(([rawKey, rawValue]) => {
    const canonicalKey = PLAN_FEATURE_TOGGLE_ALIAS_TO_CANONICAL[rawKey];
    if (!canonicalKey) return;
    if (typeof rawValue !== 'boolean') {
      validationErrors.push(`${sourceLabel}.${rawKey} must be a boolean`);
      return;
    }
    values[canonicalKey] = Boolean(rawValue);
  });

  return {
    values,
    validationErrors,
  };
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

const TENANT_LIMIT_USAGE_ROLE_QUERY_VALUES = Object.freeze({
  exam_creators: ['EXAM_CREATOR', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'ADMIN', 'DESIGNER', 'TEACHER'],
  candidates: ['CANDIDATE', 'USER', 'STUDENT'],
});

const LIMIT_KEY_ALIASES = Object.freeze({
  exams_limit: 'maxExamsPerMonth',
  users_limit: 'maxUsers',
  attempts_limit: 'maxAttemptsPerMonth',
  ai_questions_limit: 'maxAiQuestionsPerMonth',
  ai_grading_limit: 'maxAiGradingsPerMonth',
  import_questions_limit: 'maxImportFiles',
  import_files_limit: 'maxImportFiles',
  importquestionspermonth: 'maxImportFiles',
  import_questions_per_month: 'maxImportFiles',
  candidates_limit: 'maxCandidates',
  exam_creators_limit: 'maxExamCreators',
  questions_per_exam_limit: 'maxQuestionsPerExam',
});

const FEATURE_KEY_ALIASES = Object.freeze({
  ai_grading: 'aiGrading',
  ai_generate: 'aiQuestionGen',
  ocr_import: 'omr',
  essay_questions: 'essayQuestions',
  multi_select_mcq: 'multiSelectMcq',
});

const normalizeDynamicConfigKey = (value) =>
  String(value || '')
    .trim()
    .replace(/[.\s-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

const normalizeLimitOverrideKey = (key) => {
  const safeKey = String(key || '').trim();
  if (!safeKey) return '';
  const normalizedAlias = normalizeDynamicConfigKey(safeKey).toLowerCase();
  return LIMIT_KEY_ALIASES[normalizedAlias] || safeKey;
};

const normalizeFeatureOverrideKey = (key) => {
  const safeKey = String(key || '').trim();
  if (!safeKey) return '';
  const normalizedAlias = normalizeDynamicConfigKey(safeKey).toLowerCase();
  return FEATURE_KEY_ALIASES[normalizedAlias] || safeKey;
};

const parseOverrideLimitValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed === -1) return -1;
  if (parsed < 0) return null;
  return Math.floor(parsed);
};

const toEffectiveLimitValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed === -1) return null;
  if (parsed < 0) return null;
  return Math.floor(parsed);
};

const toFiniteUsageNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const extractActiveCustomLimitOverrides = (input) => {
  const source = normalizeOptionalObject(input);
  return Object.entries(source).reduce((accumulator, [rawKey, rawValue]) => {
    const key = normalizeLimitOverrideKey(rawKey);
    if (!key) return accumulator;

    const parsedValue = parseOverrideLimitValue(rawValue);
    if (parsedValue === null) {
      return accumulator;
    }

    accumulator[key] = parsedValue;
    return accumulator;
  }, {});
};

const extractActiveCustomFeatureOverrides = (input) => {
  const source = normalizeOptionalObject(input);
  return Object.entries(source).reduce((accumulator, [rawKey, rawValue]) => {
    const key = normalizeFeatureOverrideKey(rawKey);
    if (!key) return accumulator;
    if (typeof rawValue !== 'boolean') return accumulator;
    accumulator[key] = Boolean(rawValue);
    return accumulator;
  }, {});
};

const humanizeDynamicConfigLabel = (key) => {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return 'Unknown';

  const acronymMap = {
    ai: 'AI',
    ocr: 'OCR',
    mcq: 'MCQ',
    omr: 'OMR',
    api: 'API',
    id: 'ID',
    ip: 'IP',
  };

  return normalized
    .split(' ')
    .map((segment) => {
      const lower = segment.toLowerCase();
      if (acronymMap[lower]) return acronymMap[lower];
      return `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`;
    })
    .join(' ');
};

const resolveTenantLimitUsageSnapshot = async ({ tenant, limitKeys = [] }) => {
  const tenantId = tenant?._id || null;
  if (!tenantId || !Array.isArray(limitKeys) || limitKeys.length === 0) {
    return {};
  }

  const keySet = new Set(limitKeys.map((key) => String(key || '').trim()).filter(Boolean));
  const subscription = normalizeOptionalObject(tenant?.subscription);
  const usageWindow = buildUsageWindow(subscription);

  const shouldLoadExams = keySet.has('maxExamsPerMonth');
  const shouldLoadAttempts = keySet.has('maxAttemptsPerMonth');
  const shouldLoadAiQuestions = keySet.has('maxAiQuestionsPerMonth');
  const shouldLoadUsers = keySet.has('maxUsers');
  const shouldLoadExamCreators = keySet.has('maxExamCreators');
  const shouldLoadCandidates = keySet.has('maxCandidates');

  const [examUsage, attemptUsage, aiQuestionUsage, activeUsers, activeExamCreators, activeCandidates] =
    await Promise.all([
      shouldLoadExams
        ? getExamCountForTenantByWindow(tenantId, usageWindow.start, usageWindow.end)
        : Promise.resolve(null),
      shouldLoadAttempts
        ? getAttemptCountForTenantByWindow(tenantId, usageWindow.start, usageWindow.end)
        : Promise.resolve(null),
      shouldLoadAiQuestions
        ? getAIQuestionCountForTenantByWindow(tenantId, usageWindow.start, usageWindow.end)
        : Promise.resolve(null),
      shouldLoadUsers
        ? User.countDocuments({
            tenantId,
            status: 'ACTIVE',
            role: { $ne: 'SUPER_ADMIN' },
          })
        : Promise.resolve(null),
      shouldLoadExamCreators
        ? User.countDocuments({
            tenantId,
            status: 'ACTIVE',
            role: { $in: TENANT_LIMIT_USAGE_ROLE_QUERY_VALUES.exam_creators },
          })
        : Promise.resolve(null),
      shouldLoadCandidates
        ? User.countDocuments({
            tenantId,
            status: 'ACTIVE',
            role: { $in: TENANT_LIMIT_USAGE_ROLE_QUERY_VALUES.candidates },
          })
        : Promise.resolve(null),
    ]);

  const usageSnapshot = {};
  if (shouldLoadExams) usageSnapshot.maxExamsPerMonth = toFiniteUsageNumber(examUsage);
  if (shouldLoadAttempts) usageSnapshot.maxAttemptsPerMonth = toFiniteUsageNumber(attemptUsage);
  if (shouldLoadAiQuestions) usageSnapshot.maxAiQuestionsPerMonth = toFiniteUsageNumber(aiQuestionUsage);
  if (keySet.has('maxAiGradingsPerMonth')) {
    usageSnapshot.maxAiGradingsPerMonth = toFiniteUsageNumber(tenant?.ai_usage_count ?? 0);
  }
  if (shouldLoadUsers) usageSnapshot.maxUsers = toFiniteUsageNumber(activeUsers);
  if (shouldLoadExamCreators) usageSnapshot.maxExamCreators = toFiniteUsageNumber(activeExamCreators);
  if (shouldLoadCandidates) usageSnapshot.maxCandidates = toFiniteUsageNumber(activeCandidates);

  return usageSnapshot;
};

const buildTenantFeaturePayload = async (tenantInput) => {
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
  const rawCustomLimits = normalizeOptionalObject(subscription.customLimits);
  const rawCustomFeatures = normalizeOptionalObject(subscription.customFeatures);
  const customLimits = extractActiveCustomLimitOverrides(rawCustomLimits);
  const customFeatures = extractActiveCustomFeatureOverrides(rawCustomFeatures);

  const dynamicLimitKeys = Array.from(
    new Set([
      ...Object.keys(normalizeOptionalObject(effectivePlanLimits)).map(normalizeLimitOverrideKey),
      ...Object.keys(rawCustomLimits).map(normalizeLimitOverrideKey),
    ].filter(Boolean))
  ).sort((left, right) => String(left).localeCompare(String(right)));

  const dynamicFeatureKeys = Array.from(
    new Set([
      ...Object.entries(planFeatures)
        .filter(([, value]) => typeof value === 'boolean')
        .map(([key]) => normalizeFeatureOverrideKey(key)),
      ...Object.keys(rawCustomFeatures).map(normalizeFeatureOverrideKey),
    ].filter(Boolean))
  ).sort((left, right) => String(left).localeCompare(String(right)));

  const limitUsageSnapshot = await resolveTenantLimitUsageSnapshot({
    tenant,
    limitKeys: dynamicLimitKeys,
  });

  const dynamicLimits = dynamicLimitKeys.map((key) => {
    const hasOverride = hasOwn(customLimits, key);
    const planValue = toEffectiveLimitValue(effectivePlanLimits?.[key]);
    const overrideValue = hasOverride ? customLimits[key] : null;
    const effectiveValue = hasOverride ? toEffectiveLimitValue(overrideValue) : planValue;
    const currentUsage = hasOwn(limitUsageSnapshot, key)
      ? toFiniteUsageNumber(limitUsageSnapshot[key])
      : null;
    const remaining =
      effectiveValue === null || currentUsage === null
        ? null
        : Math.max(effectiveValue - currentUsage, 0);

    return {
      key,
      label: humanizeDynamicConfigLabel(key),
      type: 'limit',
      source: hasOverride ? FEATURE_SOURCE_TYPES.OVERRIDE : FEATURE_SOURCE_TYPES.PLAN,
      status: hasOverride ? 'Custom Override' : 'Using Plan Default',
      isOverridden: hasOverride,
      usePlanDefault: !hasOverride,
      planValue,
      overrideValue: hasOverride ? overrideValue : null,
      effectiveValue,
      currentUsage,
      remaining,
      isUnlimited: effectiveValue === null,
    };
  });

  const dynamicFeatures = dynamicFeatureKeys
    .map((key) => {
      const hasPlanValue = typeof planFeatures?.[key] === 'boolean';
      const hasOverride = hasOwn(customFeatures, key);
      const planValue = hasPlanValue ? Boolean(planFeatures[key]) : false;
      const overrideValue = hasOverride ? Boolean(customFeatures[key]) : null;
      const effectiveValue = hasOverride ? overrideValue : planValue;

      // Non-boolean feature settings are intentionally excluded from dynamic toggle editing.
      if (!hasPlanValue && !hasOverride) {
        return null;
      }

      return {
        key,
        label: humanizeDynamicConfigLabel(key),
        type: 'feature',
        source: hasOverride ? FEATURE_SOURCE_TYPES.OVERRIDE : FEATURE_SOURCE_TYPES.PLAN,
        status: hasOverride ? 'Custom Override' : 'Using Plan Default',
        isOverridden: hasOverride,
        usePlanDefault: !hasOverride,
        planValue,
        overrideValue: hasOverride ? overrideValue : null,
        effectiveValue,
      };
    })
    .filter(Boolean);

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
    configuration: {
      limits: dynamicLimits,
      features: dynamicFeatures,
    },
    effectiveConfig: {
      limits: dynamicLimits.reduce((accumulator, entry) => {
        accumulator[entry.key] = entry.effectiveValue;
        return accumulator;
      }, {}),
      features: dynamicFeatures.reduce((accumulator, entry) => {
        accumulator[entry.key] = Boolean(entry.effectiveValue);
        return accumulator;
      }, {}),
    },
    overrides: {
      custom_limits: { ...customLimits },
      custom_features: { ...customFeatures },
    },
    updatedAt: subscription.updatedAt || tenant?.updatedAt || null,
  };
};

const resolveLegendEffectiveLimits = ({ planType, tenant, baseLimits }) => {
  const normalizedPlanType = resolveSubscriptionPlanType(planType);

  const customLimits = normalizeOptionalObject(tenant?.subscription?.customLimits);
  const resolveLimit = (key, legacyValue, baseValue) => {
    if (hasOwn(customLimits, key)) {
      const customValue = customLimits[key];
      if (customValue !== null && customValue !== undefined && customValue !== '') {
        if (Number(customValue) === -1) {
          return null;
        }
        return parseOptionalLimitValue(customValue);
      }
    }
    if (key === 'maxImportFiles' && hasOwn(customLimits, 'importQuestionsPerMonth')) {
      const aliasedValue = customLimits.importQuestionsPerMonth;
      if (aliasedValue !== null && aliasedValue !== undefined && aliasedValue !== '') {
        if (Number(aliasedValue) === -1) {
          return null;
        }
        return parseOptionalLimitValue(aliasedValue);
      }
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
    maxImportFiles: resolveLimit(
      'maxImportFiles',
      null,
      baseLimits?.importQuestionsPerMonth ?? baseLimits?.maxImportFiles
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
  YEARLY: 'yearly',
});

const REVENUE_TREND_RANGE_TYPES = Object.freeze({
  DAILY: 'daily',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
});

const REVENUE_TREND_DEFAULT_LIMITS = Object.freeze({
  [REVENUE_TREND_RANGE_TYPES.DAILY]: 30,
  [REVENUE_TREND_RANGE_TYPES.MONTHLY]: 12,
  [REVENUE_TREND_RANGE_TYPES.YEARLY]: 5,
});

const REVENUE_TREND_MAX_LIMITS = Object.freeze({
  [REVENUE_TREND_RANGE_TYPES.DAILY]: 120,
  [REVENUE_TREND_RANGE_TYPES.MONTHLY]: 36,
  [REVENUE_TREND_RANGE_TYPES.YEARLY]: 20,
});

const SUCCESSFUL_TRANSACTION_STATUSES = Object.freeze(['SUCCESS', 'COMPLETED', 'PAID']);

const ADDON_PRICE_CATALOG = Object.freeze({
  addonAiProctoring: 999,
  addonAdvancedAnalytics: 1499,
  addonCustomBranding: 799,
  addonApiAccess: 1299,
  addonBulkImportExport: 699,
  addonCodingCompiler: 999,
});
const CREDIT_REQUEST_STATUS_VALUES = new Set(Object.values(CREDIT_REQUEST_STATUSES));
const CREDIT_REQUEST_TYPE_VALUES = new Set(Object.values(CREDIT_REQUEST_TYPES));
const CREDIT_REQUEST_REVIEWABLE_STATUS = CREDIT_REQUEST_STATUSES.PENDING;

const REVENUE_TREND_CACHE_TTL_MS = 60 * 1000;
const revenueTrendCache = new Map();

const REVENUE_MS_PER_DAY = 24 * 60 * 60 * 1000;

const toValidDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const normalizeCreditRequestStatusInput = (value) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  return CREDIT_REQUEST_STATUS_VALUES.has(normalized) ? normalized : null;
};

const resolveCreditRequestLimitKey = (type) => {
  const normalized = normalizeCreditRequestType(type);
  if (normalized === CREDIT_REQUEST_TYPES.AI) return 'maxAiQuestionsPerMonth';
  if (normalized === CREDIT_REQUEST_TYPES.ATTEMPTS) return 'maxAttemptsPerMonth';
  if (normalized === CREDIT_REQUEST_TYPES.EXAMS) return 'maxExamsPerMonth';
  return null;
};

const resolveCreditRequestUsageValue = async ({ tenantId, type, start, end }) => {
  const normalized = normalizeCreditRequestType(type);
  if (!normalized) return 0;
  if (normalized === CREDIT_REQUEST_TYPES.AI) {
    return getAIQuestionCountForTenantByWindow(tenantId, start, end);
  }
  if (normalized === CREDIT_REQUEST_TYPES.ATTEMPTS) {
    return getAttemptCountForTenantByWindow(tenantId, start, end);
  }
  if (normalized === CREDIT_REQUEST_TYPES.EXAMS) {
    return getExamCountForTenantByWindow(tenantId, start, end);
  }
  return 0;
};

const buildCreditRequestResponseItem = (request) => ({
  id: request?._id ? String(request._id) : null,
  tenantId: request?.tenantId?._id
    ? String(request.tenantId._id)
    : request?.tenantId
      ? String(request.tenantId)
      : null,
  tenantName: request?.tenantId?.name || '',
  tenantCode: request?.tenantId?.code || '',
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
});

const computeCreditRequestBillingForTenantType = async ({
  tenant,
  type,
  start,
  end,
}) => {
  const normalizedType = normalizeCreditRequestType(type);
  if (!normalizedType || !tenant?._id) return null;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) return null;

  const subscription = normalizeOptionalObject(tenant?.subscription);
  const statusAtDate = resolveSubscriptionStatus(subscription, end);
  const effectivePlanType = resolveEffectivePlanType(
    resolveSubscriptionPlanType(subscription?.planType || SUBSCRIPTION_PLAN_TYPES.FREE),
    statusAtDate
  );
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const baseLimits = resolveLegendEffectiveLimits({
    planType: effectivePlanType,
    tenant,
    baseLimits: normalizeOptionalObject(planDefinition?.limits),
  });
  const extraCredits = normalizeTenantExtraCredits(tenant?.extraCredits);
  const totalLimits = applyExtraCreditsToPlanLimits(baseLimits, extraCredits);
  const limitKey = resolveCreditRequestLimitKey(normalizedType);
  const baseLimit = limitKey ? baseLimits?.[limitKey] : null;
  const totalLimit = limitKey ? totalLimits?.[limitKey] : null;
  const usage = await resolveCreditRequestUsageValue({
    tenantId: tenant._id,
    type: normalizedType,
    start,
    end,
  });
  const billing = computeExtraUsageCost({
    usage,
    baseLimit,
    type: normalizedType,
  });

  return {
    type: normalizedType,
    usage: Number(usage) || 0,
    baseLimit: baseLimit ?? null,
    totalLimit: totalLimit ?? null,
    extraCredits,
    extraUsage: billing.extraUsage,
    unitPrice: billing.unitPrice,
    extraCost: billing.extraCost,
  };
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

const toYearKey = (value) => {
  const date = new Date(value);
  return String(date.getFullYear());
};

const formatRevenueBucketLabel = (value, interval) => {
  const date = new Date(value);
  if (interval === REVENUE_INTERVAL_TYPES.DAILY) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (interval === REVENUE_INTERVAL_TYPES.YEARLY) {
    return String(date.getFullYear());
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

const extractCustomFeaturesFromAuditDetails = (details, phase = 'after') => {
  const safeDetails = normalizeOptionalObject(details);
  const nestedDetails = normalizeOptionalObject(safeDetails.details);
  const directPayload = normalizeOptionalObject(safeDetails[phase]);
  const nestedPayload = normalizeOptionalObject(nestedDetails[phase]);
  const directCustomFeatures = normalizeOptionalObject(directPayload.customFeatures);
  const nestedCustomFeatures = normalizeOptionalObject(nestedPayload.customFeatures);

  if (Object.keys(directCustomFeatures).length > 0) {
    return directCustomFeatures;
  }
  return nestedCustomFeatures;
};

const extractRevenueTransactionStatusFromAuditDetails = (details) => {
  const safeDetails = normalizeOptionalObject(details);
  const nestedDetails = normalizeOptionalObject(safeDetails.details);
  const directStatus = String(
    safeDetails.transactionStatus ||
      safeDetails.paymentStatus ||
      safeDetails.status ||
      ''
  )
    .trim()
    .toUpperCase();
  if (directStatus) return directStatus;
  return String(
    nestedDetails.transactionStatus ||
      nestedDetails.paymentStatus ||
      nestedDetails.status ||
      ''
  )
    .trim()
    .toUpperCase();
};

const isSuccessfulRevenueAuditLog = (entry) => {
  const status = extractRevenueTransactionStatusFromAuditDetails(entry?.details);
  if (!status) return true;
  return SUCCESSFUL_TRANSACTION_STATUSES.includes(status);
};

const resolveAddonPurchaseAmount = (entry, addonKey) => {
  const safeDetails = normalizeOptionalObject(entry?.details);
  const nestedDetails = normalizeOptionalObject(safeDetails.details);
  const directAddonAmounts = normalizeOptionalObject(safeDetails.addonAmounts);
  const nestedAddonAmounts = normalizeOptionalObject(nestedDetails.addonAmounts);
  const directAddons = normalizeOptionalObject(safeDetails.addons);
  const nestedAddons = normalizeOptionalObject(nestedDetails.addons);

  const amountCandidates = [
    directAddonAmounts[addonKey],
    nestedAddonAmounts[addonKey],
    directAddons?.[addonKey]?.amount,
    nestedAddons?.[addonKey]?.amount,
  ];

  const resolvedAmount = amountCandidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0);

  if (Number.isFinite(resolvedAmount)) {
    return Number(resolvedAmount.toFixed(2));
  }

  return Number(ADDON_PRICE_CATALOG[addonKey] || 0);
};

const normalizeRevenueTrendRange = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return REVENUE_TREND_RANGE_TYPES.MONTHLY;
  if (Object.values(REVENUE_TREND_RANGE_TYPES).includes(normalized)) {
    return normalized;
  }
  return null;
};

const normalizeRevenueTrendLimit = (range, value) => {
  const fallback = REVENUE_TREND_DEFAULT_LIMITS[range] || 12;
  if (value === null || value === undefined || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  const safeLimit = Math.floor(parsed);
  const maxAllowed = REVENUE_TREND_MAX_LIMITS[range] || fallback;
  return Math.min(Math.max(safeLimit, 1), maxAllowed);
};

const getRevenueTrendCacheKey = ({ range, tenantId, planType, limit }) =>
  JSON.stringify({
    range,
    tenantId: String(tenantId || 'all'),
    planType: String(planType || 'all'),
    limit: Number(limit) || 0,
  });

const getCachedRevenueTrend = (cacheKey, now = Date.now()) => {
  const entry = revenueTrendCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    revenueTrendCache.delete(cacheKey);
    return null;
  }
  return entry.payload;
};

const setCachedRevenueTrend = (cacheKey, payload, now = Date.now()) => {
  revenueTrendCache.set(cacheKey, {
    payload,
    expiresAt: now + REVENUE_TREND_CACHE_TTL_MS,
  });
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

const buildRevenueTrendBuckets = ({ range, now = new Date(), limit }) => {
  const safeNow = toValidDate(now) || new Date();
  const buckets = [];

  if (range === REVENUE_TREND_RANGE_TYPES.DAILY) {
    const safeLimit = normalizeRevenueTrendLimit(range, limit);
    const start = startOfDay(addDays(safeNow, -(safeLimit - 1)));
    for (let cursor = start; cursor <= safeNow; cursor = addDays(cursor, 1)) {
      const bucketStart = startOfDay(cursor);
      const bucketEnd = endOfDay(cursor) > safeNow ? new Date(safeNow) : endOfDay(cursor);
      buckets.push({
        key: toDayKey(cursor),
        label: formatRevenueBucketLabel(cursor, REVENUE_INTERVAL_TYPES.DAILY),
        interval: REVENUE_INTERVAL_TYPES.DAILY,
        startDate: bucketStart,
        endDate: bucketEnd,
      });
    }
    return buckets;
  }

  if (range === REVENUE_TREND_RANGE_TYPES.MONTHLY) {
    const safeLimit = normalizeRevenueTrendLimit(range, limit);
    const start = startOfMonth(addMonths(safeNow, -(safeLimit - 1)));
    const lastMonth = startOfMonth(safeNow);
    for (let cursor = start; cursor <= lastMonth; cursor = addMonths(cursor, 1)) {
      const bucketStart = startOfMonth(cursor);
      const bucketEnd = endOfMonth(cursor) > safeNow ? new Date(safeNow) : endOfMonth(cursor);
      buckets.push({
        key: toMonthKey(cursor),
        label: formatRevenueBucketLabel(cursor, REVENUE_INTERVAL_TYPES.MONTHLY),
        interval: REVENUE_INTERVAL_TYPES.MONTHLY,
        startDate: bucketStart,
        endDate: bucketEnd,
      });
    }
    return buckets;
  }

  const safeLimit = normalizeRevenueTrendLimit(REVENUE_TREND_RANGE_TYPES.YEARLY, limit);
  const currentYear = safeNow.getFullYear();
  const startYear = currentYear - safeLimit + 1;

  for (let year = startYear; year <= currentYear; year += 1) {
    const bucketStart = new Date(year, 0, 1, 0, 0, 0, 0);
    const bucketEndRaw = new Date(year, 11, 31, 23, 59, 59, 999);
    const bucketEnd = bucketEndRaw > safeNow ? new Date(safeNow) : bucketEndRaw;
    buckets.push({
      key: toYearKey(bucketStart),
      label: formatRevenueBucketLabel(bucketStart, REVENUE_INTERVAL_TYPES.YEARLY),
      interval: REVENUE_INTERVAL_TYPES.YEARLY,
      startDate: bucketStart,
      endDate: bucketEnd,
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

  const [examsUsed, attemptsUsed, aiQuestionsUsed, activeUsers] = await Promise.all([
    getExamCountForTenantByWindow(tenant._id, usageWindow.start, usageWindow.end),
    getAttemptCountForTenantByWindow(tenant._id, usageWindow.start, usageWindow.end),
    getAIQuestionCountForTenantByWindow(tenant._id, usageWindow.start, usageWindow.end),
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
      aiQuestions: aiQuestionsUsed,
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

// Platform controls use the same capability catalogue that resolves tenant
// controls.  This prevents the platform overview from drifting into a static
// marketing count while still avoiding a tenant-specific assumption.
router.get('/controls/overview', async (_req, res, next) => {
  try {
    const controls = Object.entries(TENANT_CAPABILITIES).map(([key, definition]) => ({
      key,
      group: definition.group,
      releaseStatus: definition.releaseStatus || 'RELEASED',
      planFeature: definition.planFeature || null,
    }));
    const categories = CONTROL_CATEGORY_DEFINITIONS.map((category) => {
      const categoryControls = category.groups
        ? controls.filter((control) => category.groups.includes(control.group))
        : controls;
      const counts = categoryControls.reduce(
        (value, control) => {
          if (control.releaseStatus === 'UNRELEASED') value.unreleased += 1;
          else if (control.releaseStatus === 'BETA') value.beta += 1;
          else value.enabled += 1;
          return value;
        },
        { enabled: 0, disabled: 0, locked: 0, beta: 0, unreleased: 0, enforced: 0 }
      );
      return { ...category, counts, totalControls: categoryControls.length };
    });
    const [tenantCount, activeTenantCount] = await Promise.all([
      Tenant.countDocuments({}),
      Tenant.countDocuments({ status: { $ne: 'INACTIVE' } }),
    ]);
    return res.json({
      categories,
      platform: {
        tenantCount,
        activeTenantCount,
        planCount: Object.keys(SUBSCRIPTION_PLANS).length,
      },
    });
  } catch (error) { return next(error); }
});

/**
 * SUBSCRIPTION PLAN CATALOG
 * GET /api/super-admin/subscriptions/plans
 */
router.get('/subscriptions/plans', async (_req, res, next) => {
  try {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
    });

    const plans = getSubscriptionPlanCatalog().map((plan) => ({
      id: plan.id,
      label: plan.label,
      price: plan.price,
      limits: plan.limits,
      features: plan.features,
      overrides: normalizeOptionalObject(plan.overrides),
      ...buildPlanAiSettings(plan),
    }));
    const globalLimits = getSubscriptionGlobalLimits();

    res.json({ plans, globalLimits });
  } catch (error) {
    next(error);
  }
});

/**
 * UPDATE GLOBAL SUBSCRIPTION LIMITS
 * PUT /api/super-admin/subscriptions/global-limits
 */
router.put('/subscriptions/global-limits', async (req, res, next) => {
  try {
    const incomingGlobalLimits = normalizeOptionalObject(req.body?.globalLimits);
    const hasGlobalLimitsPayload =
      Object.keys(incomingGlobalLimits).length > 0 ||
      PLAN_GLOBAL_OVERRIDE_KEYS.some((key) => hasOwn(req.body, key));

    if (!hasGlobalLimitsPayload) {
      return res.status(400).json({
        error: 'globalLimits payload is required.',
      });
    }

    const mergedIncoming = {
      ...incomingGlobalLimits,
      ...(PLAN_GLOBAL_OVERRIDE_KEYS.reduce((accumulator, key) => {
        if (hasOwn(req.body, key)) {
          accumulator[key] = req.body[key];
        }
        return accumulator;
      }, {})),
    };

    const unknownKeys = Object.keys(mergedIncoming).filter(
      (key) => !PLAN_GLOBAL_OVERRIDE_KEYS.includes(key)
    );
    if (unknownKeys.length > 0) {
      return res.status(400).json({
        error: `Unsupported global limit keys: ${unknownKeys.join(', ')}`,
      });
    }

    const patch = {};
    for (const key of PLAN_GLOBAL_OVERRIDE_KEYS) {
      if (!hasOwn(mergedIncoming, key)) continue;
      const incomingValue = mergedIncoming[key];
      if (!isValidLimitInput(incomingValue)) {
        return res.status(400).json({
          error: `${key} must be a non-negative number or null.`,
        });
      }
      patch[key] = parseOptionalLimitValue(incomingValue);
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        error: 'At least one editable global limit value is required.',
      });
    }

    const globalLimits = await persistSubscriptionGlobalLimits({
      patch,
      updatedBy: req.user?._id || null,
    });

    await logAuditEvent(AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED, {
      ...buildActorAuditDetails(req),
      resourceType: 'SubscriptionGlobalLimits',
      resourceId: 'subscription-global-limits',
      details: {
        updatedPatch: patch,
      },
    });

    return res.json({ globalLimits });
  } catch (error) {
    return next(error);
  }
});

/**
 * UPDATE SUBSCRIPTION PLAN LIMITS
 * PUT /api/super-admin/subscriptions/plans/:planType
 */
router.put('/subscriptions/plans/:planType', async (req, res, next) => {
  try {
    const normalizedPlanType = resolveSubscriptionPlanType(req.params.planType);
    const allowedPlanTypes = new Set([
      SUBSCRIPTION_PLAN_TYPES.FREE,
      SUBSCRIPTION_PLAN_TYPES.PRO,
      SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
      SUBSCRIPTION_PLAN_TYPES.LEGEND,
    ]);

    if (!allowedPlanTypes.has(normalizedPlanType) || !SUBSCRIPTION_PLANS[normalizedPlanType]) {
      return res.status(400).json({
        error: 'Invalid planType. Use one of: free, pro, ultimate, legend.',
      });
    }

    const hasLabelPayload = hasOwn(req.body, 'label');
    const hasPricePayload = hasOwn(req.body, 'price');
    const incomingLimits = normalizeOptionalObject(req.body?.limits);
    const hasAiUsageLimitPayload = hasOwn(req.body, 'ai_usage_limit');
    const mergedIncomingLimits = {
      ...incomingLimits,
      ...(hasAiUsageLimitPayload
        ? { maxAiGradingsPerMonth: req.body.ai_usage_limit }
        : {}),
    };
    const incomingOverrides = normalizeOptionalObject(req.body?.overrides);
    const incomingFeatures = normalizeOptionalObject(req.body?.features);
    const hasLimitsPayload = Object.keys(mergedIncomingLimits).length > 0;
    const hasOverridesPayload = Object.keys(incomingOverrides).length > 0;
    const hasAiEnabledPayload = hasOwn(req.body, 'ai_enabled');
    const hasAiTypesAllowedPayload = hasOwn(req.body, 'ai_types_allowed');
    const hasFeaturesPayload =
      Object.keys(incomingFeatures).length > 0 ||
      hasAiEnabledPayload ||
      hasAiTypesAllowedPayload;

    if (
      !hasLabelPayload &&
      !hasPricePayload &&
      !hasLimitsPayload &&
      !hasOverridesPayload &&
      !hasFeaturesPayload
    ) {
      return res.status(400).json({
        error:
          'At least one editable field is required (label, price, limits, overrides, features).',
      });
    }

    if (hasLabelPayload) {
      const nextLabel = String(req.body?.label || '').trim();
      if (!nextLabel) {
        return res.status(400).json({
          error: 'label must be a non-empty string.',
        });
      }
    }

    if (hasPricePayload) {
      const parsedPrice = Number(req.body?.price);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({
          error: 'price must be a non-negative number.',
        });
      }
    }

    if (hasLimitsPayload) {
      const unknownLimitKeys = Object.keys(mergedIncomingLimits).filter(
        (key) => !PLAN_LIMIT_EDITABLE_KEYS.includes(key)
      );
      if (unknownLimitKeys.length > 0) {
        return res.status(400).json({
          error: `Unsupported limit keys: ${unknownLimitKeys.join(', ')}`,
        });
      }
    }

    if (hasOverridesPayload) {
      const unknownOverrideKeys = Object.keys(incomingOverrides).filter(
        (key) => !PLAN_GLOBAL_OVERRIDE_KEYS.includes(key)
      );
      if (unknownOverrideKeys.length > 0) {
        return res.status(400).json({
          error: `Unsupported override keys: ${unknownOverrideKeys.join(', ')}`,
        });
      }
    }

    const nextLimitsPatch = {};
    if (hasLimitsPayload) {
      for (const key of PLAN_LIMIT_EDITABLE_KEYS) {
        if (!hasOwn(mergedIncomingLimits, key)) continue;

        const incomingValue = mergedIncomingLimits[key];
        if (!isValidPlanLimitInput(key, incomingValue)) {
          return res.status(400).json({
            error: UNLIMITED_SENTINEL_LIMIT_KEYS.has(key)
              ? `${key} must be a non-negative number, -1 (unlimited), or null.`
              : `${key} must be a non-negative number or null.`,
          });
        }

        const canonicalLimitKey = key === 'importQuestionsPerMonth' ? 'maxImportFiles' : key;
        nextLimitsPatch[canonicalLimitKey] = parsePlanLimitInputValue(
          canonicalLimitKey,
          incomingValue
        );
      }
    }

    const nextOverridesPatch = {};
    if (hasOverridesPayload) {
      for (const key of PLAN_GLOBAL_OVERRIDE_KEYS) {
        if (!hasOwn(incomingOverrides, key)) continue;

        const incomingValue = incomingOverrides[key];
        if (!isValidLimitInput(incomingValue)) {
          return res.status(400).json({
            error: `${key} must be a non-negative number or null.`,
          });
        }

        nextOverridesPatch[key] = parseOptionalLimitValue(incomingValue);
      }
    }

    const readFeatureValue = (featureKey, aliases = []) => {
      if (hasOwn(req.body, featureKey)) return req.body[featureKey];
      if (hasOwn(incomingFeatures, featureKey)) return incomingFeatures[featureKey];
      for (const alias of aliases) {
        if (hasOwn(req.body, alias)) return req.body[alias];
        if (hasOwn(incomingFeatures, alias)) return incomingFeatures[alias];
      }
      return undefined;
    };

    const nextFeaturesPatch = {};
    const rawAiEnabled = readFeatureValue('ai_enabled', ['aiEnabled', 'aiGrading']);
    const hasIncomingAiEnabled = rawAiEnabled !== undefined;
    if (hasIncomingAiEnabled) {
      if (typeof rawAiEnabled !== 'boolean') {
        return res.status(400).json({
          error: 'ai_enabled must be a boolean.',
        });
      }
      nextFeaturesPatch.aiGrading = rawAiEnabled;
    }

    const rawAiTypesAllowed = readFeatureValue('ai_types_allowed', ['aiTypesAllowed']);
    const hasIncomingAiTypesAllowed = rawAiTypesAllowed !== undefined;
    if (hasIncomingAiTypesAllowed) {
      let normalizedAiTypesAllowed = normalizeAiTypesAllowedInput(rawAiTypesAllowed);
      if (
        normalizedAiTypesAllowed === null &&
        typeof rawAiTypesAllowed === 'string' &&
        !rawAiTypesAllowed.trim()
      ) {
        normalizedAiTypesAllowed = [];
      }
      if (!Array.isArray(normalizedAiTypesAllowed)) {
        return res.status(400).json({
          error: 'ai_types_allowed must be an array or comma-separated string.',
        });
      }
      nextFeaturesPatch.aiTypesAllowed = normalizedAiTypesAllowed;
    }

    const overridePatch = {
      ...(hasLabelPayload ? { label: String(req.body?.label || '').trim() } : {}),
      ...(hasPricePayload ? { price: Number(req.body?.price) } : {}),
      ...(Object.keys(nextLimitsPatch).length > 0 ? { limits: nextLimitsPatch } : {}),
      ...(Object.keys(nextFeaturesPatch).length > 0 ? { features: nextFeaturesPatch } : {}),
      ...(Object.keys(nextOverridesPatch).length > 0 ? { overrides: nextOverridesPatch } : {}),
    };

    const updatedPlan = await persistSubscriptionPlanOverride({
      planType: normalizedPlanType,
      patch: overridePatch,
      updatedBy: req.user?._id || null,
    });

    await logAuditEvent(AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED, {
      ...buildActorAuditDetails(req),
      resourceType: 'SubscriptionPlan',
      resourceId: normalizedPlanType,
      details: {
        planType: normalizedPlanType,
        updatedPatch: overridePatch,
      },
    });

    return res.json({
      plan: {
        id: updatedPlan.id,
        label: updatedPlan.label,
        price: updatedPlan.price,
        limits: updatedPlan.limits,
        features: updatedPlan.features,
        overrides: normalizeOptionalObject(updatedPlan.overrides),
        ...buildPlanAiSettings(updatedPlan),
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * SUBSCRIPTION TENANT LIST WITH USAGE
 * GET /api/super-admin/subscriptions/tenants
 */
router.get('/subscriptions/tenants', async (req, res, next) => {
  try {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
    });

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
    const rawRange = String(req.query?.range || REVENUE_RANGE_TYPES.LAST_30_DAYS)
      .trim()
      .toLowerCase();
    const rangeAliasMap = {
      [REVENUE_TREND_RANGE_TYPES.DAILY]: REVENUE_RANGE_TYPES.LAST_30_DAYS,
      [REVENUE_TREND_RANGE_TYPES.MONTHLY]: REVENUE_RANGE_TYPES.LAST_12_MONTHS,
      [REVENUE_TREND_RANGE_TYPES.YEARLY]: REVENUE_RANGE_TYPES.ALL_TIME,
    };
    const normalizedRange = rangeAliasMap[rawRange] || rawRange;
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
      success: true,
      data: trend.map((row) => ({
        label: row?.label || '',
        revenue: Number(row?.revenue) || 0,
      })),
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
 * REVENUE TREND (REAL DATA)
 * GET /api/super-admin/revenue-trend
 * Query params:
 * - range: daily | monthly | yearly
 * - tenantId: all | <tenantId>
 * - planType: all | free | pro | ultimate | legend
 * - limit: number of buckets (optional)
 */
router.get('/revenue-trend', async (req, res, next) => {
  try {
    const now = new Date();
    const normalizedRange = normalizeRevenueTrendRange(req.query?.range);
    if (!normalizedRange) {
      return res.status(400).json({
        success: false,
        error: 'Invalid range. Use one of: daily, monthly, yearly.',
      });
    }

    const normalizedTenantId = String(req.query?.tenantId || 'all').trim();
    if (normalizedTenantId !== 'all' && !isValidMongoId(normalizedTenantId)) {
      return res.status(400).json({
        success: false,
        error: 'tenantId must be "all" or a valid tenant id.',
      });
    }

    const normalizedPlanTypeInput = String(req.query?.planType || 'all')
      .trim()
      .toLowerCase();
    const allowedPlanFilters = new Set([
      'all',
      SUBSCRIPTION_PLAN_TYPES.FREE,
      SUBSCRIPTION_PLAN_TYPES.PRO,
      SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
      SUBSCRIPTION_PLAN_TYPES.LEGEND,
    ]);
    const selectedPlanFilter =
      normalizedPlanTypeInput === 'all'
        ? 'all'
        : resolveSubscriptionPlanType(normalizedPlanTypeInput);
    if (!allowedPlanFilters.has(selectedPlanFilter)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid planType. Use one of: all, free, pro, ultimate, legend.',
      });
    }

    const normalizedLimit = normalizeRevenueTrendLimit(normalizedRange, req.query?.limit);
    const cacheKey = getRevenueTrendCacheKey({
      range: normalizedRange,
      tenantId: normalizedTenantId,
      planType: selectedPlanFilter,
      limit: normalizedLimit,
    });
    const cached = getCachedRevenueTrend(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const tenantFilter = {};
    if (normalizedTenantId !== 'all') {
      tenantFilter._id = normalizedTenantId;
    }

    const tenants = await Tenant.find(tenantFilter)
      .select('name code status createdAt subscription')
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
    const addonPurchasesByTenant = new Map();
    const addonKeys = Object.keys(ADDON_PRICE_CATALOG);

    (Array.isArray(planChangeLogs) ? planChangeLogs : []).forEach((entry) => {
      if (!isSuccessfulRevenueAuditLog(entry)) return;

      const tenantId = entry?.tenantId ? String(entry.tenantId) : '';
      if (!tenantId) return;

      const beforePlan = extractSubscriptionPlanTypeFromAuditDetails(entry?.details, 'before');
      const afterPlan = extractSubscriptionPlanTypeFromAuditDetails(entry?.details, 'after');
      const changeTimestamp = toValidDate(entry?.timestamp) || now;

      if (beforePlan || afterPlan) {
        if (!planChangesByTenant.has(tenantId)) {
          planChangesByTenant.set(tenantId, []);
        }

        planChangesByTenant.get(tenantId).push({
          timestamp: changeTimestamp,
          beforePlan: beforePlan || null,
          afterPlan: afterPlan || null,
        });
      }

      const beforeCustomFeatures = extractCustomFeaturesFromAuditDetails(entry?.details, 'before');
      const afterCustomFeatures = extractCustomFeaturesFromAuditDetails(entry?.details, 'after');

      addonKeys.forEach((addonKey) => {
        const wasEnabled = beforeCustomFeatures?.[addonKey] === true;
        const isEnabled = afterCustomFeatures?.[addonKey] === true;
        if (wasEnabled || !isEnabled) return;

        const addonAmount = resolveAddonPurchaseAmount(entry, addonKey);
        if (!Number.isFinite(addonAmount) || addonAmount <= 0) return;

        if (!addonPurchasesByTenant.has(tenantId)) {
          addonPurchasesByTenant.set(tenantId, []);
        }

        addonPurchasesByTenant.get(tenantId).push({
          timestamp: changeTimestamp,
          addonKey,
          amount: Number(addonAmount.toFixed(2)),
        });
      });
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

    const getMonthlyBillingEventsInBucket = (tenant, bucketStart, bucketEnd) => {
      const events = [];
      const subscription = normalizeOptionalObject(tenant?.subscription);
      const billingStart = getTenantBillingStartDate(tenant, now);
      const expiresAt = toValidDate(subscription.expiresAt);
      if (billingStart > bucketEnd) return events;

      const cycleDay = billingStart.getDate();
      let cursor = startOfMonth(bucketStart);
      if (cursor < startOfMonth(billingStart)) {
        cursor = startOfMonth(billingStart);
      }

      for (; cursor <= bucketEnd; cursor = addMonths(cursor, 1)) {
        const year = cursor.getFullYear();
        const month = cursor.getMonth();
        const maxDayInMonth = new Date(year, month + 1, 0).getDate();
        const billingDate = new Date(
          year,
          month,
          Math.min(cycleDay, maxDayInMonth),
          12,
          0,
          0,
          0
        );

        if (billingDate < billingStart) continue;
        if (billingDate < bucketStart || billingDate > bucketEnd) continue;
        if (expiresAt && billingDate > expiresAt) break;

        const historicalPlanType = resolvePlanAtDate(tenant, billingDate);
        const statusAtDate = resolveSubscriptionStatus(subscription, billingDate);
        const effectivePlanType = resolveEffectivePlanType(historicalPlanType, statusAtDate);
        const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
        const amount = Number(planDefinition?.price) || 0;

        if (amount <= 0) continue;
        if (selectedPlanFilter !== 'all' && effectivePlanType !== selectedPlanFilter) continue;

        events.push({
          timestamp: billingDate,
          amount: Number(amount.toFixed(2)),
          type: 'SUBSCRIPTION_PAYMENT',
          planType: effectivePlanType,
        });
      }

      return events;
    };

    const buildBucketRevenue = (bucket) => {
      const bucketStart = toValidDate(bucket?.startDate) || now;
      const bucketEnd = toValidDate(bucket?.endDate) || now;
      let recurringRevenue = 0;
      let oneTimeRevenue = 0;

      (Array.isArray(tenants) ? tenants : []).forEach((tenant) => {
        const monthlyEvents = getMonthlyBillingEventsInBucket(tenant, bucketStart, bucketEnd);
        recurringRevenue += monthlyEvents.reduce(
          (sum, event) => sum + (Number(event?.amount) || 0),
          0
        );

        const tenantId = tenant?._id ? String(tenant._id) : '';
        if (!tenantId) return;

        const planChanges = planChangesByTenant.get(tenantId) || [];
        planChanges.forEach((change) => {
          const changeTime = toValidDate(change?.timestamp);
          if (!changeTime || changeTime < bucketStart || changeTime > bucketEnd) return;

          const beforePlanType = resolveSubscriptionPlanType(
            change?.beforePlan || SUBSCRIPTION_PLAN_TYPES.FREE
          );
          const afterPlanType = resolveSubscriptionPlanType(
            change?.afterPlan || beforePlanType
          );
          const beforePrice = Number(getSubscriptionPlanDefinition(beforePlanType)?.price) || 0;
          const afterPrice = Number(getSubscriptionPlanDefinition(afterPlanType)?.price) || 0;
          const delta = afterPrice - beforePrice;
          if (delta <= 0) return;
          if (selectedPlanFilter !== 'all' && afterPlanType !== selectedPlanFilter) return;

          oneTimeRevenue += Number(delta.toFixed(2));
        });

        const addonPurchases = addonPurchasesByTenant.get(tenantId) || [];
        addonPurchases.forEach((addonEvent) => {
          const purchaseTime = toValidDate(addonEvent?.timestamp);
          if (!purchaseTime || purchaseTime < bucketStart || purchaseTime > bucketEnd) return;

          if (selectedPlanFilter !== 'all') {
            const planAtPurchase = resolveEffectivePlanType(
              resolvePlanAtDate(tenant, purchaseTime),
              resolveSubscriptionStatus(normalizeOptionalObject(tenant?.subscription), purchaseTime)
            );
            if (planAtPurchase !== selectedPlanFilter) return;
          }

          const addonAmount = Number(addonEvent?.amount) || 0;
          if (addonAmount <= 0) return;
          oneTimeRevenue += Number(addonAmount.toFixed(2));
        });
      });

      return {
        recurringRevenue: Number(recurringRevenue.toFixed(2)),
        oneTimeRevenue: Number(oneTimeRevenue.toFixed(2)),
        totalRevenue: Number((recurringRevenue + oneTimeRevenue).toFixed(2)),
      };
    };

    const buckets = buildRevenueTrendBuckets({
      range: normalizedRange,
      now,
      limit: normalizedLimit,
    });

    const trendRows = buckets.map((bucket) => {
      const bucketRevenue = buildBucketRevenue(bucket);
      return {
        label: bucket.label,
        revenue: bucketRevenue.totalRevenue,
      };
    });

    const totalRevenue = trendRows.reduce(
      (sum, row) => sum + (Number(row?.revenue) || 0),
      0
    );

    const payload = {
      success: true,
      data: trendRows,
      summary: {
        total_revenue: Number(totalRevenue.toFixed(2)),
        range: normalizedRange,
      },
      meta: {
        generatedAt: now.toISOString(),
        range: normalizedRange,
        limit: normalizedLimit,
        tenantCount: Array.isArray(tenants) ? tenants.length : 0,
        filters: {
          tenantId: normalizedTenantId,
          planType: selectedPlanFilter,
        },
      },
    };

    setCachedRevenueTrend(cacheKey, payload);

    res.set({
      'Cache-Control': 'private, max-age=30',
    });

    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

/**
 * CREDIT REQUEST MANAGEMENT
 */
router.get('/credit-requests', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
    const limit = Math.min(200, Math.max(parseInt(req.query?.limit, 10) || 20, 1));
    const skip = (page - 1) * limit;
    const statusFilterRaw = String(req.query?.status || 'all')
      .trim()
      .toUpperCase();
    const typeFilter = normalizeCreditRequestType(req.query?.type || '');
    const tenantIdFilter = String(req.query?.tenantId || 'all').trim();

    const filter = {};
    if (statusFilterRaw !== 'ALL') {
      const normalizedStatus = normalizeCreditRequestStatusInput(statusFilterRaw);
      if (!normalizedStatus) {
        return res.status(400).json({
          error: 'status must be ALL, PENDING, APPROVED, or REJECTED',
        });
      }
      filter.status = normalizedStatus;
    }

    if (typeFilter) {
      if (!CREDIT_REQUEST_TYPE_VALUES.has(typeFilter)) {
        return res.status(400).json({
          error: 'type must be one of AI, ATTEMPTS, EXAMS',
        });
      }
      filter.type = typeFilter;
    }

    if (tenantIdFilter !== 'all') {
      if (!isValidMongoId(tenantIdFilter)) {
        return res.status(400).json({
          error: 'tenantId must be "all" or a valid tenant id',
        });
      }
      filter.tenantId = tenantIdFilter;
    }

    const [requests, total, statusSummary] = await Promise.all([
      CreditRequest.find(filter)
        .populate('tenantId', 'name code')
        .populate('requestedBy', 'name email')
        .populate('reviewedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CreditRequest.countDocuments(filter),
      CreditRequest.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const summaryByStatus = {
      [CREDIT_REQUEST_STATUSES.PENDING]: 0,
      [CREDIT_REQUEST_STATUSES.APPROVED]: 0,
      [CREDIT_REQUEST_STATUSES.REJECTED]: 0,
    };
    (Array.isArray(statusSummary) ? statusSummary : []).forEach((entry) => {
      const status = normalizeCreditRequestStatusInput(entry?._id);
      if (!status) return;
      summaryByStatus[status] = Number(entry?.count) || 0;
    });

    return res.json({
      success: true,
      requests: (Array.isArray(requests) ? requests : []).map(buildCreditRequestResponseItem),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: summaryByStatus,
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/credit-requests/:requestId/review', async (req, res, next) => {
  try {
    const requestId = String(req.params?.requestId || '').trim();
    if (!isValidMongoId(requestId)) {
      return res.status(400).json({ error: 'Invalid requestId' });
    }

    const decision = normalizeCreditRequestStatusInput(req.body?.status);
    if (!decision || decision === CREDIT_REQUEST_STATUSES.PENDING) {
      return res.status(400).json({
        error: 'status must be APPROVED or REJECTED',
      });
    }

    const reviewNote = String(req.body?.reviewNote || '')
      .trim()
      .slice(0, 500);

    const existingRequest = await CreditRequest.findById(requestId).lean();
    if (!existingRequest) {
      return res.status(404).json({ error: 'Credit request not found' });
    }

    if (existingRequest.status !== CREDIT_REQUEST_REVIEWABLE_STATUS) {
      return res.status(409).json({
        error: `Credit request is already ${existingRequest.status}`,
      });
    }

    let adjustedCredits = false;
    if (decision === CREDIT_REQUEST_STATUSES.APPROVED) {
      const extraCreditField = resolveTenantExtraCreditFieldByType(existingRequest.type);
      if (!extraCreditField) {
        return res.status(400).json({ error: 'Unsupported credit request type' });
      }

      const updateTenantResult = await Tenant.updateOne(
        { _id: existingRequest.tenantId },
        {
          $inc: {
            [extraCreditField]: Number(existingRequest.requestedAmount) || 0,
          },
          $set: {
            'extraCredits.updatedAt': new Date(),
          },
        }
      );

      if (!updateTenantResult?.matchedCount) {
        return res.status(404).json({ error: 'Tenant not found for credit request' });
      }
      adjustedCredits = true;
    }

    const reviewedRequest = await CreditRequest.findOneAndUpdate(
      {
        _id: requestId,
        status: CREDIT_REQUEST_REVIEWABLE_STATUS,
      },
      {
        $set: {
          status: decision,
          reviewedBy: req.user?._id || null,
          reviewedAt: new Date(),
          reviewNote,
          ...(decision === CREDIT_REQUEST_STATUSES.APPROVED && !existingRequest.unitPriceInr
            ? { unitPriceInr: resolveExtraCreditUnitPrice(existingRequest.type) }
            : {}),
        },
      },
      {
        new: true,
      }
    )
      .populate('tenantId', 'name code')
      .populate('requestedBy', 'name email')
      .populate('reviewedBy', 'name email')
      .lean();

    if (!reviewedRequest) {
      if (adjustedCredits) {
        const rollbackField = resolveTenantExtraCreditFieldByType(existingRequest.type);
        if (rollbackField) {
          await Tenant.updateOne(
            { _id: existingRequest.tenantId },
            {
              $inc: {
                [rollbackField]: -Math.max(Number(existingRequest.requestedAmount) || 0, 0),
              },
            }
          );
        }
      }

      return res.status(409).json({
        error: 'Credit request was already processed by another admin',
      });
    }

    return res.json({
      success: true,
      request: buildCreditRequestResponseItem(reviewedRequest),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/credit-requests/billing-summary', async (req, res, next) => {
  try {
    const now = new Date();
    const tenantIdFilter = String(req.query?.tenantId || 'all').trim();
    const typeFilter = normalizeCreditRequestType(req.query?.type || '');
    const statusesFilterRaw = String(req.query?.statuses || 'APPROVED')
      .trim()
      .toUpperCase();
    const statusesFilter = statusesFilterRaw
      .split(',')
      .map((entry) => normalizeCreditRequestStatusInput(entry))
      .filter(Boolean);

    if (tenantIdFilter !== 'all' && !isValidMongoId(tenantIdFilter)) {
      return res.status(400).json({
        error: 'tenantId must be "all" or a valid tenant id',
      });
    }

    const { start, end } = getCurrentMonthRange(now);
    const tenantFilter = tenantIdFilter === 'all' ? {} : { _id: tenantIdFilter };
    const tenants = await Tenant.find(tenantFilter)
      .select('name code subscription examLimit attemptLimit aiUsageLimit extraCredits')
      .lean();

    const allowedStatuses =
      statusesFilter.length > 0 ? statusesFilter : [CREDIT_REQUEST_STATUSES.APPROVED];
    const requestFilter = {
      status: { $in: allowedStatuses },
      createdAt: { $lte: end },
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(tenantIdFilter !== 'all' ? { tenantId: tenantIdFilter } : {}),
    };
    const approvedRequests = await CreditRequest.find(requestFilter)
      .select('tenantId type requestedAmount status unitPriceInr createdAt')
      .lean();
    const approvedMap = new Map();
    (Array.isArray(approvedRequests) ? approvedRequests : []).forEach((request) => {
      const tenantId = request?.tenantId ? String(request.tenantId) : '';
      if (!tenantId) return;
      if (!approvedMap.has(tenantId)) {
        approvedMap.set(tenantId, {
          requestCount: 0,
          totalApprovedUnits: 0,
          byType: {
            [CREDIT_REQUEST_TYPES.AI]: 0,
            [CREDIT_REQUEST_TYPES.ATTEMPTS]: 0,
            [CREDIT_REQUEST_TYPES.EXAMS]: 0,
          },
        });
      }
      const bucket = approvedMap.get(tenantId);
      const normalizedType = normalizeCreditRequestType(request?.type);
      const amount = Math.max(Number(request?.requestedAmount) || 0, 0);
      bucket.requestCount += 1;
      bucket.totalApprovedUnits += amount;
      if (normalizedType && bucket.byType[normalizedType] !== undefined) {
        bucket.byType[normalizedType] += amount;
      }
    });

    const perTenant = [];
    let totalExtraUsage = 0;
    let totalExtraCost = 0;

    for (const tenant of Array.isArray(tenants) ? tenants : []) {
      const tenantId = tenant?._id ? String(tenant._id) : '';
      if (!tenantId) continue;

      const typesToCompute = typeFilter
        ? [typeFilter]
        : [CREDIT_REQUEST_TYPES.AI, CREDIT_REQUEST_TYPES.ATTEMPTS, CREDIT_REQUEST_TYPES.EXAMS];
      const summaries = await Promise.all(
        typesToCompute.map((type) =>
          computeCreditRequestBillingForTenantType({
            tenant,
            type,
            start,
            end,
          })
        )
      );
      const validSummaries = summaries.filter(Boolean);
      const tenantExtraUsage = validSummaries.reduce(
        (sum, summary) => sum + (Number(summary?.extraUsage) || 0),
        0
      );
      const tenantExtraCost = Number(
        validSummaries
          .reduce((sum, summary) => sum + (Number(summary?.extraCost) || 0), 0)
          .toFixed(2)
      );

      totalExtraUsage += tenantExtraUsage;
      totalExtraCost += tenantExtraCost;

      perTenant.push({
        tenantId,
        tenantName: tenant?.name || 'Unknown Tenant',
        tenantCode: tenant?.code || 'N/A',
        summaries: validSummaries,
        totals: {
          extraUsage: tenantExtraUsage,
          extraCost: tenantExtraCost,
        },
        requests: approvedMap.get(tenantId) || {
          requestCount: 0,
          totalApprovedUnits: 0,
          byType: {
            [CREDIT_REQUEST_TYPES.AI]: 0,
            [CREDIT_REQUEST_TYPES.ATTEMPTS]: 0,
            [CREDIT_REQUEST_TYPES.EXAMS]: 0,
          },
        },
      });
    }

    return res.json({
      success: true,
      period: {
        start,
        end,
      },
      summary: {
        totalExtraUsage: Number(totalExtraUsage) || 0,
        totalExtraCost: Number(totalExtraCost.toFixed(2)) || 0,
        currency: 'INR',
      },
      perTenant,
    });
  } catch (error) {
    return next(error);
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
      .withMessage('status must be one of ACTIVE, EXPIRED, SUSPENDED, or CANCELLED'),
    body('subscriptionStatus')
      .optional()
      .isIn(SUBSCRIPTION_STATUS_VALUES)
      .withMessage('subscriptionStatus must be one of ACTIVE, EXPIRED, SUSPENDED, or CANCELLED'),
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
    body('features')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('features must be an object');
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

      const previousSubscription = toPlainOptionalObject(
        tenant?.subscription?.toObject ? tenant.subscription.toObject() : tenant?.subscription
      );
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
          error: 'subscriptionStatus must be one of ACTIVE, EXPIRED, SUSPENDED, or CANCELLED',
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

      const selectedPlanDefinition = getSubscriptionPlanDefinition(normalizedPlanType);
      const selectedPlanFeatures = normalizeOptionalObject(selectedPlanDefinition?.features);
      const hasCustomLimitsPayload = hasOwn(req.body, 'customLimits');
      const hasCustomFeaturesPayload = hasOwn(req.body, 'customFeatures');
      const hasFeaturesPayload = hasOwn(req.body, 'features');

      const managedFromCustomFeatures = extractManagedPlanFeatureValues(
        req.body.customFeatures,
        'customFeatures'
      );
      const managedFromFeatures = extractManagedPlanFeatureValues(req.body.features, 'features');
      const managedFeatureValidationErrors = [
        ...managedFromCustomFeatures.validationErrors,
        ...managedFromFeatures.validationErrors,
      ];
      if (managedFeatureValidationErrors.length > 0) {
        return res.status(400).json({
          error: 'Invalid feature payload',
          details: managedFeatureValidationErrors,
        });
      }

      const requestedManagedFeatureValues = {
        ...managedFromCustomFeatures.values,
        ...managedFromFeatures.values,
      };

      const restrictedFeatureKey = PLAN_FEATURE_TOGGLE_CANONICAL_KEYS.find(
        (canonicalKey) =>
          selectedPlanFeatures?.[canonicalKey] === true &&
          hasOwn(requestedManagedFeatureValues, canonicalKey) &&
          requestedManagedFeatureValues[canonicalKey] === false
      );
      if (restrictedFeatureKey) {
        return res.status(400).json({
          error: `${restrictedFeatureKey} is included in the selected plan and cannot be disabled.`,
        });
      }

      const previousCustomLimits = toPlainOptionalObject(previousSubscription.customLimits);
      const previousCustomFeatures = toPlainOptionalObject(previousSubscription.customFeatures);
      const nextCustomLimits = toPlainOptionalObject(
        hasCustomLimitsPayload
          ? {
              ...previousCustomLimits,
              ...extractLegendCustomLimits(req.body.customLimits),
            }
          : previousCustomLimits
      );
      const nextCustomFeatures = toPlainOptionalObject(
        hasCustomFeaturesPayload
          ? {
              ...previousCustomFeatures,
              ...extractFeatureOverrides(req.body.customFeatures),
            }
          : previousCustomFeatures
      );

      PLAN_FEATURE_TOGGLE_NON_CANONICAL_ALIAS_KEYS.forEach((aliasKey) => {
        if (hasOwn(nextCustomFeatures, aliasKey)) {
          delete nextCustomFeatures[aliasKey];
        }
      });

      PLAN_FEATURE_TOGGLE_CANONICAL_KEYS.forEach((canonicalKey) => {
        const featureIncludedInPlan = selectedPlanFeatures?.[canonicalKey] === true;

        if (featureIncludedInPlan) {
          if (hasOwn(nextCustomFeatures, canonicalKey)) {
            delete nextCustomFeatures[canonicalKey];
          }
          return;
        }

        if (
          (hasCustomFeaturesPayload || hasFeaturesPayload) &&
          hasOwn(requestedManagedFeatureValues, canonicalKey)
        ) {
          nextCustomFeatures[canonicalKey] = Boolean(requestedManagedFeatureValues[canonicalKey]);
        }
      });

      const nextSubscription = {
        ...toPlainOptionalObject(previousSubscription),
        planType: normalizedPlanType,
        startedAt,
        expiresAt,
        usageResetAt: shouldResetUsage ? now : previousSubscription?.usageResetAt || null,
        customLimits: toPlainOptionalObject(nextCustomLimits),
        customFeatures: toPlainOptionalObject(nextCustomFeatures),
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

      tenant.subscription = {
        ...toPlainOptionalObject(nextSubscription),
        customLimits: toPlainOptionalObject(nextSubscription.customLimits),
        customFeatures: toPlainOptionalObject(nextSubscription.customFeatures),
      };
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
      'name code subscription examLimit attemptLimit aiUsageLimit ai_usage_count updatedAt'
    );
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantFeatures = await buildTenantFeaturePayload(tenant);
    return res.json({ tenantFeatures });
  } catch (error) {
    return next(error);
  }
});

/**
 * ENABLE COMPLETE WIZKIDS PACKAGE FOR ONE TENANT
 * POST /api/super-admin/tenants/:tenantId/wizkids/enable
 *
 * This is deliberately a Super-Admin-only, explicit activation action. It
 * grants every WizKids plan capability and re-enables the corresponding tenant
 * preferences in one auditable operation. Granular controls remain available
 * through the normal tenant-feature update endpoint afterwards.
 */
router.post('/tenants/:tenantId/wizkids/enable', async (req, res, next) => {
  try {
    const tenantId = req.params.tenantId;
    if (!isValidMongoId(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantObject = tenant.toObject ? tenant.toObject() : tenant;
    const subscription = normalizeOptionalObject(tenantObject?.subscription);
    const previousCustomFeatures = extractActiveCustomFeatureOverrides(subscription.customFeatures);
    const nextCustomFeatures = { ...previousCustomFeatures };
    WIZKIDS_PLAN_FEATURE_KEYS.forEach((featureKey) => {
      nextCustomFeatures[featureKey] = true;
    });

    const now = new Date();
    // Store an explicit enabled tenant preference too. This repairs a previous
    // local "off" preference, which otherwise would keep the parent disabled
    // even after its Super Admin entitlement was granted.
    await TenantFeatureSetting.bulkWrite(
      WIZKIDS_CAPABILITY_KEYS.map((featureKey) => ({
        updateOne: {
          filter: { tenantId: tenant._id, featureKey },
          update: {
            $set: {
              requestedEnabled: true,
              superAdminEnforced: false,
              enforcedEnabled: true,
              effectiveEnabled: true,
              planEntitled: true,
              disabledReason: '',
              configuredBy: req.user._id,
              configuredAt: now,
            },
            $inc: { version: 1 },
            $setOnInsert: { tenantId: tenant._id, featureKey },
          },
          upsert: true,
        },
      }))
    );

    tenant.subscription = tenant.subscription || {};
    tenant.subscription.customFeatures = nextCustomFeatures;
    tenant.subscription.updatedAt = now;
    await tenant.save();

    await logAuditEvent(AUDIT_ACTIONS.TENANT_UPDATED, {
      ...buildActorAuditDetails(req),
      tenantId: tenant._id,
      tenantName: tenant.name,
      resourceType: 'Tenant',
      resourceId: tenant._id,
      details: {
        type: 'WIZKIDS_PACKAGE_ENABLED',
        enabledCapabilities: WIZKIDS_CAPABILITY_KEYS,
        enabledPlanFeatures: WIZKIDS_PLAN_FEATURE_KEYS,
        previousCustomFeatures,
        nextCustomFeatures,
      },
    });

    const tenantFeatures = await buildTenantFeaturePayload(tenant);
    return res.json({
      tenantFeatures,
      enabledCapabilities: WIZKIDS_CAPABILITY_KEYS,
    });
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

    const hasDynamicCustomLimitsPayload =
      hasOwn(req.body, 'custom_limits') || hasOwn(req.body, 'customLimits');
    const hasDynamicCustomFeaturesPayload =
      hasOwn(req.body, 'custom_features') || hasOwn(req.body, 'customFeatures');

    if (hasDynamicCustomLimitsPayload || hasDynamicCustomFeaturesPayload) {
      const rawIncomingCustomLimits = hasOwn(req.body, 'custom_limits')
        ? req.body.custom_limits
        : req.body.customLimits;
      const rawIncomingCustomFeatures = hasOwn(req.body, 'custom_features')
        ? req.body.custom_features
        : req.body.customFeatures;

      const incomingCustomLimits = normalizeOptionalObject(rawIncomingCustomLimits);
      const incomingCustomFeatures = normalizeOptionalObject(rawIncomingCustomFeatures);
      if (
        hasDynamicCustomLimitsPayload &&
        (rawIncomingCustomLimits === null ||
          rawIncomingCustomLimits === undefined ||
          typeof rawIncomingCustomLimits !== 'object' ||
          Array.isArray(rawIncomingCustomLimits))
      ) {
        return res.status(400).json({
          error: 'custom_limits/customLimits must be an object.',
        });
      }
      if (
        hasDynamicCustomFeaturesPayload &&
        (rawIncomingCustomFeatures === null ||
          rawIncomingCustomFeatures === undefined ||
          typeof rawIncomingCustomFeatures !== 'object' ||
          Array.isArray(rawIncomingCustomFeatures))
      ) {
        return res.status(400).json({
          error: 'custom_features/customFeatures must be an object.',
        });
      }

      if (
        Object.keys(incomingCustomLimits).length === 0 &&
        Object.keys(incomingCustomFeatures).length === 0
      ) {
        return res.status(400).json({
          error: 'No override updates provided. Include custom_limits and/or custom_features values.',
        });
      }

      const tenantObject = tenant.toObject ? tenant.toObject() : tenant;
      const subscription = normalizeOptionalObject(tenantObject?.subscription);
      const assignedPlanType = resolveSubscriptionPlanType(
        subscription.planType || SUBSCRIPTION_PLAN_TYPES.FREE
      );
      const previousCustomLimits = extractActiveCustomLimitOverrides(subscription.customLimits);
      const previousCustomFeatures = extractActiveCustomFeatureOverrides(subscription.customFeatures);
      const nextCustomLimits = { ...previousCustomLimits };
      const nextCustomFeatures = { ...previousCustomFeatures };

      const validationErrors = [];

      Object.entries(incomingCustomLimits).forEach(([rawKey, rawValue]) => {
        const resolvedKey = normalizeLimitOverrideKey(rawKey);
        if (!resolvedKey) {
          validationErrors.push(`custom_limits.${rawKey} has an invalid key.`);
          return;
        }

        if (rawValue === null || rawValue === undefined || rawValue === '') {
          delete nextCustomLimits[resolvedKey];
          return;
        }

        const parsedValue = Number(rawValue);
        if (!Number.isFinite(parsedValue)) {
          validationErrors.push(`custom_limits.${resolvedKey} must be a number, -1, or null.`);
          return;
        }
        if (parsedValue < 0 && parsedValue !== -1) {
          validationErrors.push(`custom_limits.${resolvedKey} must be non-negative, -1, or null.`);
          return;
        }

        nextCustomLimits[resolvedKey] = parsedValue === -1 ? -1 : Math.floor(parsedValue);
      });

      Object.entries(incomingCustomFeatures).forEach(([rawKey, rawValue]) => {
        const resolvedKey = normalizeFeatureOverrideKey(rawKey);
        if (!resolvedKey) {
          validationErrors.push(`custom_features.${rawKey} has an invalid key.`);
          return;
        }

        if (rawValue === null || rawValue === undefined || rawValue === '') {
          delete nextCustomFeatures[resolvedKey];
          return;
        }

        if (typeof rawValue !== 'boolean') {
          validationErrors.push(`custom_features.${resolvedKey} must be boolean or null.`);
          return;
        }

        nextCustomFeatures[resolvedKey] = Boolean(rawValue);
      });

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: 'Invalid override payload',
          details: validationErrors,
        });
      }

      const limitKeysForValidation = Array.from(
        new Set(
          Object.entries(nextCustomLimits)
            .filter(([, value]) => Number(value) >= 0)
            .map(([key]) => key)
        )
      );
      const limitUsageSnapshot = await resolveTenantLimitUsageSnapshot({
        tenant: tenantObject,
        limitKeys: limitKeysForValidation,
      });

      const usageValidationErrors = [];
      limitKeysForValidation.forEach((key) => {
        const overrideValue = Number(nextCustomLimits[key]);
        const usageValue = toFiniteUsageNumber(limitUsageSnapshot[key]);
        if (usageValue === null) return;
        if (overrideValue < usageValue) {
          usageValidationErrors.push(
            `custom_limits.${key} must be greater than or equal to current usage (${usageValue}).`
          );
        }
      });

      if (usageValidationErrors.length > 0) {
        return res.status(400).json({
          error: 'Limit validation failed',
          details: usageValidationErrors,
        });
      }

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
          type: 'TENANT_OVERRIDE_MANAGEMENT',
          before: {
            planType: assignedPlanType,
            customLimits: previousCustomLimits,
            customFeatures: previousCustomFeatures,
          },
          after: {
            planType: assignedPlanType,
            customLimits: nextCustomLimits,
            customFeatures: nextCustomFeatures,
          },
        },
      });

      const tenantFeatures = await buildTenantFeaturePayload(tenant);
      return res.json({ tenantFeatures });
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

    const previousCustomLimits = extractActiveCustomLimitOverrides(subscription.customLimits);
    const previousCustomFeatures = extractActiveCustomFeatureOverrides(subscription.customFeatures);
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

    const tenantFeatures = await buildTenantFeaturePayload(tenant);
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
 * - tenant_id: all | <tenantId>
 * - tenantId: all | <tenantId> (alias)
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
    const normalizeTenantFilter = (value) => {
      const normalized = String(value || 'all').trim();
      if (!normalized) return 'all';
      if (normalized.toLowerCase() === 'all') return 'all';
      return normalized;
    };
    const normalizedRange = normalizeRange(range);
    const normalizedPeriod = normalizePeriod(period);
    const normalizedModel = normalizeModel(model);
    const normalizedTenantFilter = normalizeTenantFilter(
      req.query?.tenant_id || req.query?.tenantId || 'all'
    );
    const resolvedTenantIdFilter = normalizedTenantFilter || 'all';
    if (resolvedTenantIdFilter !== 'all' && !isValidMongoId(resolvedTenantIdFilter)) {
      return res.status(400).json({
        error: 'tenant_id must be "all" or a valid tenant id.',
      });
    }
    const tenantObjectIdFilter =
      resolvedTenantIdFilter === 'all'
        ? null
        : new mongoose.Types.ObjectId(resolvedTenantIdFilter);

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
      if (tenantObjectIdFilter) {
        match.$or = [
          { tenant_id: tenantObjectIdFilter },
          { tenant_id: resolvedTenantIdFilter },
          { tenantId: tenantObjectIdFilter },
          { tenantId: resolvedTenantIdFilter },
        ];
      }
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

    const tenantLookupFilter =
      tenantObjectIdFilter ? { _id: tenantObjectIdFilter } : {};

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
        Tenant.find(tenantLookupFilter)
          .select('_id name code subscription ai_usage_count ai_usage_limit')
          .sort({ name: 1 })
          .lean(),
      ]);

    const ensureCurrencyFields = (row) => ({
      ...row,
      total_cost_usd: Number(row?.total_cost_usd) || 0,
      total_cost_inr: usdToInr(row?.total_cost_usd),
    });

    const parseOptionalLimit = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return Math.floor(parsed);
    };

    const parseOptionalBoolean = (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return null;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0') return false;
      }
      return null;
    };

    const resolveTenantAiUsageSettings = (tenant = null) => {
      if (!tenant || typeof tenant !== 'object') {
        return {
          enabled: true,
          limit: null,
          aiTypesAllowed: [],
          message: null,
        };
      }

      const subscription =
        tenant.subscription && typeof tenant.subscription === 'object'
          ? tenant.subscription
          : {};
      const customLimits =
        subscription.customLimits &&
        typeof subscription.customLimits === 'object' &&
        !Array.isArray(subscription.customLimits)
          ? subscription.customLimits
          : {};
      const customFeatures =
        subscription.customFeatures &&
        typeof subscription.customFeatures === 'object' &&
        !Array.isArray(subscription.customFeatures)
          ? subscription.customFeatures
          : {};

      const effectivePlanType = resolveEffectivePlanType(
        subscription?.planType || SUBSCRIPTION_PLAN_TYPES.FREE,
        resolveSubscriptionStatus(subscription)
      );
      const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
      const planAiSettings = buildPlanAiSettings(planDefinition);
      const customAiEnabled = parseOptionalBoolean(
        customFeatures.aiGrading ?? customFeatures.ai_enabled ?? customFeatures.aiEnabled
      );
      const aiEnabled =
        typeof customAiEnabled === 'boolean'
          ? customAiEnabled
          : planAiSettings.ai_enabled === true;

      let limit = null;
      if (Object.prototype.hasOwnProperty.call(customLimits, 'maxAiGradingsPerMonth')) {
        const customValue = customLimits.maxAiGradingsPerMonth;
        if (customValue !== null && customValue !== undefined && customValue !== '') {
          limit = Number(customValue) === -1 ? null : parseOptionalLimit(customValue);
        } else {
          limit = resolveAiUsageLimitFromPlanDefinition(planDefinition);
        }
      } else if (Object.prototype.hasOwnProperty.call(customLimits, 'maxAiQuestionsPerMonth')) {
        const legacyCustomValue = customLimits.maxAiQuestionsPerMonth;
        if (
          legacyCustomValue !== null &&
          legacyCustomValue !== undefined &&
          legacyCustomValue !== ''
        ) {
          limit = Number(legacyCustomValue) === -1 ? null : parseOptionalLimit(legacyCustomValue);
        } else {
          limit = resolveAiUsageLimitFromPlanDefinition(planDefinition);
        }
      } else {
        limit = resolveAiUsageLimitFromPlanDefinition(planDefinition);
      }

      return {
        enabled: aiEnabled,
        limit: aiEnabled ? limit : 0,
        aiTypesAllowed: Array.isArray(planAiSettings.ai_types_allowed)
          ? planAiSettings.ai_types_allowed
          : [],
        message: aiEnabled ? null : AI_NOT_AVAILABLE_IN_PLAN_MESSAGE,
      };
    };

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

    const selectedTenant =
      resolvedTenantIdFilter === 'all'
        ? null
        : Array.isArray(tenants) && tenants.length > 0
          ? tenants[0]
          : null;
    const selectedUsageSettings = resolveTenantAiUsageSettings(selectedTenant);
    const selectedUsageUsed = selectedUsageSettings.enabled
      ? Number(selectedTotals.request_count) || 0
      : 0;
    const selectedUsageLimit = selectedUsageSettings.enabled
      ? selectedUsageSettings.limit
      : 0;
    const selectedUsageRemaining =
      selectedUsageLimit === null
        ? null
        : Math.max((Number(selectedUsageLimit) || 0) - selectedUsageUsed, 0);
    const normalizeFeatureType = (value) =>
      String(value || 'unknown')
        .trim()
        .replace(/[\s-]+/g, '_')
        .replace(/[^A-Za-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .toUpperCase();
    const featureTypeCounts = usageByFeature.map((entry) => ({
      type: normalizeFeatureType(entry?.feature),
      count: Number(entry?.request_count) || 0,
      percentage: Math.max(0, Math.min(Number(entry?.percentage) || 0, 100)),
    }));

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
      tenant_id:
        resolvedTenantIdFilter === 'all' ? null : String(resolvedTenantIdFilter),
      usage: {
        used: selectedUsageUsed,
        limit: selectedUsageLimit === null ? 'Unlimited' : selectedUsageLimit,
        remaining:
          selectedUsageLimit === null ? 'Unlimited' : selectedUsageRemaining,
        enabled: selectedUsageSettings.enabled,
        message: selectedUsageSettings.message || null,
        ai_types_allowed: selectedUsageSettings.aiTypesAllowed || [],
      },
      features: featureTypeCounts,
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
        tenant_id: resolvedTenantIdFilter,
        tenantId: resolvedTenantIdFilter,
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
      companyId:
        req.query?.companyId ||
        req.query?.company_id ||
        req.query?.tenantId ||
        req.query?.tenant_id,
      status: req.query?.status,
      triggerType: req.query?.trigger_type || req.query?.backup_type,
      startDate: req.query?.startDate || req.query?.fromDate,
      endDate: req.query?.endDate || req.query?.toDate,
      search: req.query?.search || req.query?.q,
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
      .withMessage('examLimit must be a number (-1 for unlimited) or null'),
    body('attemptLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('attemptLimit must be a number (-1 for unlimited) or null'),
    body('aiUsageLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('aiUsageLimit must be a number (-1 for unlimited) or null'),
    body('customLimits')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return !LEGEND_CUSTOM_LIMIT_KEYS.some(
          (key) => hasOwn(value, key) && !isValidLimitInput(value[key])
        );
      })
      .withMessage('customLimits must contain numbers (-1 for unlimited) or null'),
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
      .withMessage('status must be one of ACTIVE, EXPIRED, SUSPENDED, or CANCELLED'),
    body('subscriptionStatus')
      .optional()
      .isIn(SUBSCRIPTION_STATUS_VALUES)
      .withMessage('subscriptionStatus must be one of ACTIVE, EXPIRED, SUSPENDED, or CANCELLED'),
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

// Update tenant active/inactive status with session invalidation support
router.put(
  '/tenant/:tenantId/status',
  [
    body('status')
      .trim()
      .isIn(['ACTIVE', 'INACTIVE'])
      .withMessage('status must be ACTIVE or INACTIVE'),
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

      const nextStatus = normalizeTenantLifecycleStatus(req.body?.status);
      const previousStatus = normalizeTenantLifecycleStatus(tenant.status);
      const previousTokenVersion = normalizeTenantTokenVersion(tenant.tokenVersion);
      const shouldInvalidateSessions = shouldIncrementTenantTokenVersionForInactivation(
        previousStatus,
        nextStatus
      );

      tenant.status = nextStatus;
      if (shouldInvalidateSessions) {
        tenant.tokenVersion = previousTokenVersion + 1;
      }

      await tenant.save();
      await tenant.populate('createdBy', 'name email');

      await logAuditEvent(AUDIT_ACTIONS.TENANT_UPDATED, {
        ...buildActorAuditDetails(req),
        tenantId: tenant._id,
        tenantName: tenant.name,
        resourceType: 'Tenant',
        resourceId: tenant._id,
        details: {
          updatedFields: ['status', ...(shouldInvalidateSessions ? ['tokenVersion'] : [])],
          tenantName: tenant.name,
          tenantCode: tenant.code,
          beforeStatus: previousStatus,
          afterStatus: tenant.status,
          beforeTokenVersion: previousTokenVersion,
          afterTokenVersion: normalizeTenantTokenVersion(tenant.tokenVersion),
          sessionsInvalidated: shouldInvalidateSessions,
        },
      });

      res.json({
        message: shouldInvalidateSessions
          ? 'Tenant set to INACTIVE and active sessions invalidated successfully.'
          : 'Tenant status updated successfully.',
        tenant,
      });
    } catch (error) {
      next(error);
    }
  }
);

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
      .withMessage('examLimit must be a number (-1 for unlimited) or null'),
    body('attemptLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('attemptLimit must be a number (-1 for unlimited) or null'),
    body('aiUsageLimit')
      .optional({ nullable: true })
      .custom((value) => isValidLimitInput(value))
      .withMessage('aiUsageLimit must be a number (-1 for unlimited) or null'),
    body('customLimits')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return !LEGEND_CUSTOM_LIMIT_KEYS.some(
          (key) => hasOwn(value, key) && !isValidLimitInput(value[key])
        );
      })
      .withMessage('customLimits must contain numbers (-1 for unlimited) or null'),
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
        tokenVersion: normalizeTenantTokenVersion(tenant.tokenVersion),
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
      if (status) {
        const nextStatus = normalizeTenantLifecycleStatus(status);
        tenant.status = nextStatus;
        if (shouldIncrementTenantTokenVersionForInactivation(beforeState.status, nextStatus)) {
          tenant.tokenVersion = normalizeTenantTokenVersion(tenant.tokenVersion) + 1;
        }
      }
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
        tokenVersion: normalizeTenantTokenVersion(tenant.tokenVersion),
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
          beforeTokenVersion: beforeState.tokenVersion,
          afterTokenVersion: normalizeTenantTokenVersion(tenant.tokenVersion),
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
    const beforeTokenVersion = normalizeTenantTokenVersion(tenant.tokenVersion);
    tenant.status = 'INACTIVE';
    if (shouldIncrementTenantTokenVersionForInactivation(beforeStatus, tenant.status)) {
      tenant.tokenVersion = beforeTokenVersion + 1;
    }
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
        beforeTokenVersion,
        afterTokenVersion: normalizeTenantTokenVersion(tenant.tokenVersion),
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
