import AnswerScript from '../../models/AnswerScript.js';
import AnswerScriptPage from '../../models/AnswerScriptPage.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import Question from '../../models/Question.js';
import { getPrivateObjectBuffer } from '../storage/imageStorage.js';
import { splitIntoPages } from './pdfPageSplitter.js';
import { extractPageContent, extractCandidateIdentifiers } from './documentVisionProvider.js';
import { autoMapCandidate, suggestCandidates, assertNoDuplicateCandidateScript } from './candidateMappingService.js';
import { buildExpectedQuestionSequence, mapSegmentToQuestion } from './answerMappingService.js';
import { routeAndEvaluate } from './evaluationRouterService.js';
import { materializeFromScript } from './attemptMaterializationService.js';
import {
  decodeMappingTokenFromImageBuffer,
  resolveAnswerScriptMappingToken,
} from './machineReadableMappingService.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../../utils/auditLogger.js';
import { logError } from '../../utils/logger.js';

// The Part P "job" this phase actually runs — a fire-and-forget async
// function kicked off after the upload HTTP response is already sent (see
// routes/answerScripts.js), not a real queue (see
// docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md Part 8 for why). Every
// stage updates AnswerScript.processingMeta/status so the frontend can
// poll real progress, never a fabricated percentage.

const toDataUri = (buffer, mimeType = 'image/jpeg') => `data:${mimeType};base64,${buffer.toString('base64')}`;

const setStage = async (script, stage, extra = {}) => {
  script.processingMeta = { ...script.processingMeta, stage, ...extra };
  await script.save();
};

