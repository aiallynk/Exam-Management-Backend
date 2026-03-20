import { getSubscriptionPlanDefinition } from './planLimits.js';

const COMPILER_PROFILES = Object.freeze({
  locked: Object.freeze({
    mode: 'locked',
    cpuTimeLimitSeconds: 0,
    wallTimeLimitSeconds: 0,
    memoryLimitKb: 0,
    enableNetwork: false,
  }),
  basic: Object.freeze({
    mode: 'basic',
    cpuTimeLimitSeconds: 2,
    wallTimeLimitSeconds: 5,
    memoryLimitKb: 131072,
    enableNetwork: false,
  }),
  advanced: Object.freeze({
    mode: 'advanced',
    cpuTimeLimitSeconds: 6,
    wallTimeLimitSeconds: 12,
    memoryLimitKb: 524288,
    enableNetwork: false,
  }),
});

export const resolveCompilerProfileForPlan = (planType) => {
  const definition = getSubscriptionPlanDefinition(planType);
  const configuredMode = String(definition?.features?.codingCompilerMode || 'basic')
    .trim()
    .toLowerCase();

  return COMPILER_PROFILES[configuredMode] || COMPILER_PROFILES.basic;
};

