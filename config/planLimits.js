import { getRequestContext } from '../middleware/requestContext.js';

export const PLAN_TYPES = Object.freeze({
  FREE: 'free',
  FREE_TRIAL: 'free_trial',
  DEMO: 'demo',
  PRO: 'pro',
  ULTIMATE: 'ultimate',
  LEGEND: 'legend',
  BUSINESS: 'business',
  ENTERPRISE: 'enterprise',
});

export const SUBSCRIPTION_PLAN_TYPES = Object.freeze({
  FREE: PLAN_TYPES.FREE,
  PRO: PLAN_TYPES.PRO,
  ULTIMATE: PLAN_TYPES.ULTIMATE,
  LEGEND: PLAN_TYPES.LEGEND,
});

export const SUBSCRIPTION_GLOBAL_LIMIT_KEYS = Object.freeze({
  AI_QUESTIONS_PER_MONTH: 'aiQuestionsPerMonth',
  MAX_IMPORT_FILES: 'maxImportFiles',
});

const DEFAULT_SUBSCRIPTION_GLOBAL_LIMITS = Object.freeze({
  [SUBSCRIPTION_GLOBAL_LIMIT_KEYS.AI_QUESTIONS_PER_MONTH]: 10,
  [SUBSCRIPTION_GLOBAL_LIMIT_KEYS.MAX_IMPORT_FILES]: 2,
});

export const SUBSCRIPTION_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
});

export const SUBSCRIPTION_STATUS_MESSAGES = Object.freeze({
  [SUBSCRIPTION_STATUSES.EXPIRED]:
    'Your subscription has expired. Please renew to continue.',
  [SUBSCRIPTION_STATUSES.SUSPENDED]:
    'Your account is temporarily suspended. Contact support or wait for activation.',
  [SUBSCRIPTION_STATUSES.CANCELLED]: 'Your subscription has been cancelled.',
});

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isReadOnlyHttpMethod = (method) =>
  READ_ONLY_HTTP_METHODS.has(String(method || '').trim().toUpperCase());

export const normalizePlanType = (value) => String(value || '').trim().toLowerCase();

const SUBSCRIPTION_PLAN_ALIASES = Object.freeze({
  [PLAN_TYPES.FREE]: PLAN_TYPES.FREE,
  trial: PLAN_TYPES.FREE,
  starter: PLAN_TYPES.FREE,
  [PLAN_TYPES.PRO]: PLAN_TYPES.PRO,
  professional: PLAN_TYPES.PRO,
  basic: PLAN_TYPES.PRO,
  [PLAN_TYPES.ULTIMATE]: PLAN_TYPES.ULTIMATE,
  [PLAN_TYPES.BUSINESS]: PLAN_TYPES.ULTIMATE,
  premium: PLAN_TYPES.ULTIMATE,
  [PLAN_TYPES.LEGEND]: PLAN_TYPES.LEGEND,
  [PLAN_TYPES.ENTERPRISE]: PLAN_TYPES.LEGEND,
});

export const resolveSubscriptionPlanType = (value) => {
  const normalized = normalizePlanType(value);
  return SUBSCRIPTION_PLAN_ALIASES[normalized] || normalized;
};

