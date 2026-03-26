import Tenant from '../models/Tenant.js';
import {
  FREE_PLAN_MESSAGES,
  getSubscriptionPlanDefinition,
  resolveEffectivePlanType,
  resolveSubscriptionStatus,
} from '../config/planLimits.js';

export const AI_GRADING_LIMIT_EXCEEDED_MESSAGE =
  'AI grading limit exceeded. Upgrade your plan or wait for reset.';
export const AI_GRADING_NOT_AVAILABLE_MESSAGE = 'AI not available in your plan';

const AI_GRADING_CUSTOM_LIMIT_KEYS = Object.freeze([
  'maxAiGradingsPerMonth',
  'maxAiGradingPerMonth',
  'aiGradingLimitPerMonth',
]);

const AI_GRADING_CUSTOM_FEATURE_KEYS = Object.freeze([
  'aiGrading',
  'ai_enabled',
  'aiEnabled',
]);

const AI_TYPES_ALLOWED_CUSTOM_KEYS = Object.freeze([
  'aiTypesAllowed',
  'ai_types_allowed',
]);

const AI_GRADING_ALLOWED_TYPE_ALIASES = Object.freeze({
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

const TENANT_USAGE_SELECT_FIELDS = [
  'subscription',
  'ai_usage_count',
  'ai_usage_limit',
  'ai_usage_reset_date',
].join(' ');

const normalizePlanType = (value) => String(value || '').trim().toLowerCase();

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
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

const parseOptionalLimit = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.floor(parsed);
};

const parseOptionalDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const isSameDateValue = (left, right) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
};

const getNextMonthlyResetDate = (referenceDate = new Date()) => {
  const safeNow =
    referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
  return new Date(
    safeNow.getFullYear(),
    safeNow.getMonth() + 1,
    1,
    0,
    0,
    0,
    0
  );
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
  return AI_GRADING_ALLOWED_TYPE_ALIASES[normalized] || '';
};

const normalizeAiTypesAllowed = (value) => {
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
        .map((item) => normalizeAiTypeKey(item))
        .filter(Boolean)
    )
  );
};

const resolveTenantPlanType = (tenant = null) => {
  const subscription = tenant?.subscription || {};
  const status = resolveSubscriptionStatus(subscription);
  return normalizePlanType(
    resolveEffectivePlanType(subscription?.planType || 'free', status) || 'free'
  );
};

const resolveCustomAiGradingLimit = (tenant = null) => {
  const customLimits =
    tenant?.subscription?.customLimits &&
    typeof tenant.subscription.customLimits === 'object' &&
    !Array.isArray(tenant.subscription.customLimits)
      ? tenant.subscription.customLimits
      : {};

  for (const key of AI_GRADING_CUSTOM_LIMIT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(customLimits, key)) continue;
    const rawValue = customLimits[key];
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      continue;
    }
    if (Number(rawValue) === -1) {
      return null;
    }
    return parseOptionalLimit(rawValue);
  }

  return null;
};

const resolveCustomAiGradingEnabled = (tenant = null) => {
  const customFeatures =
    tenant?.subscription?.customFeatures &&
    typeof tenant.subscription.customFeatures === 'object' &&
    !Array.isArray(tenant.subscription.customFeatures)
      ? tenant.subscription.customFeatures
      : {};

  for (const key of AI_GRADING_CUSTOM_FEATURE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(customFeatures, key)) continue;
    const parsed = parseOptionalBoolean(customFeatures[key]);
    if (parsed === null) continue;
    return parsed;
  }

  return null;
};

const resolveCustomAiTypesAllowed = (tenant = null) => {
  const customFeatures =
    tenant?.subscription?.customFeatures &&
    typeof tenant.subscription.customFeatures === 'object' &&
    !Array.isArray(tenant.subscription.customFeatures)
      ? tenant.subscription.customFeatures
      : {};

  for (const key of AI_TYPES_ALLOWED_CUSTOM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(customFeatures, key)) continue;
    return normalizeAiTypesAllowed(customFeatures[key]);
  }

  return null;
};

const resolvePlanAiTypesAllowed = (planType = 'free') => {
  const planDefinition = getSubscriptionPlanDefinition(planType);
  const planFeatures =
    planDefinition?.features &&
    typeof planDefinition.features === 'object' &&
    !Array.isArray(planDefinition.features)
      ? planDefinition.features
      : {};
  const allowed =
    planFeatures.aiTypesAllowed ?? planFeatures.ai_types_allowed ?? null;
  const normalizedAllowed = normalizeAiTypesAllowed(allowed);
  return Array.isArray(normalizedAllowed) ? normalizedAllowed : [];
};