export const processAnswerScript = async (answerScriptId, { actorUserId } = {}) => {
  const script = await AnswerScript.findById(answerScriptId);
  if (!script) return;

  try {
    script.status = 'PROCESSING';
    script.processingMeta = { ...script.processingMeta, startedAt: new Date(), lastError: '' };
    await script.save();

    // --- Stage 1: page splitting ---
    await setStage(script, 'SPLITTING_PAGES');
    const sourceBuffer = await getPrivateObjectBuffer({ key: script.sourceFile.key });
    if (!sourceBuffer) throw Object.assign(new Error('The uploaded source file could not be read from storage.'), { code: 'SOURCE_UNREADABLE' });

    const pageResults = await splitIntoPages({ buffer: sourceBuffer, mimeType: script.mimeType, tenantId: script.tenantId, answerScriptId: script._id });
    if (!pageResults.length) throw Object.assign(new Error('No pages could be extracted from the uploaded file.'), { code: 'NO_PAGES' });
    if (pageResults.length > 60) throw Object.assign(new Error(`This script has ${pageResults.length} pages, above the configured limit.`), { code: 'TOO_MANY_PAGES' });

    const pages = [];
    for (const result of pageResults) {
      const page = await AnswerScriptPage.create({
        tenantId: script.tenantId,
        answerScriptId: script._id,
        pageNumber: result.pageNumber,
        image: result.key ? { key: result.key } : {},
        status: result.key ? 'PROCESSED' : 'FAILED',
        qualityStatus: result.qualityStatus || 'UNREADABLE',
        qualityMeta: { isLikelyBlank: result.isLikelyBlank, widthPx: result.widthPx, heightPx: result.heightPx, estimatedDpi: result.estimatedDpi, rotationDetectedDegrees: 0 },
        processingError: result.error || '',
      });
      pages.push(page);
    }
    script.pageCount = pages.length;
    await setStage(script, 'PAGES_SPLIT', { pagesTotal: pages.length, pagesProcessed: 0 });

    const firstUsablePage = pages.find((page) => ['GOOD', 'ACCEPTABLE'].includes(page.qualityStatus) && page.image?.key);
    const dataUriByPage = {};

    // --- Stage 2: identity extraction BEFORE answer OCR (hard gate) ---
    if (!script.candidateId && firstUsablePage) {
      await setStage(script, 'IDENTITY_EXTRACTION');
      const firstBuffer = await getPrivateObjectBuffer({ key: firstUsablePage.image.key });
      if (firstBuffer && !script.mappingTokenId) {
        const decodedToken = await decodeMappingTokenFromImageBuffer(firstBuffer);
        if (decodedToken) {
          const mapping = await resolveAnswerScriptMappingToken({ token: decodedToken, tenantId: script.tenantId });
          const scopeMatches = mapping
            && String(mapping.examId) === String(script.examId)
            && String(mapping.questionPaperId) === String(script.questionPaperId);
          const alreadyUsed = mapping
            ? await AnswerScript.exists({ _id: { $ne: script._id }, mappingTokenId: mapping._id })
            : null;
          if (!scopeMatches || alreadyUsed) {
            script.status = 'NEEDS_MAPPING';
            script.statusReason = alreadyUsed
              ? 'The detected QR mapping token is already linked to another answer script.'
              : 'The detected QR mapping token is invalid, expired, revoked, or belongs to another paper.';
            script.processingMeta.completedAt = new Date();
            await script.save();
            return;
          }
          script.mappingTokenId = mapping._id;
          script.examSessionId = mapping.sessionId || null;
          script.candidateId = mapping.candidateId || null;
          script.enrollmentId = mapping.enrollmentId || null;
          script.mappingMethod = 'QR';
          script.mappingConfidence = 1;
          await script.save();
        }
      }

      if (!script.candidateId) {
        const dataUri = toDataUri(firstBuffer, 'image/jpeg');
        dataUriByPage[firstUsablePage.pageNumber] = dataUri;
        const identifiers = await extractCandidateIdentifiers({ imageUrl: dataUri, tenantId: script.tenantId, userId: actorUserId });
        script.detectedRollNumber = identifiers.rollNumber || '';
        script.detectedCandidateName = identifiers.candidateName || '';
        script.identityExtract = {
          candidateName: identifiers.candidateName || '',
          rollNumber: identifiers.rollNumber || '',
          externalStudentId: identifiers.externalStudentId || '',
          confidence: identifiers.confidence ?? null,
          evidence: identifiers.evidence || '',
          provider: identifiers.provider || '',
          model: identifiers.model || '',
        };
        const autoMapped = await autoMapCandidate({
          tenantId: script.tenantId,
          examId: script.examId,
          detectedRollNumber: identifiers.rollNumber,
          detectedCandidateName: identifiers.candidateName,
          detectedExternalStudentId: identifiers.externalStudentId,
          originalFileName: script.originalFileName,
          identityConfidence: identifiers.confidence,
        });
        if (autoMapped) {
          const existingForCandidate = await assertNoDuplicateCandidateScript({
            tenantId: script.tenantId,
            examId: script.examId,
            candidateId: autoMapped.candidateId,
            excludeScriptId: script._id,
          });
          if (existingForCandidate) {
            script.status = 'NEEDS_MAPPING';
            script.statusReason = 'This candidate already has an answer script for this exam. Resolve the duplicate before continuing.';
            script.candidateSuggestions = await suggestCandidates({
              tenantId: script.tenantId,
              examId: script.examId,
              detectedRollNumber: identifiers.rollNumber,
              detectedCandidateName: identifiers.candidateName,
              detectedExternalStudentId: identifiers.externalStudentId,
              originalFileName: script.originalFileName,
            });
          } else {
            script.candidateId = autoMapped.candidateId;
            script.enrollmentId = autoMapped.enrollmentId || script.enrollmentId;
            script.mappingMethod = autoMapped.method;
            script.mappingConfidence = autoMapped.confidence;
            script.mappedAt = new Date();
            await logAuditEvent(AUDIT_ACTIONS.OFFLINE_CANDIDATE_AUTO_MAPPED, { userId: actorUserId, tenantId: script.tenantId, resourceType: 'AnswerScript', resourceId: script._id, examId: script.examId, candidateId: autoMapped.candidateId, confidence: autoMapped.confidence });
          }
        } else {
          script.candidateSuggestions = await suggestCandidates({
            tenantId: script.tenantId,
            examId: script.examId,
            detectedRollNumber: identifiers.rollNumber,
            detectedCandidateName: identifiers.candidateName,
            detectedExternalStudentId: identifiers.externalStudentId,
            originalFileName: script.originalFileName,
          });
        }
        await script.save();
      }
    }

    if (!script.candidateId) {
      script.status = 'NEEDS_MAPPING';
      script.statusReason = 'Candidate identity could not be confirmed automatically. Map this script to a candidate to continue.';
      script.processingMeta.completedAt = new Date();
      await script.save();
      return;
    }

    // --- Stage 3: OCR / vision extraction (usable pages only — Part F) ---
    await setStage(script, 'OCR_EXTRACTION');
    const pendingSegments = [];
    let machineTokenChecked = Boolean(script.mappingTokenId);

    for (const page of pages) {
      const usable = ['GOOD', 'ACCEPTABLE'].includes(page.qualityStatus) && page.image?.key;
      if (!usable) {
        script.processingMeta.pagesProcessed += 1;
        await script.save();
        continue;
      }
      const buffer = await getPrivateObjectBuffer({ key: page.image.key });
      if (!machineTokenChecked && !script.mappingTokenId) {
        machineTokenChecked = true;
      }
      const dataUri = toDataUri(buffer, 'image/jpeg');
      dataUriByPage[page.pageNumber] = dataUri;

      const extraction = await extractPageContent({ imageUrl: dataUri, tenantId: script.tenantId, userId: actorUserId, examId: script.examId, answerScriptId: script._id, pageNumber: page.pageNumber });
      page.extractionConfidence = extraction.pageConfidence ?? null;
      page.ocrText = (extraction.segments || []).map((segment) => segment.text).join('\n');
      page.visionMeta = { provider: extraction.available ? 'openai' : '', model: extraction.model || '' };
      if (extraction.error) page.processingError = extraction.error;
      await page.save();

      if (extraction.error) {
        await logAuditEvent(AUDIT_ACTIONS.OFFLINE_OCR_FAILED, { userId: actorUserId, tenantId: script.tenantId, resourceType: 'AnswerScriptPage', resourceId: page._id, examId: script.examId, error: extraction.error });
      } else {
        await logAuditEvent(AUDIT_ACTIONS.OFFLINE_OCR_COMPLETED, { userId: actorUserId, tenantId: script.tenantId, resourceType: 'AnswerScriptPage', resourceId: page._id, examId: script.examId, segmentCount: (extraction.segments || []).length });
      }

      for (const segment of extraction.segments || []) {
        if (segment.continuesFromPrevious && !segment.detectedQuestionNumber && pendingSegments.length) {
          const last = pendingSegments[pendingSegments.length - 1];
          last.text += `\n${segment.text}`;
          last.pageIds.push(page._id);
          last.confidence = Math.min(last.confidence, segment.confidence);
        } else if (segment.text) {
          pendingSegments.push({ detectedQuestionNumber: segment.detectedQuestionNumber, text: segment.text, confidence: segment.confidence, pageIds: [page._id] });
        }
      }
      script.processingMeta.pagesProcessed += 1;
      await script.save();
    }

    const segmentDocs = [];
    for (const pending of pendingSegments) {
      const segment = await AnswerSegment.create({
        tenantId: script.tenantId,
        answerScriptId: script._id,
        pageIds: pending.pageIds,
        detectedQuestionNumber: pending.detectedQuestionNumber || '',
        extractedText: pending.text,
        extractionConfidence: pending.confidence,
      });
      segmentDocs.push(segment);
    }
    script.processingMeta.segmentsExtracted = segmentDocs.length;
    await script.save();

    // --- Stage 4: question mapping (Part H) ---
    await setStage(script, 'QUESTION_MAPPING');
    const sequence = await buildExpectedQuestionSequence({ questionPaperId: script.questionPaperId, tenantId: script.tenantId });
    let anyNeedsReview = false;
    for (const segment of segmentDocs) {
      const mapping = mapSegmentToQuestion({ detectedQuestionNumber: segment.detectedQuestionNumber, extractionConfidence: segment.extractionConfidence, sequence });
      segment.questionId = mapping.questionId;
      segment.responseType = mapping.questionType || '';
      segment.mappingConfidence = mapping.mappingConfidence;
      segment.mappingStatus = mapping.mappingStatus;
      if (mapping.mappingStatus === 'NEEDS_REVIEW') anyNeedsReview = true;
      await segment.save();
    }
    script.processingMeta.segmentsMapped = segmentDocs.filter((s) => s.mappingStatus === 'AUTO_MAPPED').length;
    await script.save();

    // --- Stage 5: evaluation router (Part I/J) ---
    await setStage(script, 'EVALUATING');
    for (const segment of segmentDocs) {
      if (segment.mappingStatus !== 'AUTO_MAPPED' || !segment.questionId) continue;
      const question = await Question.findById(segment.questionId).lean();
      if (!question) continue;
      const firstPageNumber = pages.find((p) => segment.pageIds.some((id) => String(id) === String(p._id)))?.pageNumber;
      const result = await routeAndEvaluate({
        question,
        extractedText: segment.extractedText,
        extractionConfidence: segment.extractionConfidence,
        mappingConfidence: segment.mappingConfidence,
        pageImageUrl: firstPageNumber ? dataUriByPage[firstPageNumber] : undefined,
        tenantId: script.tenantId,
        userId: actorUserId,
        examId: script.examId,
        answerScriptId: script._id,
      });
      segment.evaluationResult = result;
      segment.evaluationStatus = 'EVALUATED';
      if (result.needsReview) anyNeedsReview = true;
      await segment.save();
      if (result.evaluationMethod === 'AI_SEMANTIC' || result.evaluationMethod === 'AI_VISION_RUBRIC') {
        await logAuditEvent(AUDIT_ACTIONS.OFFLINE_AI_EVALUATION_EXECUTED, { userId: actorUserId, tenantId: script.tenantId, resourceType: 'AnswerSegment', resourceId: segment._id, examId: script.examId, questionId: segment.questionId, method: result.evaluationMethod, confidence: result.confidence });
      }
    }

    // --- Stage 6: materialize into the existing Answer/ExamAttempt contract ---
    await setStage(script, 'MATERIALIZING');
    await materializeFromScript({ answerScriptId: script._id, actorUserId });

    script.status = anyNeedsReview ? 'NEEDS_REVIEW' : 'EVALUATED';
    script.processingMeta.completedAt = new Date();
    await script.save();
  } catch (error) {
    logError(error, { context: 'answerScriptIngestionService.processAnswerScript', answerScriptId });
    const failed = await AnswerScript.findById(answerScriptId);
    if (failed) {
      failed.status = 'FAILED';
      failed.statusReason = error.message || 'Processing failed.';
      failed.processingMeta = { ...failed.processingMeta, lastError: error.message, completedAt: new Date() };
      await failed.save();
    }
  }
};