export const SUBSCRIPTION_PLANS = Object.freeze({
  [SUBSCRIPTION_PLAN_TYPES.FREE]: {
    id: SUBSCRIPTION_PLAN_TYPES.FREE,
    label: 'Free',
    price: 0,
    limits: {
      maxExamsPerMonth: 5,
      maxAttemptsPerMonth: 10,
      maxAiQuestionsPerMonth: 10,
      maxAiGradingsPerMonth: 0,
      maxImportFiles: 2,
      maxUsers: 10,
      maxExamCreators: null,
      maxCandidates: null,
      maxQuestionsPerExam: null,
      // Source-Grounded AI Question Generation — count of context sources
      // (files/URLs) a tenant may ingest per month, distinct from
      // maxImportFiles (question-import files, a different feature).
      maxContextSourcesPerMonth: 3,
    },
    features: {
      // Gated OFF regardless of this default while
      // TENANT_CAPABILITIES.SOURCE_GROUNDED_GENERATION stays UNRELEASED —
      // see services/tenantFeatureService.js.
      sourceGroundedGeneration: false,
      codingCompiler: false,
      proctoring: false,
      advancedProctoring: false,
      omr: false,
      omrAutoGrading: false,
      analytics: false,
      advancedAnalytics: false,
      aiGrading: false,
      aiTypesAllowed: [],
      aiSubjectiveAutoGrading: false,
      aiRubricScoring: false,
      aiQuestionGen: true,
      imageQuestions: true,
      multiTenant: false,
      ipLock: false,
      ipWhitelist: false,
      geoLocationRestriction: false,
      secureBrowser: true,
      tabSwitchDetection: false,
      codingCompilerMode: 'locked',
      proctoringLevel: 'none',
      omrMode: 'none',
      aiGradingMode: 'objective_only',
      questionTypes: ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'MULTIPLE_OPTIONS'],
      reports: 'basic',
      examinerReview: false,
      temporaryExaminerAssignment: false,
      mandatoryVerification: false,
      moderatorWorkflow: false,
    },
  },
  [SUBSCRIPTION_PLAN_TYPES.PRO]: {
    id: SUBSCRIPTION_PLAN_TYPES.PRO,
    label: 'Pro',
    price: 299,
    limits: {
      maxExamsPerMonth: 50,
      maxAttemptsPerMonth: 500,
      maxAiQuestionsPerMonth: 100,
      maxAiGradingsPerMonth: 100,
      maxImportFiles: 15,
      maxUsers: 500,
      maxExamCreators: 10,
      maxCandidates: 150,
      maxQuestionsPerExam: 100,
      maxContextSourcesPerMonth: 15,
    },
    features: {
      sourceGroundedGeneration: true,
      codingCompiler: true,
      proctoring: true,
      advancedProctoring: false,
      omr: true,
      omrAutoGrading: false,
      analytics: true,
      advancedAnalytics: false,
      aiGrading: true,
      aiTypesAllowed: ['short', 'fill_in_the_blank', 'numerical', 'paragraph', 'essay', 'essay_letter', 'essay_story'],
      aiSubjectiveAutoGrading: true,
      aiRubricScoring: false,
      aiQuestionGen: true,
      imageQuestions: true,
      multiTenant: false,
      ipLock: true,
      ipWhitelist: false,
      geoLocationRestriction: false,
      secureBrowser: true,
      tabSwitchDetection: true,
      codingCompilerMode: 'basic',
      proctoringLevel: 'basic',
      omrMode: 'assisted',
      aiGradingMode: 'basic',
      questionTypes: [
        'MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'IMAGE',
        'CODING',
        'MULTIPLE_OPTIONS',
        'FILL_IN_THE_BLANK',
        'MATCHING',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
      ],
      reports: 'detailed',
      examinerReview: true,
      temporaryExaminerAssignment: true,
      mandatoryVerification: false,
      moderatorWorkflow: false,
    },
  },
  [SUBSCRIPTION_PLAN_TYPES.ULTIMATE]: {
    id: SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
    label: 'Ultimate',
    price: 599,
    limits: {
      maxExamsPerMonth: 250,
      maxAttemptsPerMonth: 1000,
      maxAiQuestionsPerMonth: 500,
      maxAiGradingsPerMonth: 1000,
      maxImportFiles: 50,
      maxUsers: 5000,
      maxExamCreators: null,
      maxCandidates: null,
      maxQuestionsPerExam: null,
      maxContextSourcesPerMonth: 40,
    },
    features: {
      sourceGroundedGeneration: true,
      codingCompiler: true,
      proctoring: true,
      advancedProctoring: true,
      omr: true,
      omrAutoGrading: true,
      analytics: true,
      advancedAnalytics: true,
      aiGrading: true,
      aiTypesAllowed: ['short', 'fill_in_the_blank', 'numerical', 'paragraph', 'essay', 'essay_letter', 'essay_story'],
      aiSubjectiveAutoGrading: true,
      aiRubricScoring: true,
      aiQuestionGen: true,
      imageQuestions: true,
      multiTenant: true,
      ipLock: true,
      ipWhitelist: true,
      geoLocationRestriction: true,
      secureBrowser: true,
      tabSwitchDetection: true,
      codingCompilerMode: 'advanced',
      proctoringLevel: 'advanced',
      omrMode: 'full',
      aiGradingMode: 'enhanced',
      questionTypes: [
        'MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'IMAGE',
        'CODING',
        'MULTIPLE_OPTIONS',
        'FILL_IN_THE_BLANK',
        'MATCHING',
        'NUMBER',
        'SCENARIO',
      ],
      reports: 'advanced',
      examinerReview: true,
      temporaryExaminerAssignment: true,
      mandatoryVerification: true,
      moderatorWorkflow: true,
    },
  },
  [SUBSCRIPTION_PLAN_TYPES.LEGEND]: {
    id: SUBSCRIPTION_PLAN_TYPES.LEGEND,
    label: 'Legend (Enterprise)',
    price: 24999,
    limits: {
      maxExamsPerMonth: null,
      maxAttemptsPerMonth: null,
      maxAiQuestionsPerMonth: null,
      maxAiGradingsPerMonth: null,
      maxImportFiles: null,
      maxUsers: null,
      maxExamCreators: null,
      maxCandidates: null,
      maxQuestionsPerExam: null,
      maxContextSourcesPerMonth: null,
    },
    features: {
      sourceGroundedGeneration: true,
      codingCompiler: true,
      proctoring: true,
      advancedProctoring: true,
      omr: true,
      omrAutoGrading: true,
      analytics: true,
      advancedAnalytics: true,
      aiGrading: true,
      aiTypesAllowed: ['short', 'fill_in_the_blank', 'numerical', 'paragraph', 'essay', 'essay_letter', 'essay_story'],
      aiSubjectiveAutoGrading: true,
      aiRubricScoring: true,
      aiQuestionGen: true,
      imageQuestions: true,
      multiTenant: true,
      ipLock: true,
      ipWhitelist: true,
      geoLocationRestriction: true,
      secureBrowser: true,
      tabSwitchDetection: true,
      codingCompilerMode: 'advanced',
      proctoringLevel: 'advanced',
      omrMode: 'full',
      aiGradingMode: 'advanced',
      questionTypes: [
        'MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'IMAGE',
        'CODING',
        'MULTIPLE_OPTIONS',
        'FILL_IN_THE_BLANK',
        'MATCHING',
        'NUMBER',
        'SCENARIO',
      ],
      reports: 'advanced',
      biReports: true,
      externalBIIntegration: true,
      tenantAdminAdvancedControls: true,
      featureCustomization: true,
      enterpriseHierarchy: true,
      examinerReview: true,
      temporaryExaminerAssignment: true,
      mandatoryVerification: true,
      moderatorWorkflow: true,
    },
  },
});

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const cloneJsonValue = (value) => {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
};

