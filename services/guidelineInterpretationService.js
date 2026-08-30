import GuidelineDocument from '../models/GuidelineDocument.js';
import FrameworkVersion from '../models/FrameworkVersion.js';
import AssessmentFramework from '../models/AssessmentFramework.js';
import { runEngineChatCompletion } from './aiEngine/aiEngineClient.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { dispatchJob, JOB_TYPES } from './jobs/jobDispatcherService.js';
import { parseQuestionImportFile } from './questionImportImageService.js';
import { putPrivateObject, isS3Configured, getPrivateObjectBuffer } from './storage/imageStorage.js';
import { logError } from '../utils/logger.js';
import User from '../models/User.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { isGlobalGovernanceScope, isGovernanceScopeReadable } from '../utils/governanceScope.js';

export class GuidelineError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'GuidelineError';
    this.status = status;
    this.code = code || 'GUIDELINE_ERROR';
  }
};

const assertGuidelineAiEnabled = async (tenantId) => {
  const feature = await resolveTenantFeature(tenantId, 'AI_GUIDELINE_INTERPRETATION');
  if (!feature?.effectiveEnabled) {
    throw new GuidelineError(403, 'Guideline interpretation is not enabled for this tenant.', 'GUIDELINE_AI_DISABLED');
  }
};

const GUIDELINE_SYSTEM_PROMPT = `You interpret assessment guideline documents into a structured framework proposal.
Return JSON only with keys:
frameworkNameSuggestion, assessmentPurpose, assessmentType, questionTypeDistribution, difficultyDistribution,
cognitiveDemandDistribution, bloomDistribution, sectionRules, marks, duration, sourceRestrictions,
questionReuseRules, rubricRequirement, evaluationRules, feedbackRules, retryRules, resultVisibility,
creatorOverridePermissions, evidence.
Use UNKNOWN for any field not supported by the source. Never hallucinate unsupported rules.
Each rule in evidence should include: field, value, confidence (0-1), sourceReference.`;

