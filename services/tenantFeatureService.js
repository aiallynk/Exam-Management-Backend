import Tenant from '../models/Tenant.js';
import TenantFeatureSetting from '../models/TenantFeatureSetting.js';
import { isPlanFeatureEnabled, resolveEffectivePlanType, resolveSubscriptionStatus } from '../config/planLimits.js';

export const TENANT_CAPABILITIES = Object.freeze({
  AI_SUBJECTIVE_GRADING: { group: 'AI & Automation', planFeature: 'aiSubjectiveAutoGrading', description: 'AI grading for subjective responses.', releaseStatus: 'RELEASED' },
  AI_MATH_GRADING: { group: 'AI & Automation', platformAvailable: false, planFeature: 'aiGrading', description: 'Mathematical AI grading is not yet released platform-wide.', releaseStatus: 'UNRELEASED' },
  EVALUATOR_REVIEW: { group: 'Evaluation & Verification', planFeature: 'examinerReview', description: 'Human evaluator review and assignment workflows.', releaseStatus: 'RELEASED' },
  MANDATORY_EVALUATOR_REVIEW: { group: 'Evaluation & Verification', planFeature: 'mandatoryVerification', dependsOn: ['EVALUATOR_REVIEW'], description: 'Block publication until configured reviews complete.', releaseStatus: 'RELEASED' },
  MULTIPLE_EVALUATORS: { group: 'Evaluation & Verification', planFeature: 'mandatoryVerification', dependsOn: ['EVALUATOR_REVIEW'], description: 'Assign more than one evaluator to a new exam.', releaseStatus: 'RELEASED' },
  MODERATOR_WORKFLOW: { group: 'Evaluation & Verification', planFeature: 'moderatorWorkflow', dependsOn: ['EVALUATOR_REVIEW'], description: 'Moderation of flagged evaluations.', releaseStatus: 'BETA' },
  BLIND_EVALUATION: { group: 'Evaluation & Verification', planFeature: 'mandatoryVerification', dependsOn: ['EVALUATOR_REVIEW'], description: 'Hide candidate identity in evaluator review.', releaseStatus: 'RELEASED' },
  OMR_EXAMS: { group: 'Examination Modes', planFeature: 'omr', description: 'OMR examination creation and processing.', releaseStatus: 'RELEASED' },
  REMOTE_PROCTORING: { group: 'Monitoring & Proctoring', planFeature: 'advancedProctoring', dependsOn: ['ONLINE_EXAMS'], description: 'Remote online proctoring.', releaseStatus: 'BETA' },
  ONLINE_EXAMS: { group: 'Examination Modes', platformAvailable: true, planFeature: null, description: 'Online examinations.', releaseStatus: 'RELEASED' },
  RESULT_APPROVAL_WORKFLOW: { group: 'Reporting & Administration', planFeature: 'mandatoryVerification', dependsOn: ['EVALUATOR_REVIEW'], description: 'Result approval before publication.', releaseStatus: 'RELEASED' },
});

export const CONTROL_CATEGORY_DEFINITIONS = Object.freeze([
  { id: 'features', name: 'Features and Capabilities', description: 'All controls available to this tenant.', groups: null },
  { id: 'evaluators', name: 'Evaluator Controls', description: 'Human review, moderation, and evaluation workflows.', groups: ['Evaluation & Verification'] },
  { id: 'ai', name: 'AI Controls', description: 'AI-assisted grading and automation controls.', groups: ['AI & Automation'] },
  { id: 'examinations', name: 'Examination Controls', description: 'Exam delivery and evaluation mode controls.', groups: ['Examination Modes'] },
  { id: 'security', name: 'Security Controls', description: 'Monitoring, proctoring, and approval controls.', groups: ['Monitoring & Proctoring', 'Reporting & Administration'] },
  { id: 'plan', name: 'Plan and Entitlements', description: 'Capabilities included with the current subscription.', groups: null },
]);

const keyOf = (key) => String(key || '').trim().toUpperCase();

export const getTenantFeatureSnapshot = async (tenantId) => {
  const [tenant, settings] = await Promise.all([
    Tenant.findById(tenantId).select('subscription').lean(),
    TenantFeatureSetting.find({ tenantId }).lean(),
  ]);
  if (!tenant) return null;
  const planType = resolveEffectivePlanType(tenant.subscription?.planType, resolveSubscriptionStatus(tenant.subscription || {}));
  return { tenant, planType, settingsByKey: new Map(settings.map((setting) => [keyOf(setting.featureKey), setting])) };
};

export const resolveCapabilityEffectiveState = ({
  releaseStatus = 'RELEASED',
  platformAvailable = true,
  planEntitled = false,
  requestedEnabled = true,
  dependencyOk = true,
  superAdminEnforced = false,
}) => {
  if (releaseStatus === 'UNRELEASED' || !platformAvailable) return 'UNRELEASED';
  if (!planEntitled) return 'LOCKED_BY_PLAN';
  if (superAdminEnforced) return 'SUPER_ADMIN_ENFORCED';
  if (!requestedEnabled || !dependencyOk) return 'DISABLED';
  if (releaseStatus === 'BETA') return 'BETA';
  return 'ENABLED';
};

