export const PLAN_TYPES = Object.freeze({
  FREE: 'free',
  FREE_TRIAL: 'free_trial',
  DEMO: 'demo',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
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

// Backward-compatible alias used by existing code paths.
export const FREE_PLAN_LIMITS = Object.freeze({
  MAX_EXAMS: FREE_TRIAL_LIMITS.maxExams,
  MAX_QUESTIONS_PER_EXAM: FREE_TRIAL_LIMITS.maxQuestions,
  MAX_CANDIDATES_PER_EXAM: FREE_TRIAL_LIMITS.maxAttempts,
});

export const isTrialRestrictedPlan = (planType) => {
  const normalized = String(planType || '').trim().toLowerCase();
  return TRIAL_RESTRICTED_PLAN_TYPES.includes(normalized);
};