const parseProposal = (content) => {
  try {
    const parsed = JSON.parse(String(content || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const validateProposal = (proposal) => {
  const rules = {
    assessmentPurpose: proposal.assessmentPurpose || 'UNKNOWN',
    assessmentType: proposal.assessmentType || 'UNKNOWN',
    difficultyDistribution: proposal.difficultyDistribution || {},
    cognitiveDemandDistribution: proposal.cognitiveDemandDistribution || {},
    bloomDistribution: proposal.bloomDistribution || {},
    feedbackRules: proposal.feedbackRules || {},
    retryRules: proposal.retryRules || {},
    resultVisibility: proposal.resultVisibility || 'UNKNOWN',
    creatorOverridePermissions: proposal.creatorOverridePermissions || {},
    sectionRules: proposal.sectionRules || [],
    questionTypeDistribution: proposal.questionTypeDistribution || {},
    sourceRestrictions: proposal.sourceRestrictions || {},
    questionReuseRules: proposal.questionReuseRules || {},
    rubricRequirement: proposal.rubricRequirement ?? 'UNKNOWN',
    evaluationRules: proposal.evaluationRules || {},
    marks: proposal.marks ?? 'UNKNOWN',
    duration: proposal.duration ?? 'UNKNOWN',
  };
  return rules;
};

const runInterpretation = async ({ doc, tenantId, userId, text, onProgress = async () => {} }) => {
  await onProgress(40, 'Identifying assessment rules');
  const completion = await runEngineChatCompletion({
    operation: AI_OPERATIONS.GUIDELINE_INTERPRETATION,
    tenantId,
    userId,
    feature: 'guideline_interpretation',
    request: {
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GUIDELINE_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    },
  });
  await onProgress(75, 'Building blueprint');
  const proposal = parseProposal(completion?.choices?.[0]?.message?.content);
  const rules = validateProposal(proposal);
  doc.extractedText = text;
  doc.proposal = { ...proposal, rules };
  doc.proposalConfidence = proposal.evidence || {};
  doc.sourceEvidence = Array.isArray(proposal.evidence) ? proposal.evidence : [];
  doc.aiOperationMetadata = {
    operation: AI_OPERATIONS.GUIDELINE_INTERPRETATION,
    model: completion?.model || null,
    usage: completion?.usage || null,
  };
  doc.status = 'READY_FOR_REVIEW';
  await doc.save();
  await onProgress(100, 'Ready for review');
  return { guidelineDocumentId: doc._id, status: doc.status };
};

export const interpretGuidelineDocument = async ({ tenantId, userId, guidelineDocumentId, onProgress = async () => {} }) => {
  const doc = await GuidelineDocument.findOne({ _id: guidelineDocumentId, tenantId });
  if (!doc) throw new GuidelineError(404, 'Guideline document not found.', 'NOT_FOUND');

  let text = String(doc.extractedText || doc.rawText || '').trim();
  if (!text && doc.originalObject?.key) {
    await onProgress(15, 'Reading document');
    doc.status = 'EXTRACTING';
    await doc.save();
    const buffer = await getPrivateObjectBuffer({ key: doc.originalObject.key });
    const file = {
      originalname: doc.title || 'guideline.pdf',
      buffer,
      size: buffer.length,
      mimetype: doc.originalObject.mimeType || 'application/pdf',
    };
    const parsed = await parseQuestionImportFile(file, { tenantId });
    text = String(parsed?.text || '').trim();
    if (!text) {
      doc.status = 'FAILED';
      doc.failureReason = 'No extractable text found in guideline document.';
      await doc.save();
      return { guidelineDocumentId: doc._id, status: doc.status };
    }
    doc.extractedText = text;
    doc.status = 'INTERPRETING';
    await doc.save();
  }

  if (!text) {
    doc.status = 'FAILED';
    doc.failureReason = 'No guideline text available for interpretation.';
    await doc.save();
    return { guidelineDocumentId: doc._id, status: doc.status };
  }

  doc.status = 'INTERPRETING';
  await doc.save();
  return runInterpretation({ doc, tenantId, userId, text, onProgress });
};

export const interpretGuidelineText = async ({ tenantId, userId, text, title = '' }) => {
  await assertGuidelineAiEnabled(tenantId);
  const doc = await GuidelineDocument.create({
    tenantId,
    createdBy: userId,
    inputType: text.length > 500 ? 'PASTE' : 'DESCRIPTION',
    title: title || 'Guideline',
    rawText: text,
    extractedText: text,
    status: 'INTERPRETING',
  });

  const job = await dispatchJob({
    jobType: JOB_TYPES.GUIDELINE_INTERPRETATION,
    tenantId,
    correlationId: String(doc._id),
    payload: { tenantId, userId, guidelineDocumentId: doc._id },
  });
  doc.jobId = job.jobId;
  await doc.save();
  return { item: doc, job };
};

export const interpretGuidelineFile = async ({ tenantId, userId, file, title = '' }) => {
  await assertGuidelineAiEnabled(tenantId);
  if (!isS3Configured()) throw new GuidelineError(503, 'Guideline file storage is not configured.', 'STORAGE_NOT_CONFIGURED');

  const doc = await GuidelineDocument.create({
    tenantId,
    createdBy: userId,
    inputType: 'UPLOAD',
    title: title || file.originalname || 'Guideline upload',
    status: 'EXTRACTING',
  });

  const extension = (file.originalname || '').match(/\.[^.]+$/)?.[0]?.replace('.', '') || 'bin';
  const stored = await putPrivateObject({
    tenantId,
    category: 'guidelines',
    subpath: [String(userId)],
    fileStem: 'guideline',
    extension,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
  if (stored) {
    doc.originalObject = { key: stored.key, mimeType: file.mimetype || '', sizeBytes: file.size || file.buffer?.length || 0 };
    await doc.save();
  }

  const job = await dispatchJob({
    jobType: JOB_TYPES.GUIDELINE_INGESTION,
    tenantId,
    correlationId: String(doc._id),
    payload: { tenantId, userId, guidelineDocumentId: doc._id },
  });
  doc.jobId = job.jobId;
  await doc.save();
  return { item: doc, job };
};

export const saveGuidelineProposalAsFrameworkDraft = async ({
  tenantId,
  userId,
  guidelineDocumentId,
  frameworkId = null,
  frameworkName,
  reviewedProposal,
  scope = {},
}) => {
  const doc = await GuidelineDocument.findOne({ _id: guidelineDocumentId, tenantId });
  if (!doc) throw new GuidelineError(404, 'Guideline document not found.', 'NOT_FOUND');
  if (!['READY_FOR_REVIEW', 'DRAFT_SAVED'].includes(doc.status)) {
    throw new GuidelineError(409, 'Guideline proposal is not ready for review.', 'NOT_READY');
  }

  const actor = await User.findById(userId).select('_id role roles tenantId academicAdminScope primaryOrganizationUnitId organizationUnitAccess').lean();
  if (!actor) throw new GuidelineError(403, 'User not found.', 'NOT_AUTHORIZED');
  const visibility = await resolveAcademicVisibility(actor);
  const resolvedScope = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  if (!visibility.all) {
    if (isGlobalGovernanceScope(resolvedScope)) {
      throw new GuidelineError(403, 'A bounded Academic Admin must select an academic scope for framework drafts.', 'SCOPE_REQUIRED');
    }
    if (!isGovernanceScopeReadable(visibility, resolvedScope)) {
      throw new GuidelineError(403, 'The selected governance scope is outside your delegated academic scope.', 'SCOPE_NOT_AUTHORIZED');
    }
  } else if (!hasRole(actor, 'TENANT_ADMIN') && isGlobalGovernanceScope(resolvedScope)) {
    throw new GuidelineError(403, 'Only Tenant Admin may create tenant-wide governance drafts.', 'GLOBAL_SCOPE_NOT_ALLOWED');
  }

  let framework = null;
  if (frameworkId) {
    framework = await AssessmentFramework.findOne({ _id: frameworkId, tenantId });
    if (!framework) throw new GuidelineError(404, 'Framework not found.', 'FRAMEWORK_NOT_FOUND');
  } else {
    framework = await AssessmentFramework.create({
      tenantId,
      name: frameworkName || doc.proposal?.frameworkNameSuggestion || doc.title || 'Guideline Framework',
      code: `GL-${Date.now()}`,
      description: 'Created from guideline interpretation',
      scope: resolvedScope,
      createdBy: userId,
    });
  }

  const rules = reviewedProposal?.rules || doc.proposal?.rules || validateProposal(doc.proposal || {});
  const version = await FrameworkVersion.create({
    tenantId,
    frameworkId: framework._id,
    version: `draft-${Date.now()}`,
    rules,
    status: 'DRAFT',
    guidelineProvenance: {
      guidelineDocumentId: doc._id,
      sourceEvidence: doc.sourceEvidence,
      aiOperationMetadata: doc.aiOperationMetadata,
      createdBy: userId,
    },
  });

  doc.frameworkId = framework._id;
  doc.frameworkVersionId = version._id;
  doc.reviewedBy = userId;
  doc.reviewedAt = new Date();
  doc.status = 'DRAFT_SAVED';
  doc.proposal = reviewedProposal || doc.proposal;
  await doc.save();

  return { framework, frameworkVersion: version, guidelineDocument: doc };
};

export const getGuidelineDocument = async ({ tenantId, userId, guidelineDocumentId }) => {
  const doc = await GuidelineDocument.findOne({ _id: guidelineDocumentId, tenantId }).lean();
  if (!doc) throw new GuidelineError(404, 'Guideline document not found.', 'NOT_FOUND');
  if (String(doc.createdBy) !== String(userId)) {
    throw new GuidelineError(403, 'You can only view your own guideline documents.', 'NOT_AUTHORIZED');
  }
  return doc;
};
