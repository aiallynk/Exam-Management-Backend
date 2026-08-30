import AssessmentFramework from '../models/AssessmentFramework.js';
import FrameworkVersion from '../models/FrameworkVersion.js';
import { assertAcademicContextCoherent } from './academicIntegrityService.js';

const PURPOSE_DEFAULTS = Object.freeze({
  OF: { feedback: { mode: 'AFTER_RELEASE', showCorrectAnswer: false }, evaluation: { stakes: 'SUMMATIVE' } },
  FOR: { feedback: { mode: 'AFTER_QUESTION', showCorrectAnswer: true, retries: 2 }, evaluation: { stakes: 'FORMATIVE' } },
  AS: { feedback: { mode: 'LEARNER_REFLECTION', showCorrectAnswer: false }, evaluation: { stakes: 'SELF_DIRECTED' } },
});

const merge = (base, addition) => {
  if (!addition || typeof addition !== 'object' || Array.isArray(addition)) return base;
  const result = { ...(base || {}) };
  Object.entries(addition).forEach(([key, value]) => {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(result[key], value) : value;
  });
  return result;
};

const permittedOverrides = (rules, overrides) => {
  const allowed = Array.isArray(rules?.allowCreatorOverrides) ? rules.allowCreatorOverrides : [];
  return Object.fromEntries(Object.entries(overrides || {}).filter(([key]) => allowed.includes(key)));
};

const assertFrameworkScopeApplies = ({ scope = {}, purpose, assessmentType, academicContext }) => {
  const subject = { assessmentPurpose: purpose, purpose, assessmentType, ...(academicContext || {}) };
  Object.entries(scope || {}).forEach(([key, allowedValues]) => {
    if (!Array.isArray(allowedValues) || !allowedValues.length) return;
    const value = subject[key];
    if (!value || !allowedValues.map(String).includes(String(value))) {
      throw Object.assign(new Error(`This framework is not applicable to the selected ${key}.`), { statusCode: 400 });
    }
  });
};

export const resolveAssessmentSpecification = async ({ tenantId, purpose = 'OF', academicContext = {}, assessmentType = 'EXAM', frameworkId = null, frameworkVersionId = null, creatorOverrides = {} }) => {
  const normalizedPurpose = ['OF', 'FOR', 'AS'].includes(String(purpose).toUpperCase()) ? String(purpose).toUpperCase() : 'OF';
  await assertAcademicContextCoherent(tenantId, academicContext || {});
  let framework = null;
  let version = null;
  if (frameworkVersionId) {
    version = await FrameworkVersion.findOne({ _id: frameworkVersionId, tenantId, status: 'PUBLISHED' }).lean();
    if (!version) throw Object.assign(new Error('Published framework version not found for this tenant.'), { statusCode: 404 });
    framework = await AssessmentFramework.findOne({ _id: version.frameworkId, tenantId, status: 'ACTIVE' }).lean();
    if (frameworkId && String(frameworkId) !== String(version.frameworkId)) {
      throw Object.assign(new Error('The selected framework version does not belong to the selected framework.'), { statusCode: 400 });
    }
  } else if (frameworkId) {
    framework = await AssessmentFramework.findOne({ _id: frameworkId, tenantId, status: 'ACTIVE' }).lean();
    version = framework && await FrameworkVersion.findOne({ tenantId, frameworkId, status: 'PUBLISHED' }).sort({ publishedAt: -1 }).lean();
  }
  if (frameworkId && (!framework || !version)) throw Object.assign(new Error('An active framework with a published version is required.'), { statusCode: 400 });
  if (framework) assertFrameworkScopeApplies({ scope: framework.scope, purpose: normalizedPurpose, assessmentType, academicContext });
  const rules = version?.rules || {};
  const overrides = permittedOverrides(rules, creatorOverrides);
  return {
    purpose: normalizedPurpose,
    assessmentType: String(assessmentType || 'EXAM').trim().toUpperCase(),
    academicContext,
    framework: framework ? { id: String(framework._id), code: framework.code, name: framework.name } : null,
    frameworkVersion: version ? { id: String(version._id), version: version.version } : null,
    specification: merge(merge(PURPOSE_DEFAULTS[normalizedPurpose], rules), overrides),
    provenance: { defaults: `purpose:${normalizedPurpose}`, frameworkVersionId: version ? String(version._id) : null, creatorOverrideKeys: Object.keys(overrides) },
  };
};

export const qualityGateQuestionsAgainstSpecification = (questions, specification) => {
  const accepted = [];
  const rejected = [];
  (questions || []).forEach((question, index) => {
    if (!question?.questionText || !question?.questionType) {
      rejected.push({ index, code: 'INVALID_SHAPE', message: 'Question is missing a stem or type.' });
    } else {
      accepted.push(question);
    }
  });
  return { accepted, rejected };
};

export const validateQuestionsAgainstSpecification = (questions, specification) =>
  qualityGateQuestionsAgainstSpecification(questions, specification).accepted;