const runtimeSubscriptionPlanOverrides = {};
const runtimeSubscriptionGlobalLimits = {
  ...DEFAULT_SUBSCRIPTION_GLOBAL_LIMITS,
};

const parseNonNegativeLimitOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const GLOBAL_LIMIT_TO_PLAN_LIMIT_KEY = Object.freeze({
  [SUBSCRIPTION_GLOBAL_LIMIT_KEYS.AI_QUESTIONS_PER_MONTH]: 'maxAiQuestionsPerMonth',
  [SUBSCRIPTION_GLOBAL_LIMIT_KEYS.MAX_IMPORT_FILES]: 'maxImportFiles',
});

const normalizeGlobalLimitAlias = (key) => {
  const normalized = String(key || '').trim();
  if (!normalized) return '';
  if (normalized === SUBSCRIPTION_GLOBAL_LIMIT_KEYS.AI_QUESTIONS_PER_MONTH) {
    return SUBSCRIPTION_GLOBAL_LIMIT_KEYS.AI_QUESTIONS_PER_MONTH;
  }
  if (
    normalized === 'maxAiQuestionsPerMonth' ||
    normalized === 'aiQuestionLimit' ||
    normalized === 'maxAiQuestions'
  ) {
    return SUBSCRIPTION_GLOBAL_LIMIT_KEYS.AI_QUESTIONS_PER_MONTH;
  }
  if (
    normalized === SUBSCRIPTION_GLOBAL_LIMIT_KEYS.MAX_IMPORT_FILES ||
    normalized === 'importFileLimit' ||
    normalized === 'importQuestionsPerMonth' ||
    normalized === 'maxImportQuestionsPerMonth' ||
    normalized === 'importQuestionsLimit'
  ) {
    return SUBSCRIPTION_GLOBAL_LIMIT_KEYS.MAX_IMPORT_FILES;
  }
  return '';
};

