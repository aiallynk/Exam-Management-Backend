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

export const SUBSCRIPTION_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  SUSPENDED: 'SUSPENDED',
});

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
      maxUsers: 10,
      maxExamCreators: null,
      maxCandidates: null,
      maxQuestionsPerExam: null,
    },
    features: {
      codingCompiler: false,
      proctoring: false,
      advancedProctoring: false,
      omr: false,
      omrAutoGrading: false,
      analytics: false,
      advancedAnalytics: false,
      aiGrading: false,
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
      questionTypes: ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER'],
      reports: 'basic',
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
      maxUsers: 500,
      maxExamCreators: 10,
      maxCandidates: 150,
      maxQuestionsPerExam: 100,
    },
    features: {
      codingCompiler: true,
      proctoring: true,
      advancedProctoring: false,
      omr: true,
      omrAutoGrading: false,
      analytics: true,
      advancedAnalytics: false,
      aiGrading: true,
      aiSubjectiveAutoGrading: false,
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
      aiGradingMode: 'objective_only',
      questionTypes: ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'PARAGRAPH', 'IMAGE', 'CODING'],
      reports: 'detailed',
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
      maxUsers: 5000,
      maxExamCreators: null,
      maxCandidates: null,
      maxQuestionsPerExam: null,
    },
    features: {
      codingCompiler: true,
      proctoring: true,
      advancedProctoring: true,
      omr: true,
      omrAutoGrading: true,
      analytics: true,
      advancedAnalytics: true,
      aiGrading: true,
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
      aiGradingMode: 'full',
      questionTypes: [
        'MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'IMAGE',
        'CODING',
        'MULTIPLE_OPTIONS',
        'NUMBER',
        'SCENARIO',
      ],
      reports: 'advanced',
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
      maxUsers: null,
      maxExamCreators: null,
      maxCandidates: null,
      maxQuestionsPerExam: null,
    },
    features: {
      codingCompiler: true,
      proctoring: true,
      advancedProctoring: true,
      omr: true,
      omrAutoGrading: true,
      analytics: true,
      advancedAnalytics: true,
      aiGrading: true,
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
      aiGradingMode: 'full',
      questionTypes: [
        'MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'IMAGE',
        'CODING',
        'MULTIPLE_OPTIONS',
        'NUMBER',
        'SCENARIO',
      ],
      reports: 'advanced',
      biReports: true,
      externalBIIntegration: true,
      tenantAdminAdvancedControls: true,
      featureCustomization: true,
      enterpriseHierarchy: true,
    },
  },
});

export const getSubscriptionPlanDefinition = (planType) => {
  const resolved = resolveSubscriptionPlanType(planType);
  return SUBSCRIPTION_PLANS[resolved] || SUBSCRIPTION_PLANS[SUBSCRIPTION_PLAN_TYPES.FREE];
};

export const resolveSubscriptionStatus = (subscription = {}, now = new Date()) => {
  const rawStatus = String(subscription.status || '')
    .trim()
    .toUpperCase() || SUBSCRIPTION_STATUSES.ACTIVE;
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
    subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED
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
  CODING_LOCKED: 'Coding questions are available only in higher plans.',
  QUESTION_TYPE_LOCKED: 'Free plan supports only MCQ, True/False, and Short Answer questions.',
  OMR_LOCKED: 'OMR evaluation is available only in higher plans.',
  PROCTORING_LOCKED: 'Online proctoring is available only in higher plans.',
  ANALYTICS_LOCKED: 'Advanced analytics are available only in higher plans.',
  AI_GRADING_LOCKED: 'Automated grading is available only in higher plans.',
  IP_WHITELIST_LOCKED: 'IP whitelisting is available only in higher plans.',
  GEO_LOCKED: 'Geo-location restrictions are available only in higher plans.',
  SECURE_BROWSER_LOCKED: 'Secure browser controls are available only in higher plans.',
  MULTI_TENANT_LOCKED: 'Sub-tenant and department controls are available only in higher plans.',
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
