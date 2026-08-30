import crypto from 'crypto';
import AnswerScript from '../../models/AnswerScript.js';
import AnswerScriptPage from '../../models/AnswerScriptPage.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import Question from '../../models/Question.js';
import { getPrivateObjectBuffer } from '../storage/imageStorage.js';
import { normalizeAnswerScript } from './answerScriptNormalizationService.js';
import { extractCandidateIdentifiers, extractPageContent } from './documentVisionProvider.js';
import { autoMapCandidate, suggestCandidates, assertNoDuplicateCandidateScript } from './candidateMappingService.js';
import { buildExpectedQuestionSequence, mapSegmentToQuestion } from './answerMappingService.js';
import { decodeMappingTokenFromImageBuffer, resolveAnswerScriptMappingToken } from './machineReadableMappingService.js';
import { routeAndEvaluate } from './evaluationRouterService.js';
import { materializeFromScript } from './attemptMaterializationService.js';
import { resolvePostMaterializeStatus } from './answerScriptFinalizeReadiness.js';
import { generateEvaluatedDerivative } from './evaluatedDerivativeService.js';
import { createSegmentCrop } from './answerSegmentCropService.js';
import { persistCanonicalAnnotations } from './answerAnnotationService.js';
import { ANSWER_SCRIPT_JOB, enqueueAnswerScriptStage } from './answerScriptQueueService.js';
import { refreshAnswerScriptBatchCounters } from './answerScriptBatchService.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../../utils/auditLogger.js';
import { applyAnswerScriptFailure } from './answerScriptFailure.js';