const normalizeGlobalLimits = (input = {}) => {
  if (!isPlainObject(input)) return {};
  const normalized = {};
  Object.entries(input).forEach(([incomingKey, incomingValue]) => {
    const canonicalKey = normalizeGlobalLimitAlias(incomingKey);
    if (!canonicalKey) return;
    normalized[canonicalKey] = parseNonNegativeLimitOrNull(incomingValue);
  });
  return normalized;
};

export const setSubscriptionGlobalLimits = (limits = {}) => {
  Object.keys(runtimeSubscriptionGlobalLimits).forEach((key) => {
    delete runtimeSubscriptionGlobalLimits[key];
  });

  Object.assign(runtimeSubscriptionGlobalLimits, {
    ...DEFAULT_SUBSCRIPTION_GLOBAL_LIMITS,
    ...normalizeGlobalLimits(limits),
  });
};

export const getSubscriptionGlobalLimits = () =>
  cloneJsonValue(runtimeSubscriptionGlobalLimits) || {};

export const updateSubscriptionGlobalLimits = (patch = {}) => {
  if (!isPlainObject(patch)) {
    return getSubscriptionGlobalLimits();
  }

  const normalizedPatch = normalizeGlobalLimits(patch);
  Object.assign(runtimeSubscriptionGlobalLimits, normalizedPatch);
  return getSubscriptionGlobalLimits();
};

const normalizePlanOverrideEntry = (planType, entry = {}) => {
  const basePlan = SUBSCRIPTION_PLANS[planType];
  if (!basePlan || !isPlainObject(entry)) return {};

  const normalized = {};

  if (typeof entry.label === 'string' && entry.label.trim()) {
    normalized.label = entry.label.trim();
  }

  if (entry.price !== undefined && entry.price !== null && entry.price !== '') {
    const parsedPrice = Number(entry.price);
    if (Number.isFinite(parsedPrice) && parsedPrice >= 0) {
      normalized.price = Number(parsedPrice.toFixed(2));
    }
  }

  if (isPlainObject(entry.limits)) {
    const allowedLimitKeys = Object.keys(basePlan.limits || {});
    const normalizedLimits = {};

    allowedLimitKeys.forEach((limitKey) => {
      if (!Object.prototype.hasOwnProperty.call(entry.limits, limitKey)) return;
      const incomingValue = entry.limits[limitKey];

      if (incomingValue === null || incomingValue === undefined || incomingValue === '') {
        normalizedLimits[limitKey] = null;
        return;
      }

      const parsed = Number(incomingValue);
      if (!Number.isFinite(parsed) || parsed < 0) return;
      normalizedLimits[limitKey] = Math.floor(parsed);
    });

    if (Object.keys(normalizedLimits).length > 0) {
      normalized.limits = normalizedLimits;
    }
  }

  if (isPlainObject(entry.features)) {
    normalized.features = cloneJsonValue(entry.features);
  }

  if (isPlainObject(entry.overrides)) {
    const normalizedOverrides = normalizeGlobalLimits(entry.overrides);
    if (Object.keys(normalizedOverrides).length > 0) {
      normalized.overrides = normalizedOverrides;
    }
  }

  return normalized;
};

