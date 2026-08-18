import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import { resolveTenantFeature } from './tenantFeatureService.js';

const DOMAIN_CAPABILITY = Object.freeze({
  MENTAL_MATHS: 'WIZKIDS_MENTAL_MATHS',
  VEDIC_MATHS: 'WIZKIDS_VEDIC_MATHS',
  SUPER_MATHS: 'WIZKIDS_SUPER_MATHS',
  LOGIC: 'WIZKIDS_LOGIC',
  OLYMPIAD: 'WIZKIDS_OLYMPIAD',
});
const MODE_CAPABILITY = Object.freeze({ PRACTICE: 'WIZKIDS_PRACTICE', SPEED: 'WIZKIDS_SPEED_MODE' });

export class WizKidsAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsAccessError';
    this.status = status;
  }
}

const assertFeature = async (tenantId, featureKey) => {
  const state = await resolveTenantFeature(tenantId, featureKey);
  if (!state?.effectiveEnabled) throw new WizKidsAccessError(403, `The ${featureKey} capability is not enabled for this tenant.`);
};

// A standard route may legitimately operate on either product. This guard is
// deliberately a no-op for STANDARD exams and applies every relevant WizKids
// layer for productModule=WIZKIDS, avoiding scattered boolean checks.
export const assertExamProductAccess = async ({ tenantId, exam }) => {
  if (!exam || exam.productModule !== 'WIZKIDS') return null;
  await assertFeature(tenantId, 'WIZKIDS');
  const config = await WizKidsExamConfig.findOne({ tenantId, examId: exam._id }).select('mode domains').lean();
  if (!config) throw new WizKidsAccessError(404, 'WizKids exam configuration not found.');
  for (const domain of config.domains || []) {
    const capability = DOMAIN_CAPABILITY[domain];
    if (capability) {
      // eslint-disable-next-line no-await-in-loop
      await assertFeature(tenantId, capability);
    }
  }
  const modeCapability = MODE_CAPABILITY[config.mode];
  if (modeCapability) await assertFeature(tenantId, modeCapability);
  return config;
};