const resolveTenantAiTypesAllowed = (tenant = null, planType = 'free') => {
  const customAllowed = resolveCustomAiTypesAllowed(tenant);
  if (Array.isArray(customAllowed)) {
    return customAllowed;
  }
  return resolvePlanAiTypesAllowed(planType);
};

const resolveTenantAiGradingEnabled = (tenant = null, planType = 'free') => {
  const customEnabled = resolveCustomAiGradingEnabled(tenant);
  if (typeof customEnabled === 'boolean') {
    return customEnabled;
  }
  const planDefinition = getSubscriptionPlanDefinition(planType);
  return planDefinition?.features?.aiGrading !== false;
};

const resolveTenantAiGradingLimit = (tenant = null, planType = 'free') => {
  const customLimit = resolveCustomAiGradingLimit(tenant);
  if (customLimit !== null) {
    return customLimit;
  }

  const planDefinition = getSubscriptionPlanDefinition(planType);
  const planAiGradingLimit = parseOptionalLimit(
    planDefinition?.limits?.maxAiGradingsPerMonth
  );
  if (
    planAiGradingLimit !== null ||
    planDefinition?.limits?.maxAiGradingsPerMonth === null
  ) {
    return planAiGradingLimit;
  }

  const legacyPlanAiLimit = parseOptionalLimit(
    planDefinition?.limits?.maxAiQuestionsPerMonth
  );
  if (
    legacyPlanAiLimit !== null ||
    planDefinition?.limits?.maxAiQuestionsPerMonth === null
  ) {
    return legacyPlanAiLimit;
  }

  return 0;
};

const buildUsageSnapshot = ({
  used = 0,
  limit = 0,
  resetDate = null,
  planType = 'free',
  enabled = false,
  aiTypesAllowed = [],
} = {}) => {
  const normalizedPlanType = normalizePlanType(planType) || 'free';
  const normalizedEnabled = enabled === true;
  const normalizedUsed = normalizedEnabled ? toNonNegativeInt(used, 0) : 0;
  const normalizedLimit = normalizedEnabled ? parseOptionalLimit(limit) : 0;
  const unlimited = normalizedEnabled && normalizedLimit === null;
  const remaining = normalizedEnabled
    ? unlimited
      ? null
      : Math.max((normalizedLimit || 0) - normalizedUsed, 0)
    : 0;
  const normalizedAiTypesAllowed = Array.isArray(aiTypesAllowed)
    ? Array.from(new Set(aiTypesAllowed.map((entry) => normalizeAiTypeKey(entry)).filter(Boolean)))
    : [];

  let allowed = normalizedEnabled;
  let message = null;
  if (!normalizedEnabled) {
    message =
      normalizedPlanType === 'free'
        ? FREE_PLAN_MESSAGES.AI_GRADING_LOCKED
        : AI_GRADING_NOT_AVAILABLE_MESSAGE;
  } else if (!unlimited && normalizedUsed >= (normalizedLimit || 0)) {
    allowed = false;
    message = AI_GRADING_LIMIT_EXCEEDED_MESSAGE;
  }

  return {
    used: normalizedUsed,
    limit: normalizedLimit,
    remaining,
    unlimited,
    resetDate: parseOptionalDate(resetDate),
    planType: normalizedPlanType,
    enabled: normalizedEnabled,
    allowed,
    message,
    aiTypesAllowed: normalizedAiTypesAllowed,
  };
};