export const setSubscriptionPlanOverrides = (overrides = {}) => {
  Object.keys(runtimeSubscriptionPlanOverrides).forEach((planType) => {
    delete runtimeSubscriptionPlanOverrides[planType];
  });

  if (!isPlainObject(overrides)) return;

  Object.entries(overrides).forEach(([planTypeKey, overrideEntry]) => {
    const planType = resolveSubscriptionPlanType(planTypeKey);
    if (!SUBSCRIPTION_PLANS[planType]) return;

    const normalized = normalizePlanOverrideEntry(planType, overrideEntry);
    if (Object.keys(normalized).length === 0) return;
    runtimeSubscriptionPlanOverrides[planType] = normalized;
  });
};

export const getSubscriptionPlanOverrides = () => cloneJsonValue(runtimeSubscriptionPlanOverrides) || {};

export const updateSubscriptionPlanOverride = (planType, patch = {}) => {
  const resolvedPlanType = resolveSubscriptionPlanType(planType);
  if (!SUBSCRIPTION_PLANS[resolvedPlanType]) {
    return null;
  }

  const previous = isPlainObject(runtimeSubscriptionPlanOverrides[resolvedPlanType])
    ? runtimeSubscriptionPlanOverrides[resolvedPlanType]
    : {};
  const normalizedPatch = normalizePlanOverrideEntry(resolvedPlanType, patch);

  const nextOverride = {
    ...previous,
    ...normalizedPatch,
    limits: isPlainObject(normalizedPatch.limits)
      ? {
          ...(isPlainObject(previous.limits) ? previous.limits : {}),
          ...normalizedPatch.limits,
        }
      : previous.limits,
    features: isPlainObject(normalizedPatch.features)
      ? {
          ...(isPlainObject(previous.features) ? previous.features : {}),
          ...normalizedPatch.features,
        }
      : previous.features,
    overrides: isPlainObject(normalizedPatch.overrides)
      ? {
          ...(isPlainObject(previous.overrides) ? previous.overrides : {}),
          ...normalizedPatch.overrides,
        }
      : previous.overrides,
  };

  runtimeSubscriptionPlanOverrides[resolvedPlanType] = nextOverride;
  return cloneJsonValue(nextOverride);
};

