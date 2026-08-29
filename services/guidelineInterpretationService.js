import GuidelineDocument from '../models/GuidelineDocument.js';
import FrameworkVersion from '../models/FrameworkVersion.js';
import AssessmentFramework from '../models/AssessmentFramework.js';
import { runEngineChatCompletion } from './aiEngine/aiEngineClient.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { dispatchJob, JOB_TYPES } from './jobs/jobDispatcherService.js';
import { parseQuestionImportFile } from './questionImportImageService.js';
import { putPrivateObject, isS3Configured } from './storage/imageStorage.js';
import { logError } from '../utils/logger.js';

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

export const interpretGuidelineText = async ({ tenantId, userId, text, title = '' }) => {
  await assertGuidelineAiEnabled(tenantId);
  const doc = await GuidelineDocument.create({
    tenantId,
    createdBy: userId,
    inputType: text.length > 500 ? 'PASTE' : 'DESCRIPTION',
    title: title || 'Guideline',
    rawText: text,
    status: 'INTERPRETING',
  });

  const handler = async () => {
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
    return { guidelineDocumentId: doc._id, status: doc.status };
  };

  const job = await dispatchJob({
    jobType: JOB_TYPES.GUIDELINE_INTERPRETATION,
    tenantId,
    correlationId: String(doc._id),
    payload: { guidelineDocumentId: doc._id },
    handler,
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

  const handler = async () => {
    doc.status = 'EXTRACTING';
    await doc.save();
    const parsed = await parseQuestionImportFile(file, { tenantId });
    const text = String(parsed?.text || '').trim();
    if (!text) {
      doc.status = 'FAILED';
      doc.failureReason = 'No extractable text found in guideline document.';
      await doc.save();
      return { guidelineDocumentId: doc._id, status: doc.status };
    }
    doc.extractedText = text;
    doc.status = 'INTERPRETING';
    await doc.save();

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
    const proposal = parseProposal(completion?.choices?.[0]?.message?.content);
    const rules = validateProposal(proposal);
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
    return { guidelineDocumentId: doc._id, status: doc.status };
  };

  const job = await dispatchJob({
    jobType: JOB_TYPES.GUIDELINE_INGESTION,
    tenantId,
    correlationId: String(doc._id),
    payload: { guidelineDocumentId: doc._id },
    handler,
  });
  doc.jobId = job.jobId;
  await doc.save();
  return { item: doc, job };
};

export const saveGuidelineProposalAsFrameworkDraft = async ({ tenantId, userId, guidelineDocumentId, frameworkId = null, frameworkName, reviewedProposal }) => {
  const doc = await GuidelineDocument.findOne({ _id: guidelineDocumentId, tenantId });
  if (!doc) throw new GuidelineError(404, 'Guideline document not found.', 'NOT_FOUND');
  if (!['READY_FOR_REVIEW', 'DRAFT_SAVED'].includes(doc.status)) {
    throw new GuidelineError(409, 'Guideline proposal is not ready for review.', 'NOT_READY');
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