const ensureTenantUsageState = async ({
  tenantId = null,
  tenant = null,
  now = new Date(),
} = {}) => {
  const resolvedTenantId = tenant?._id || tenantId || null;
  if (!resolvedTenantId) {
    return { tenant: null, snapshot: null };
  }

  let currentTenant = tenant;
  if (!currentTenant) {
    currentTenant = await Tenant.findById(resolvedTenantId)
      .select(TENANT_USAGE_SELECT_FIELDS)
      .lean();
  }

  if (!currentTenant) {
    return { tenant: null, snapshot: null };
  }

  const planType = resolveTenantPlanType(currentTenant);
  const aiEnabled = resolveTenantAiGradingEnabled(currentTenant, planType);
  const aiTypesAllowed = resolveTenantAiTypesAllowed(currentTenant, planType);
  const targetLimit = aiEnabled
    ? resolveTenantAiGradingLimit(currentTenant, planType)
    : 0;

  const storedCount = toNonNegativeInt(currentTenant.ai_usage_count, 0);
  const storedLimit = parseOptionalLimit(currentTenant.ai_usage_limit);
  const storedResetDate = parseOptionalDate(currentTenant.ai_usage_reset_date);
  const shouldResetCycle = !storedResetDate || storedResetDate <= now;
  const nextResetDate = shouldResetCycle
    ? getNextMonthlyResetDate(now)
    : storedResetDate;
  const nextCount = aiEnabled
    ? shouldResetCycle
      ? 0
      : storedCount
    : 0;

  const needsUpdate =
    nextCount !== storedCount ||
    targetLimit !== storedLimit ||
    !isSameDateValue(nextResetDate, storedResetDate);

  if (needsUpdate) {
    const updatedTenant = await Tenant.findByIdAndUpdate(
      resolvedTenantId,
      {
        $set: {
          ai_usage_count: nextCount,
          ai_usage_limit: targetLimit,
          ai_usage_reset_date: nextResetDate,
        },
      },
      {
        new: true,
      }
    )
      .select(TENANT_USAGE_SELECT_FIELDS)
      .lean();
    if (updatedTenant) {
      currentTenant = updatedTenant;
    }
  }

  const snapshot = buildUsageSnapshot({
    used: currentTenant.ai_usage_count,
    limit: targetLimit,
    resetDate: currentTenant.ai_usage_reset_date,
    planType,
    enabled: aiEnabled,
    aiTypesAllowed,
  });

  return {
    tenant: currentTenant,
    snapshot,
  };
};

export const getTenantAiGradingUsageSnapshot = async ({
  tenantId = null,
  tenant = null,
  now = new Date(),
} = {}) => {
  const { snapshot } = await ensureTenantUsageState({ tenantId, tenant, now });
  return snapshot;
};

export const incrementTenantAiGradingUsage = async ({
  tenantId = null,
  now = new Date(),
} = {}) => {
  if (!tenantId) {
    return {
      incremented: false,
      usage: null,
    };
  }

  const { tenant, snapshot } = await ensureTenantUsageState({ tenantId, now });
  if (!tenant || !snapshot || !snapshot.allowed) {
    return {
      incremented: false,
      usage: snapshot,
    };
  }

  const updateFilter = { _id: tenant._id };
  if (!snapshot.unlimited) {
    updateFilter.ai_usage_count = { $lt: snapshot.limit };
  }

  const updatedTenant = await Tenant.findOneAndUpdate(
    updateFilter,
    {
      $inc: { ai_usage_count: 1 },
      $set: {
        ai_usage_limit: snapshot.limit,
        ai_usage_reset_date: snapshot.resetDate || getNextMonthlyResetDate(now),
      },
    },
    {
      new: true,
    }
  )
    .select(TENANT_USAGE_SELECT_FIELDS)
    .lean();

  if (!updatedTenant) {
    const usage = await getTenantAiGradingUsageSnapshot({ tenantId, now });
    return {
      incremented: false,
      usage,
    };
  }

  const usage = await getTenantAiGradingUsageSnapshot({
    tenantId,
    tenant: updatedTenant,
    now,
  });

  return {
    incremented: true,
    usage,
  };
};

export const toAiUsageResponsePayload = (usage = null) => {
  const snapshot = usage && typeof usage === 'object' ? usage : {};
  const enabled = snapshot.enabled !== false;
  const message =
    typeof snapshot.message === 'string' && snapshot.message.trim()
      ? snapshot.message.trim()
      : enabled
        ? null
        : AI_GRADING_NOT_AVAILABLE_MESSAGE;
  const aiTypesAllowed = Array.isArray(snapshot.aiTypesAllowed)
    ? Array.from(new Set(snapshot.aiTypesAllowed.map((entry) => normalizeAiTypeKey(entry)).filter(Boolean)))
    : [];

  if (!enabled) {
    return {
      used: 0,
      limit: 0,
      remaining: 0,
      enabled: false,
      message,
      ai_types_allowed: aiTypesAllowed,
    };
  }

  const normalizedUsed = toNonNegativeInt(snapshot.used, 0);
  const unlimited = snapshot.unlimited === true || snapshot.limit === null;
  if (unlimited) {
    return {
      used: normalizedUsed,
      limit: 'Unlimited',
      remaining: 'Unlimited',
      enabled: true,
      message: null,
      ai_types_allowed: aiTypesAllowed,
    };
  }

  const normalizedLimit = toNonNegativeInt(snapshot.limit, 0);
  const normalizedRemaining = Math.max(
    toNonNegativeInt(snapshot.remaining, normalizedLimit - normalizedUsed),
    0
  );

  return {
    used: normalizedUsed,
    limit: normalizedLimit,
    remaining: normalizedRemaining,
    enabled: true,
    message: null,
    ai_types_allowed: aiTypesAllowed,
  };
};