export const getSubscriptionPlanDefinition = (planType) => {
  const resolved = resolveSubscriptionPlanType(planType);
  const basePlan = SUBSCRIPTION_PLANS[resolved] || SUBSCRIPTION_PLANS[SUBSCRIPTION_PLAN_TYPES.FREE];
  const override = runtimeSubscriptionPlanOverrides[resolved];
  const overrideLimits = isPlainObject(override?.limits) ? override.limits : {};
  const overrideFeatures = isPlainObject(override?.features) ? override.features : {};
  const overrideGlobalLimits = isPlainObject(override?.overrides) ? override.overrides : {};
  const globalLimits = getSubscriptionGlobalLimits();

  const resolvePlanLimitWithGlobalOverride = (limitKey) => {
    const globalLimitKey = Object.entries(GLOBAL_LIMIT_TO_PLAN_LIMIT_KEY).find(
      ([, mappedLimitKey]) => mappedLimitKey === limitKey
    )?.[0];

    if (!globalLimitKey) {
      return Object.prototype.hasOwnProperty.call(overrideLimits, limitKey)
        ? overrideLimits[limitKey]
        : basePlan?.limits?.[limitKey];
    }

    if (Object.prototype.hasOwnProperty.call(overrideGlobalLimits, globalLimitKey)) {
      const overrideValue = overrideGlobalLimits[globalLimitKey];
      if (overrideValue === null) {
        return Object.prototype.hasOwnProperty.call(globalLimits, globalLimitKey)
          ? globalLimits[globalLimitKey]
          : basePlan?.limits?.[limitKey];
      }
      return parseNonNegativeLimitOrNull(overrideValue);
    }

    if (Object.prototype.hasOwnProperty.call(overrideLimits, limitKey)) {
      return overrideLimits[limitKey];
    }

    return basePlan?.limits?.[limitKey];
  };

  const resolvedLimits = {
    ...(basePlan.limits || {}),
    ...overrideLimits,
  };

  Object.values(SUBSCRIPTION_GLOBAL_LIMIT_KEYS).forEach((globalLimitKey) => {
    const mappedLimitKey = GLOBAL_LIMIT_TO_PLAN_LIMIT_KEY[globalLimitKey];
    if (!mappedLimitKey) return;
    resolvedLimits[mappedLimitKey] = resolvePlanLimitWithGlobalOverride(mappedLimitKey);
  });

  return {
    ...basePlan,
    label: typeof override?.label === 'string' && override.label.trim()
      ? override.label.trim()
      : basePlan.label,
    price: Number.isFinite(Number(override?.price)) && Number(override?.price) >= 0
      ? Number(override.price)
      : basePlan.price,
    limits: resolvedLimits,
    features: {
      ...(basePlan.features || {}),
      ...overrideFeatures,
    },
    overrides: cloneJsonValue(overrideGlobalLimits),
  };
};

export const resolveSubscriptionStatus = (subscription = {}, now = new Date()) => {
  const rawStatus = String(subscription.status || '')
    .trim()
    .toUpperCase() || SUBSCRIPTION_STATUSES.ACTIVE;
  if (rawStatus === SUBSCRIPTION_STATUSES.CANCELLED) {
    return SUBSCRIPTION_STATUSES.CANCELLED;
  }
  if (rawStatus === SUBSCRIPTION_STATUSES.SUSPENDED) {
    return SUBSCRIPTION_STATUSES.SUSPENDED;
  }
  const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now) {
    return SUBSCRIPTION_STATUSES.EXPIRED;
  }
  return rawStatus === SUBSCRIPTION_STATUSES.EXPIRED
    ? SUBSCRIPTION_STATUSES.EXPIRED
    : SUBSCRIPTION_STATUSES.ACTIVE;
};

export const resolveEffectivePlanType = (planType, subscriptionStatus) => {
  if (
    subscriptionStatus === SUBSCRIPTION_STATUSES.EXPIRED ||
    subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED ||
    subscriptionStatus === SUBSCRIPTION_STATUSES.CANCELLED
  ) {
    return SUBSCRIPTION_PLAN_TYPES.FREE;
  }
  return resolveSubscriptionPlanType(planType) || SUBSCRIPTION_PLAN_TYPES.FREE;
};

export const FREE_PLAN_MONTHLY_LIMITS = Object.freeze({
  maxExamsPerMonth: 5,
  maxAttemptsPerMonth: 10,
});

export const FREE_TRIAL_LIMITS = Object.freeze({
  maxExamCreators: 1,
  maxCandidates: 2,
  maxExams: 1,
  maxQuestions: 5,
  maxAttempts: 2,
});

export const TRIAL_RESTRICTED_PLAN_TYPES = Object.freeze([
  PLAN_TYPES.FREE_TRIAL,
  PLAN_TYPES.DEMO,
]);

export const PLAN_LIMIT_REDIRECT = '/pricing';
export const PLAN_LIMIT_MESSAGE = 'Free Trial Limit Exhausted';