// The Gemini vision model reads PDFs and images natively; label the payload
// with the page's real type (single-page PDF in the default Python-free path,
// JPEG when a rasterizer ran, JPEG for raster crops).
const dataUri = (buffer, mimeType = 'image/jpeg') => `data:${mimeType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
const pageInputMimeType = (page) => page?.workingImage?.mimeType || page?.image?.mimeType || 'image/jpeg';
const identityInputMimeType = (page) => page?.identityHeaderImage?.mimeType || pageInputMimeType(page);
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const queueContext = (script) => ({
  answerScriptId: script._id,
  tenantId: script.tenantId,
  uploaderId: script.createdBy || 'system',
  batchId: script.batchId || null,
});

const updateStage = async (script, { status, stage, job }) => {
  script.status = status;
  script.statusReason = '';
  script.processingMeta = {
    ...script.processingMeta,
    stage,
    heartbeatAt: new Date(),
    activeJobId: String(job?.id || ''),
    startedAt: script.processingMeta?.startedAt || new Date(),
    lastError: '',
  };
  await script.save();
};

const enqueueExtractionPages = async (script) => {
  const pages = await AnswerScriptPage.find({ answerScriptId: script._id }).sort({ pageNumber: 1 });
  const usable = pages.filter((page) => ['GOOD', 'ACCEPTABLE'].includes(page.qualityStatus) && !page.qualityMeta?.isLikelyBlank && (page.workingImage?.key || page.image?.key));
  if (!usable.length) {
    script.status = 'NEEDS_REVIEW';
    script.statusReason = 'No readable non-blank pages are available for extraction.';
    await script.save();
    return [];
  }
  script.status = 'EXTRACTING';
  script.processingMeta.pagesTotal = usable.length;
  script.processingMeta.pagesProcessed = pages.filter((page) => page.extractionCheckpoint?.completedAt).length;
  await script.save();
  return Promise.all(usable.map((page) => enqueueAnswerScriptStage({
    ...queueContext(script),
    stage: ANSWER_SCRIPT_JOB.EXTRACT_PAGE,
    scopeId: page._id,
    version: Number(page.extractionCheckpoint?.attempts || 0) + 1,
  })));
};

const handleNormalize = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  if (!script || ['CANCELLED', 'POSSIBLE_DUPLICATE', 'COMPLETED'].includes(script.status)) return { skipped: true };
  await updateStage(script, { status: 'NORMALIZING', stage: 'NORMALIZING', job });
  const result = await normalizeAnswerScript({ answerScriptId: script._id });
  if (result.duplicate) return { duplicate: true, existingAnswerScriptId: result.existingAnswerScriptId };
  script.stageCheckpoints.set('NORMALIZE_JOB', { completedAt: new Date(), jobId: job.id });
  script.status = 'IDENTIFYING_CANDIDATE';
  await script.save();
  await enqueueAnswerScriptStage({ ...queueContext(script), stage: ANSWER_SCRIPT_JOB.IDENTITY });
  return { pageCount: result.pages.length };
};

const handleIdentity = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  if (!script || ['CANCELLED', 'POSSIBLE_DUPLICATE', 'COMPLETED'].includes(script.status)) return { skipped: true };
  await updateStage(script, { status: 'IDENTIFYING_CANDIDATE', stage: 'IDENTIFYING_CANDIDATE', job });
  if (script.stageCheckpoints?.get?.('IDENTITY')?.completedAt && script.candidateId) {
    await enqueueExtractionPages(script);
    return { resumed: true, candidateId: script.candidateId };
  }
  const firstPage = await AnswerScriptPage.findOne({ answerScriptId: script._id }).sort({ pageNumber: 1 });
  if (!firstPage) throw Object.assign(new Error('The first normalized page is unavailable.'), { code: 'IDENTITY_INPUT_MISSING' });
  const fullKey = firstPage.workingImage?.key || firstPage.image?.key;
  const identityKey = firstPage.identityHeaderImage?.key || fullKey;
  const [fullBuffer, identityBuffer] = await Promise.all([
    getPrivateObjectBuffer({ key: fullKey }),
    identityKey === fullKey ? Promise.resolve(null) : getPrivateObjectBuffer({ key: identityKey }),
  ]);
  const identitySource = identityBuffer || fullBuffer;

  if (!script.candidateId && !script.mappingTokenId && fullBuffer) {
    const decoded = await decodeMappingTokenFromImageBuffer(fullBuffer).catch(() => null);
    if (decoded) {
      const mapping = await resolveAnswerScriptMappingToken({ token: decoded, tenantId: script.tenantId });
      const validScope = mapping
        && String(mapping.examId) === String(script.examId)
        && String(mapping.questionPaperId) === String(script.questionPaperId);
      const used = mapping ? await AnswerScript.exists({ _id: { $ne: script._id }, mappingTokenId: mapping._id }) : null;
      if (validScope && !used) {
        script.mappingTokenId = mapping._id;
        script.examSessionId = mapping.sessionId || null;
        script.candidateId = mapping.candidateId || null;
        script.enrollmentId = mapping.enrollmentId || null;
        script.mappingMethod = 'QR';
        script.mappingConfidence = 1;
      } else {
        script.status = 'NEEDS_MAPPING';
        script.statusReason = used ? 'The detected mapping token is already linked to another answer sheet.' : 'The detected mapping token does not belong to this assessment.';
        await script.save();
        return { needsMapping: true };
      }
    }
  }

  if (!script.candidateId && identitySource) {
    const startedAt = Date.now();
    let identifiers = await extractCandidateIdentifiers({
      imageUrl: dataUri(identitySource, identityInputMimeType(firstPage)),
      tenantId: script.tenantId,
      userId: script.createdBy,
      examId: script.examId,
      answerScriptId: script._id,
      pageNumber: firstPage.pageNumber || 1,
    });
    const hasIdentity = Boolean(identifiers.candidateName || identifiers.rollNumber || identifiers.externalStudentId);
    if (!hasIdentity) {
      const nextPage = await AnswerScriptPage.findOne({
        answerScriptId: script._id,
        pageNumber: { $gt: firstPage.pageNumber || 1 },
      }).sort({ pageNumber: 1 });
      if (nextPage) {
        const nextKey = nextPage.identityHeaderImage?.key || nextPage.workingImage?.key || nextPage.image?.key;
        const nextBuffer = nextKey ? await getPrivateObjectBuffer({ key: nextKey }) : null;
        if (nextBuffer) {
          identifiers = await extractCandidateIdentifiers({
            imageUrl: dataUri(nextBuffer, identityInputMimeType(nextPage)),
            tenantId: script.tenantId,
            userId: script.createdBy,
            examId: script.examId,
            answerScriptId: script._id,
            pageNumber: nextPage.pageNumber,
          });
        }
      }
    }
    script.aiMetrics.identityCalls += identifiers.available ? 1 : 0;
    script.aiMetrics.inputImages += identifiers.available ? 1 : 0;
    script.aiMetrics.latencyMs += Date.now() - startedAt;
    script.identityExtract = {
      candidateName: identifiers.candidateName || '',
      rollNumber: identifiers.rollNumber || '',
      externalStudentId: identifiers.externalStudentId || '',
      confidence: identifiers.confidence ?? null,
      evidence: identifiers.evidence || null,
      provider: identifiers.provider || '',
      model: identifiers.model || '',
    };
    script.detectedRollNumber = identifiers.rollNumber || '';
    script.detectedCandidateName = identifiers.candidateName || '';
    const mapped = await autoMapCandidate({
      tenantId: script.tenantId, examId: script.examId,
      detectedRollNumber: identifiers.rollNumber, detectedCandidateName: identifiers.candidateName,
      detectedExternalStudentId: identifiers.externalStudentId, originalFileName: script.originalFileName,
      identityConfidence: identifiers.confidence,
    });
    if (mapped) {
      const existing = await assertNoDuplicateCandidateScript({
        tenantId: script.tenantId, examId: script.examId, candidateId: mapped.candidateId, excludeScriptId: script._id,
      });
      if (!existing) {
        script.candidateId = mapped.candidateId;
        script.enrollmentId = mapped.enrollmentId || null;
        script.mappingMethod = mapped.method;
        script.mappingConfidence = mapped.confidence;
        script.mappedAt = new Date();
        await logAuditEvent(AUDIT_ACTIONS.OFFLINE_CANDIDATE_AUTO_MAPPED, {
          userId: script.createdBy, tenantId: script.tenantId, resourceType: 'AnswerScript',
          resourceId: script._id, examId: script.examId, candidateId: mapped.candidateId, confidence: mapped.confidence,
        });
      }
    }
    if (!script.candidateId) {
      script.candidateSuggestions = await suggestCandidates({
        tenantId: script.tenantId, examId: script.examId,
        detectedRollNumber: identifiers.rollNumber, detectedCandidateName: identifiers.candidateName,
        detectedExternalStudentId: identifiers.externalStudentId, originalFileName: script.originalFileName,
      });
    }
  }

  if (!script.candidateId) {
    script.status = 'NEEDS_MAPPING';
    script.statusReason = 'Candidate identity could not be confirmed. Map this answer sheet before evaluation continues.';
    script.stageCheckpoints.set('IDENTITY', { completedAt: new Date(), matched: false, inputHash: firstPage.contentHash });
    await script.save();
    return { needsMapping: true };
  }
  script.status = 'CANDIDATE_LOCKED';
  script.mappedAt ||= new Date();
  script.stageCheckpoints.set('IDENTITY', { completedAt: new Date(), matched: true, candidateId: script.candidateId, inputHash: firstPage.contentHash });
  await script.save();
  await enqueueExtractionPages(script);
  return { candidateId: script.candidateId };
};

const handleExtractPage = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  const page = await AnswerScriptPage.findOne({ _id: job.data.scopeId, answerScriptId: script?._id });
  if (!script || !page) return { skipped: true };
  const inputHash = page.contentHash || page.workingImage?.checksum;
  if (page.extractionCheckpoint?.completedAt && page.extractionCheckpoint?.inputHash === inputHash) return { skipped: true, checkpoint: true };
  script.status = 'EXTRACTING';
  script.processingMeta.stage = `EXTRACTING_PAGE_${page.pageNumber}`;
  script.processingMeta.heartbeatAt = new Date();
  await script.save();
  try {
    const buffer = await getPrivateObjectBuffer({ key: page.workingImage?.key || page.image?.key });
    if (!buffer) throw Object.assign(new Error('The normalized page image is unavailable.'), { code: 'EXTRACTION_INPUT_MISSING' });
    const startedAt = Date.now();
    const extraction = await extractPageContent({
      imageUrl: dataUri(buffer, pageInputMimeType(page)), tenantId: script.tenantId, userId: script.createdBy,
      examId: script.examId, answerScriptId: script._id, pageNumber: page.pageNumber,
    });
    if (extraction.error) throw Object.assign(new Error(extraction.error), { code: extraction.available ? 'AI_PROVIDER_TRANSIENT' : 'AI_PROVIDER_UNAVAILABLE' });
    page.extractionConfidence = extraction.pageConfidence ?? null;
    page.ocrText = extraction.segments.map((segment) => segment.text).join('\n');
    page.extractionSegments = extraction.segments;
    page.visionMeta = { provider: extraction.provider || '', model: extraction.model || '' };
    page.extractionCheckpoint = {
      inputHash, completedAt: new Date(), attempts: Number(page.extractionCheckpoint?.attempts || 0) + 1, lastError: '',
    };
    await page.save();
    await AnswerScript.updateOne({ _id: script._id }, {
      $inc: { 'processingMeta.pagesProcessed': 1, 'aiMetrics.extractionCalls': 1, 'aiMetrics.inputImages': 1, 'aiMetrics.latencyMs': Date.now() - startedAt },
      $set: { 'processingMeta.heartbeatAt': new Date() },
    });
    await logAuditEvent(AUDIT_ACTIONS.OFFLINE_OCR_COMPLETED, {
      userId: script.createdBy, tenantId: script.tenantId, resourceType: 'AnswerScriptPage', resourceId: page._id,
      examId: script.examId, segmentCount: extraction.segments.length,
    });
  } catch (error) {
    page.extractionCheckpoint = {
      inputHash, completedAt: null, attempts: Number(page.extractionCheckpoint?.attempts || 0) + 1, lastError: error.message,
    };
    page.processingError = error.message;
    await page.save();
    throw error;
  }
  const remaining = await AnswerScriptPage.countDocuments({
    answerScriptId: script._id,
    qualityStatus: { $in: ['GOOD', 'ACCEPTABLE'] },
    'qualityMeta.isLikelyBlank': { $ne: true },
    'extractionCheckpoint.completedAt': null,
  });
  if (remaining === 0) await enqueueAnswerScriptStage({ ...queueContext(script), stage: ANSWER_SCRIPT_JOB.SEGMENT });
  return { pageNumber: page.pageNumber, segmentCount: page.extractionSegments.length };
};

const handleSegment = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  if (!script) return { skipped: true };
  await updateStage(script, { status: 'SEGMENTING', stage: 'SEGMENTING', job });
  const pages = await AnswerScriptPage.find({ answerScriptId: script._id }).sort({ pageNumber: 1 });
  const pending = [];
  for (const page of pages) {
    for (let index = 0; index < (page.extractionSegments || []).length; index += 1) {
      const proposal = page.extractionSegments[index];
      const pageLineBoxes = (proposal.lineBoxes || []).map((line) => ({ ...line, pageId: page._id }));
      if (proposal.continuesFromPrevious && !proposal.detectedQuestionNumber && pending.length) {
        const previous = pending[pending.length - 1];
        previous.text += `\n${proposal.text}`;
        previous.pageIds.push(page._id);
        previous.confidence = Math.min(previous.confidence, proposal.confidence);
        previous.lineBoxes.push(...pageLineBoxes);
      } else if (String(proposal.text || '').trim()) {
        pending.push({
          segmentKey: hash({ page: page.pageNumber, index, question: proposal.detectedQuestionNumber, text: proposal.text }).slice(0, 32),
          detectedQuestionNumber: proposal.detectedQuestionNumber || '', text: proposal.text,
          confidence: proposal.confidence, pageIds: [page._id], boundingRegion: proposal.region || null,
          lineBoxes: pageLineBoxes, firstPage: page,
        });
      }
    }
  }
  const sequence = await buildExpectedQuestionSequence({ questionPaperId: script.questionPaperId, tenantId: script.tenantId });
  const documents = [];
  for (const proposal of pending) {
    const mapping = mapSegmentToQuestion({
      detectedQuestionNumber: proposal.detectedQuestionNumber,
      extractionConfidence: proposal.confidence,
      sequence,
    });
    const cropObject = await createSegmentCrop({
      script, page: proposal.firstPage, segmentKey: proposal.segmentKey, region: proposal.boundingRegion,
    }).catch(() => null);
    const segment = await AnswerSegment.findOneAndUpdate(
      { tenantId: script.tenantId, answerScriptId: script._id, segmentKey: proposal.segmentKey },
      {
        $set: {
          pageIds: proposal.pageIds, detectedQuestionNumber: proposal.detectedQuestionNumber,
          extractedText: proposal.text, extractionConfidence: proposal.confidence,
          boundingRegion: proposal.boundingRegion, lineBoxes: proposal.lineBoxes, cropObject,
          contentHash: hash({ text: proposal.text, pages: proposal.pageIds }),
          questionId: mapping.questionId, responseType: mapping.questionType || '',
          mappingConfidence: mapping.mappingConfidence, mappingStatus: mapping.mappingStatus,
        },
        $setOnInsert: { tenantId: script.tenantId, answerScriptId: script._id, segmentKey: proposal.segmentKey },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    documents.push(segment);
  }
  script.processingMeta.segmentsExtracted = documents.length;
  script.processingMeta.segmentsMapped = documents.filter((segment) => segment.mappingStatus === 'AUTO_MAPPED').length;
  script.stageCheckpoints.set('SEGMENT', { completedAt: new Date(), segmentCount: documents.length, inputHash: hash(pages.map((page) => page.extractionCheckpoint?.inputHash)) });
  script.status = 'EVALUATING';
  await script.save();
  const evaluable = documents.filter((segment) => segment.questionId && segment.mappingStatus !== 'NEEDS_REVIEW');
  await Promise.all(evaluable.map((segment) => enqueueAnswerScriptStage({
    ...queueContext(script), stage: ANSWER_SCRIPT_JOB.EVALUATE_SEGMENT,
    scopeId: segment._id, version: Number(segment.evaluationCheckpoint?.attempts || 0) + 1,
  })));
  if (!evaluable.length) {
    script.status = 'NEEDS_REVIEW';
    script.statusReason = documents.length ? 'Answer regions require manual question mapping.' : 'No answer regions were extracted.';
    await script.save();
  }
  return { segmentCount: documents.length, evaluableCount: evaluable.length };
};

const handleEvaluateSegment = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  const segment = await AnswerSegment.findOne({ _id: job.data.scopeId, answerScriptId: script?._id });
  if (!script || !segment) return { skipped: true };
  const question = await Question.findById(segment.questionId).lean();
  if (!question) throw Object.assign(new Error('The mapped question no longer exists.'), { code: 'QUESTION_NOT_FOUND' });
  const inputHash = hash({ segment: segment.contentHash, question: question.updatedAt, evaluationConfig: question.evaluationConfig });
  if (segment.evaluationCheckpoint?.completedAt && segment.evaluationCheckpoint?.inputHash === inputHash) return { skipped: true, checkpoint: true };
  script.status = 'EVALUATING';
  script.processingMeta.stage = `EVALUATING_${segment.segmentKey || segment._id}`;
  script.processingMeta.heartbeatAt = new Date();
  await script.save();
  try {
    let pageImageUrl;
    const imageKey = segment.cropObject?.key;
    if (imageKey) {
      const buffer = await getPrivateObjectBuffer({ key: imageKey });
      if (buffer) pageImageUrl = dataUri(buffer);
    }
    const startedAt = Date.now();
    const result = await routeAndEvaluate({
      question, extractedText: segment.extractedText,
      extractionConfidence: segment.extractionConfidence, mappingConfidence: segment.mappingConfidence,
      pageImageUrl, tenantId: script.tenantId, userId: script.createdBy,
      examId: script.examId, answerScriptId: script._id,
    });
    result.maxScore = Number(question.points || 0);
    segment.evaluationResult = result;
    segment.evaluationStatus = 'EVALUATED';
    segment.evaluationCheckpoint = {
      inputHash, completedAt: new Date(), attempts: Number(segment.evaluationCheckpoint?.attempts || 0) + 1, lastError: '',
    };
    await segment.save();
    await persistCanonicalAnnotations({ segmentId: segment._id });
    await AnswerScript.updateOne({ _id: script._id }, {
      $inc: { 'aiMetrics.evaluationCalls': result.evaluationMethod?.startsWith('AI_') ? 1 : 0, 'aiMetrics.latencyMs': Date.now() - startedAt },
      $set: { 'processingMeta.heartbeatAt': new Date() },
    });
  } catch (error) {
    segment.evaluationCheckpoint = {
      inputHash, completedAt: null, attempts: Number(segment.evaluationCheckpoint?.attempts || 0) + 1, lastError: error.message,
    };
    await segment.save();
    throw error;
  }
  const remaining = await AnswerSegment.countDocuments({
    answerScriptId: script._id, questionId: { $ne: null }, mappingStatus: { $ne: 'NEEDS_REVIEW' },
    'evaluationCheckpoint.completedAt': null,
  });
  if (remaining === 0) await enqueueAnswerScriptStage({ ...queueContext(script), stage: ANSWER_SCRIPT_JOB.MATERIALIZE });
  return { segmentId: segment._id, status: segment.evaluationStatus };
};

const handleMaterialize = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  if (!script) return { skipped: true };
  script.status = 'PROCESSING';
  script.processingMeta.stage = 'MATERIALIZE';
  script.processingMeta.heartbeatAt = new Date();
  await script.save();
  const result = await materializeFromScript({ answerScriptId: script._id, actorUserId: script.createdBy });
  script.stageCheckpoints.set('MATERIALIZE', { completedAt: new Date(), attemptId: result.attempt._id, jobId: job.id });
  const next = resolvePostMaterializeStatus(result.needsReviewCount);
  script.status = next.status;
  script.statusReason = next.statusReason;
  script.processingMeta.completedAt = new Date();
  await script.save();
  return { attemptId: result.attempt._id, materializedCount: result.materializedCount };
};

const handleRender = async (job) => {
  const script = await AnswerScript.findById(job.data.answerScriptId);
  if (!script) return { skipped: true };
  await updateStage(script, { status: 'FINALIZING', stage: 'RENDERING_EVALUATED_PAPER', job });
  try {
    await generateEvaluatedDerivative({ answerScriptId: script._id, actorUserId: script.finalizedBy || script.createdBy, scriptDocument: script });
    script.status = 'COMPLETED';
    script.errorCode = '';
    script.failureStage = '';
    script.safeMessage = '';
    script.statusReason = '';
    script.evaluatedDerivative = { ...script.evaluatedDerivative, status: 'READY' };
    script.finalizedAt ||= new Date();
    script.processingMeta.completedAt = new Date();
    script.processingMeta.lastError = '';
    script.stageCheckpoints.set('RENDER', { completedAt: new Date(), jobId: job.id, derivativeKey: script.evaluatedDerivative?.key });
    await script.save();
    return { derivativeKey: script.evaluatedDerivative?.key };
  } catch (error) {
    error.code = error.code || 'DERIVATIVE_FAILED';
    applyAnswerScriptFailure(script, error, 'RENDERING_EVALUATED_PAPER');
    script.status = 'DERIVATIVE_FAILED';
    script.evaluatedDerivative = { ...(script.evaluatedDerivative || {}), status: 'FAILED' };
    await script.save();
    return { derivativeFailed: true, errorCode: 'DERIVATIVE_FAILED' };
  }
};

const handlers = {
  [ANSWER_SCRIPT_JOB.NORMALIZE]: handleNormalize,
  [ANSWER_SCRIPT_JOB.IDENTITY]: handleIdentity,
  [ANSWER_SCRIPT_JOB.EXTRACT_PAGE]: handleExtractPage,
  [ANSWER_SCRIPT_JOB.SEGMENT]: handleSegment,
  [ANSWER_SCRIPT_JOB.EVALUATE_SEGMENT]: handleEvaluateSegment,
  [ANSWER_SCRIPT_JOB.MATERIALIZE]: handleMaterialize,
  [ANSWER_SCRIPT_JOB.RENDER]: handleRender,
};

export const executeAnswerScriptJob = async (job) => {
  const handler = handlers[job.name];
  if (!handler) throw Object.assign(new Error(`Unsupported answer-script job: ${job.name}`), { code: 'UNSUPPORTED_JOB' });
  try {
    const result = await handler(job);
    const script = await AnswerScript.findById(job.data.answerScriptId).select('batchId').lean();
    if (script?.batchId) await refreshAnswerScriptBatchCounters(script.batchId);
    return result;
  } catch (error) {
    await AnswerScript.updateOne({ _id: job.data.answerScriptId }, {
      $set: { 'processingMeta.lastError': error.message, 'processingMeta.heartbeatAt': new Date() },
      $inc: { 'processingMeta.retryCount': 1, 'aiMetrics.retryCount': 1 },
    });
    throw error;
  }
};

export const markAnswerScriptJobPermanentlyFailed = async (job, error) => {
  const script = await AnswerScript.findById(job?.data?.answerScriptId);
  if (!script || ['COMPLETED', 'POSSIBLE_DUPLICATE', 'CANCELLED', 'NEEDS_MAPPING', 'DERIVATIVE_FAILED'].includes(script.status)) return;
  applyAnswerScriptFailure(script, error, script.processingMeta?.stage || job?.name);
  await script.save();
  if (script.batchId) await refreshAnswerScriptBatchCounters(script.batchId);
};
