import SystemConfig from '../models/SystemConfig.js';
import {
  SUBSCRIPTION_PLAN_TYPES,
  getSubscriptionGlobalLimits,
  getSubscriptionPlanDefinition,
  getSubscriptionPlanOverrides,
  resolveSubscriptionPlanType,
  setSubscriptionGlobalLimits,
  setSubscriptionPlanOverrides,
  updateSubscriptionGlobalLimits,
  updateSubscriptionPlanOverride,
} from '../config/planLimits.js';

const PLAN_OVERRIDES_CONFIG_KEY = 'subscription_plan_catalog_overrides_v1';
const PLAN_OVERRIDES_DESCRIPTION =
  'Runtime overrides for subscription plan catalog (price, limits, labels, features).';
const GLOBAL_LIMITS_CONFIG_KEY = 'subscription_global_limits_v1';
const GLOBAL_LIMITS_DESCRIPTION =
  'Global subscription limits used as fallback for plan-specific override settings.';

const PLAN_ORDER = Object.freeze([
  SUBSCRIPTION_PLAN_TYPES.FREE,
  SUBSCRIPTION_PLAN_TYPES.PRO,
  SUBSCRIPTION_PLAN_TYPES.ULTIMATE,
  SUBSCRIPTION_PLAN_TYPES.LEGEND,
]);

const toPlainObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const parseOverridesValue = (rawValue) => {
  if (!rawValue || typeof rawValue !== 'string') return {};
  try {
    const parsed = JSON.parse(rawValue);
    return toPlainObject(parsed);
  } catch {
    return {};
  }
};

export { getSubscriptionGlobalLimits };

export const getSubscriptionPlanCatalog = () =>
  PLAN_ORDER.map((planType) => getSubscriptionPlanDefinition(planType));

export const initializeSubscriptionPlanCatalog = async () => {
  const configEntries = await SystemConfig.find({
    key: { $in: [PLAN_OVERRIDES_CONFIG_KEY, GLOBAL_LIMITS_CONFIG_KEY] },
  })
    .select('key value')
    .lean();

  const overridesEntry = configEntries.find((entry) => entry?.key === PLAN_OVERRIDES_CONFIG_KEY);
  const globalLimitsEntry = configEntries.find((entry) => entry?.key === GLOBAL_LIMITS_CONFIG_KEY);

  const parsedOverrides = parseOverridesValue(overridesEntry?.value);
  const parsedGlobalLimits = parseOverridesValue(globalLimitsEntry?.value);
  setSubscriptionPlanOverrides(parsedOverrides);
  setSubscriptionGlobalLimits(parsedGlobalLimits);
  return parsedOverrides;
};

export const persistSubscriptionPlanOverride = async ({
  planType,
  patch = {},
  updatedBy = null,
}) => {
  const resolvedPlanType = resolveSubscriptionPlanType(planType);
  const updatedOverride = updateSubscriptionPlanOverride(resolvedPlanType, patch);
  if (!updatedOverride) {
    return null;
  }

  const allOverrides = getSubscriptionPlanOverrides();
  await SystemConfig.findOneAndUpdate(
    { key: PLAN_OVERRIDES_CONFIG_KEY },
    {
      $set: {
        value: JSON.stringify(allOverrides),
        description: PLAN_OVERRIDES_DESCRIPTION,
        updatedBy: updatedBy || null,
      },
      $setOnInsert: {
        key: PLAN_OVERRIDES_CONFIG_KEY,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  return getSubscriptionPlanDefinition(resolvedPlanType);
};

export const persistSubscriptionGlobalLimits = async ({
  patch = {},
  updatedBy = null,
}) => {
  const nextGlobalLimits = updateSubscriptionGlobalLimits(patch);

  await SystemConfig.findOneAndUpdate(
    { key: GLOBAL_LIMITS_CONFIG_KEY },
    {
      $set: {
        value: JSON.stringify(nextGlobalLimits),
        description: GLOBAL_LIMITS_DESCRIPTION,
        updatedBy: updatedBy || null,
      },
      $setOnInsert: {
        key: GLOBAL_LIMITS_CONFIG_KEY,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  return getSubscriptionGlobalLimits();
};