export const FREE_PLAN_MESSAGES = Object.freeze({
  EXAM_LIMIT: 'Free plan monthly exam limit reached. Upgrade to create more exams.',
  ATTEMPT_LIMIT: 'Free plan monthly attempt limit reached. Upgrade to allow more candidate attempts.',
  AI_QUESTION_LIMIT:
    'Free plan monthly AI question generation limit reached. Upgrade to generate more AI questions.',
  CODING_LOCKED: 'Code questions available only in Pro plan.',
  QUESTION_TYPE_LOCKED: 'Free plan supports only MCQ, Multi Select, True/False, and Short Answer questions.',
  WRITING_AI_LOCKED: 'Upgrade your plan to use writing questions with AI grading',
  OMR_LOCKED: 'OMR evaluation is available only in higher plans.',
  PROCTORING_LOCKED: 'Online proctoring is available only in higher plans.',
  ANALYTICS_LOCKED: 'Advanced analytics are available only in higher plans.',
  AI_GRADING_LOCKED: 'Upgrade your plan to use AI grading',
  IP_WHITELIST_LOCKED: 'IP whitelisting is available only in higher plans.',
  GEO_LOCKED: 'Geo-location restrictions are available only in higher plans.',
  SECURE_BROWSER_LOCKED: 'Secure browser controls are available only in higher plans.',
  MULTI_TENANT_LOCKED: 'Sub-tenant and department controls are available only in higher plans.',
  EXAMINER_REVIEW_LOCKED: 'Examiner assignments and evaluation review are available only in higher plans.',
  MANDATORY_VERIFICATION_LOCKED: 'Mandatory/manual/hybrid evaluation modes are available only in higher plans.',
});

export const PLAN_LIMIT_MESSAGES = Object.freeze({
  EXAM_LIMIT: 'Plan exam limit reached. Upgrade to create more exams.',
  ATTEMPT_LIMIT: 'Plan attempt limit reached. Upgrade to allow more candidate attempts.',
  AI_QUESTION_LIMIT: 'Plan AI question generation limit reached. Upgrade to generate more AI questions.',
  USER_LIMIT: 'Plan user limit reached. Upgrade to add more users.',
  EXAM_CREATOR_LIMIT: 'Plan exam creator limit reached. Upgrade to add more exam creators.',
  CANDIDATE_LIMIT: 'Plan candidate limit reached. Upgrade to add more candidates.',
  QUESTION_LIMIT: 'Plan question limit per exam reached. Upgrade to add more questions.',
});

// Backward-compatible alias used by existing code paths.
export const FREE_PLAN_LIMITS = Object.freeze({
  MAX_EXAMS: FREE_TRIAL_LIMITS.maxExams,
  MAX_QUESTIONS_PER_EXAM: FREE_TRIAL_LIMITS.maxQuestions,
  MAX_CANDIDATES_PER_EXAM: FREE_TRIAL_LIMITS.maxAttempts,
});

export const isTrialRestrictedPlan = (planType) => {
  const normalized = normalizePlanType(planType);
  return TRIAL_RESTRICTED_PLAN_TYPES.includes(normalized);
};

export const isFreePlan = (planType) => {
  const normalized = normalizePlanType(planType);
  return normalized === PLAN_TYPES.FREE;
};

const resolveFeatureOverrides = (featureOverrides = null) => {
  if (featureOverrides && typeof featureOverrides === 'object' && !Array.isArray(featureOverrides)) {
    return featureOverrides;
  }
  const requestContext = getRequestContext();
  const requestFeatureOverrides = requestContext?.req?.user?.subscriptionCustomFeatures;
  if (
    requestFeatureOverrides &&
    typeof requestFeatureOverrides === 'object' &&
    !Array.isArray(requestFeatureOverrides)
  ) {
    return requestFeatureOverrides;
  }
  return null;
};

export const isPlanFeatureEnabled = (planType, featureKey, featureOverrides = null) => {
  const plan = getSubscriptionPlanDefinition(planType);
  if (!featureKey) return true;
  const overrides = resolveFeatureOverrides(featureOverrides);
  if (
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, featureKey) &&
    typeof overrides[featureKey] === 'boolean'
  ) {
    return overrides[featureKey];
  }
  const value = plan?.features?.[featureKey];
  return value !== false;
};