export const canTenantUpdateFeature = (feature, requestedEnabled) => {
  if (!feature) return { allowed: false, error: 'Unknown feature capability.' };
  if (feature.effectiveState === 'UNRELEASED') {
    return { allowed: false, error: 'This capability is unreleased and cannot be changed.' };
  }
  if (feature.superAdminEnforced) {
    return { allowed: false, error: 'This capability is enforced by the platform administrator.' };
  }
  if (requestedEnabled && (!feature.platformAvailable || !feature.planEntitled)) {
    return { allowed: false, error: 'This feature is not included in the tenant plan.' };
  }
  return { allowed: true, error: '' };
};

export const resolveTenantCapabilities = async (tenantId) => {
  const snapshot = await getTenantFeatureSnapshot(tenantId);
  if (!snapshot) return [];
  const resolving = new Set();
  const cache = new Map();
  const resolve = (featureKey) => {
    const key = keyOf(featureKey);
    if (cache.has(key)) return cache.get(key);
    const definition = TENANT_CAPABILITIES[key];
    if (!definition) return null;
    if (resolving.has(key)) throw new Error(`Feature dependency cycle: ${key}`);
    resolving.add(key);
    const releaseStatus = definition.releaseStatus || 'RELEASED';
    const platformAvailable = definition.platformAvailable !== false && releaseStatus !== 'UNRELEASED';
    const planEntitled = definition.planFeature ? isPlanFeatureEnabled(snapshot.planType, definition.planFeature) : true;
    const setting = snapshot.settingsByKey.get(key);
    const superAdminEnforced = setting?.superAdminEnforced === true;
    const tenantEnabled = superAdminEnforced
      ? setting.enforcedEnabled === true
      : setting
        ? setting.requestedEnabled === true
        : true;
    const dependencyStates = (definition.dependsOn || []).map(resolve).filter(Boolean);
    const dependencyOk = dependencyStates.every((state) => state.effectiveEnabled);
    const effectiveState = resolveCapabilityEffectiveState({
      releaseStatus,
      platformAvailable,
      planEntitled,
      requestedEnabled: tenantEnabled,
      dependencyOk,
      superAdminEnforced,
    });
    const state = {
      featureKey: key,
      group: definition.group,
      description: definition.description,
      platformAvailable,
      planEntitled,
      requestedEnabled: setting ? setting.requestedEnabled : true,
      effectiveEnabled: platformAvailable && planEntitled && tenantEnabled && dependencyOk,
      effectiveState,
      disabledReason: effectiveState === 'ENABLED' ? '' : effectiveState,
      releaseStatus,
      superAdminEnforced,
      dependencies: definition.dependsOn || [],
      configuredBy: setting?.configuredBy || null,
      configuredAt: setting?.configuredAt || null,
      version: setting?.version || 0,
    };
    resolving.delete(key);
    cache.set(key, state);
    return state;
  };
  return Object.keys(TENANT_CAPABILITIES).map(resolve);
};

const summarizeControlStates = (features) =>
  features.reduce(
    (counts, feature) => {
      if (feature.effectiveState === 'ENABLED' || feature.effectiveState === 'SUPER_ADMIN_ENFORCED') counts.enabled += 1;
      if (feature.effectiveState === 'DISABLED') counts.disabled += 1;
      if (feature.effectiveState === 'LOCKED_BY_PLAN') counts.locked += 1;
      if (feature.effectiveState === 'BETA') counts.beta += 1;
      if (feature.effectiveState === 'UNRELEASED') counts.unreleased += 1;
      if (feature.effectiveState === 'SUPER_ADMIN_ENFORCED') counts.enforced += 1;
      return counts;
    },
    { enabled: 0, disabled: 0, locked: 0, beta: 0, unreleased: 0, enforced: 0 }
  );

export const buildTenantControlsOverview = async (tenantId) => {
  const features = await resolveTenantCapabilities(tenantId);
  return CONTROL_CATEGORY_DEFINITIONS.map((category) => {
    const categoryFeatures = category.groups
      ? features.filter((feature) => category.groups.includes(feature.group))
      : features;
    return {
      ...category,
      counts: summarizeControlStates(categoryFeatures),
      totalControls: categoryFeatures.length,
    };
  });
};

export const resolveTenantFeature = async (tenantId, featureKey) =>
  (await resolveTenantCapabilities(tenantId)).find((feature) => feature.featureKey === keyOf(featureKey)) || null;

export const requireTenantFeature = (featureKey) => async (req, res, next) => {
  try {
    const state = await resolveTenantFeature(req.user?.tenantId, featureKey);
    if (!state?.effectiveEnabled) {
      return res.status(403).json({ error: 'This capability is not enabled for this tenant.', feature: state || { featureKey } });
    }
    req.tenantFeature = state;
    return next();
  } catch (error) {
    return next(error);
  }
};
