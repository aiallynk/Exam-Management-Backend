import crypto from 'crypto';
import AnswerAnnotation from '../../models/AnswerAnnotation.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import { mapObservationsToAnnotations } from './evidenceAnnotationService.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value)));

export const ANSWER_ANNOTATION_TYPES = new Set([
  'CORRECT', 'INCORRECT', 'PARTIAL', 'SPELLING', 'GRAMMAR', 'MISSING_POINT',
  'EXTRA_POINT', 'RUBRIC_NOTE', 'COMMENT', 'SCORE', 'CHECK', 'CROSS',
  'HIGHLIGHT', 'UNDERLINE',
]);

// Provider terminology and the simple teacher toolbar intentionally meet at
// one persisted vocabulary. This preserves older CORRECT/INCORRECT records
// while accepting CHECK/TICK/CROSS proposals without a second overlay model.
export const normalizeAnnotationType = (value) => {
  const type = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['CHECK', 'TICK'].includes(type)) return 'CHECK';
  if (['CROSS', 'X_MARK'].includes(type)) return 'CROSS';
  return ANSWER_ANNOTATION_TYPES.has(type) ? type : null;
};

export const normalizeRegion = (region, fallback = null) => {
  const candidate = region && typeof region === 'object' ? region : fallback;
  if (!candidate) return null;
  const x = clamp(candidate.x, 0, 1);
  const y = clamp(candidate.y, 0, 1);
  const width = clamp(candidate.width, 0, 1 - x);
  const height = clamp(candidate.height, 0, 1 - y);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : null;
};

export const hasReliableRegion = (region) => Boolean(normalizeRegion(region));

const firstReliableLineBox = (segment) => (Array.isArray(segment?.lineBoxes) ? segment.lineBoxes : []).find((line) => hasReliableRegion(line));

const markerRegion = (segment, index = 0) => {
  const base = normalizeRegion(segment.boundingRegion) || normalizeRegion(firstReliableLineBox(segment));
  if (!base) return null;
  const width = Math.min(0.12, Math.max(0.065, base.width * 0.2));
  const height = Math.min(0.07, Math.max(0.04, base.height * 0.18));
  return normalizeRegion({
    x: base.x + base.width - width,
    y: Math.min(base.y + index * (height + 0.01), base.y + Math.max(0, base.height - height)),
    width,
    height,
  });
};

const annotationHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const buildCanonicalAnnotations = ({ segment, result, pageId }) => {
  if (!pageId) return [];
  const score = Number(result?.pointsEarned || 0);
  const maxScore = Number(result?.maxScore || result?.aiEvaluation?.maxScore || 0);
  const markerType = result?.isCorrect ? 'CORRECT' : score > 0 ? 'PARTIAL' : 'INCORRECT';
  const items = [{
    type: markerType,
    region: markerRegion(segment),
    message: String(result?.reason || result?.feedback || '').slice(0, 1000),
    proposedScore: score,
    confidence: result?.confidence,
  }, {
    type: 'SCORE',
    region: markerRegion(segment, 1),
    message: maxScore > 0 ? `${score} / ${maxScore}` : String(score),
    proposedScore: score,
    confidence: result?.confidence,
  }];

  const providerAnnotations = Array.isArray(result?.annotations)
    ? result.annotations
    : Array.isArray(result?.aiEvaluation?.annotations) ? result.aiEvaluation.annotations : [];
  for (const proposal of providerAnnotations) {
    const line = proposal.lineId
      ? (segment.lineBoxes || []).find((item) => item.id === proposal.lineId)
      : null;
    const region = normalizeRegion(proposal.region, line || segment.boundingRegion);
    if (!region) continue;
    const type = normalizeAnnotationType(proposal.type || 'COMMENT');
    if (!type) continue;
    items.push({
      type, region, lineId: String(proposal.lineId || ''),
      evidenceText: String(proposal.evidenceText || line?.text || '').slice(0, 500),
      message: String(proposal.message || '').slice(0, 1000),
      suggestedCorrection: String(proposal.suggestedCorrection || '').slice(0, 500),
      proposedScore: Number.isFinite(Number(proposal.proposedScore)) ? Number(proposal.proposedScore) : null,
      confidence: Number.isFinite(Number(proposal.confidence)) ? clamp(proposal.confidence, 0, 1) : result?.confidence,
    });
  }
  const missingConcepts = Array.isArray(result?.aiEvaluation?.missingConcepts) ? result.aiEvaluation.missingConcepts : [];
  missingConcepts.slice(0, 3).forEach((concept, index) => items.push({
    type: 'MISSING_POINT', region: markerRegion(segment, index + 2),
    message: `Missing concept: ${String(concept).slice(0, 300)}`,
    confidence: result?.confidence,
  }));
  const incorrectStatements = Array.isArray(result?.aiEvaluation?.incorrectStatements) ? result.aiEvaluation.incorrectStatements : [];
  incorrectStatements.slice(0, 3).forEach((statement, index) => items.push({
    type: 'INCORRECT', region: markerRegion(segment, index + 2 + missingConcepts.length),
    evidenceText: String(statement).slice(0, 500),
    message: 'This statement needs correction.', confidence: result?.confidence,
  }));
  if (String(result?.aiEvaluation?.grammarFeedback || '').trim()) items.push({
    type: 'GRAMMAR', region: markerRegion(segment, 2),
    message: String(result.aiEvaluation.grammarFeedback).slice(0, 1000), confidence: result?.confidence,
  });
  const evidenceItems = mapObservationsToAnnotations({ segment, result, pageId });
  evidenceItems.forEach((item) => {
    const duplicate = items.some((existing) => (
      existing.type === item.type
      && existing.message === item.message
      && JSON.stringify(existing.region) === JSON.stringify(item.region)
    ));
    if (!duplicate) items.push(item);
  });
  return items.filter((item) => item.region);
};

export const persistCanonicalAnnotations = async ({ segmentId }) => {
  const segment = await AnswerSegment.findById(segmentId);
  if (!segment?.evaluationResult || !segment.pageIds?.length) return [];
  const proposals = buildCanonicalAnnotations({
    segment,
    result: segment.evaluationResult,
    pageId: segment.pageIds[0],
  });
  const documents = [];
  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index];
    const idempotencyKey = annotationHash({
      segmentId: String(segment._id), index, type: proposal.type,
      result: segment.evaluationCheckpoint?.inputHash || segment.evaluationResult,
    });
    const document = await AnswerAnnotation.findOneAndUpdate(
      { tenantId: segment.tenantId, idempotencyKey },
      {
        $setOnInsert: {
          tenantId: segment.tenantId,
          answerScriptId: segment.answerScriptId,
          pageId: segment.pageIds[0],
          answerId: segment.materializedAnswerId || null,
          answerSegmentId: segment._id,
          questionId: segment.questionId || null,
          source: 'AI',
          // AI marks are suggestions. Only a scoped evaluator can approve
          // them for the evaluated paper, irrespective of AI confidence.
          status: 'PROPOSED',
          idempotencyKey,
          ...proposal,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    documents.push(document);
  }
  return documents;
};
