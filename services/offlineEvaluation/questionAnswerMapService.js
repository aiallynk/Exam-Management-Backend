import { normalizeRegion } from './answerAnnotationService.js';

const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const resolveSegment = (answer, segments = []) => {
  const sourceId = String(answer?.sourceAnswerSegmentId || '');
  if (sourceId) {
    const bySource = segments.find((segment) => String(segment._id) === sourceId);
    if (bySource) return bySource;
  }
  const answerId = String(answer?._id || '');
  if (answerId) {
    const byMaterialized = segments.find((segment) => String(segment.materializedAnswerId) === answerId);
    if (byMaterialized) return byMaterialized;
  }
  const questionId = String(answer?.questionId?._id || answer?.questionId || '');
  if (!questionId) return null;
  return segments.find((segment) => String(segment.questionId) === questionId) || null;
};

const pageNumbersForSegment = (segment, pageNumberById) => (
  (segment?.pageIds || [])
    .map((pageId) => Number(pageNumberById[String(pageId)] || 0))
    .filter((pageNumber) => pageNumber > 0)
);

const regionForLines = (lineBoxes = []) => {
  const regions = lineBoxes.map((line) => normalizeRegion(line)).filter(Boolean);
  if (!regions.length) return null;
  const left = Math.min(...regions.map((region) => region.x));
  const top = Math.min(...regions.map((region) => region.y));
  const right = Math.max(...regions.map((region) => region.x + region.width));
  const bottom = Math.max(...regions.map((region) => region.y + region.height));
  return normalizeRegion({ x: left, y: top, width: right - left, height: bottom - top });
};

const segmentEntries = (segment, pageNumberById) => {
  if (!segment) return [];
  const pages = pageNumbersForSegment(segment, pageNumberById);
  const entries = [];
  for (const pageId of segment.pageIds || []) {
    const pageNumber = Number(pageNumberById[String(pageId)] || 0);
    if (!pageNumber) continue;
    const region = normalizeRegion(segment.boundingRegion);
    if (region && (!pages.length || pages[0] === pageNumber)) {
      entries.push({
        pageId: String(pageId),
        pageNumber,
        region,
        text: segment.extractedText || segment.text || '',
        confidence: finite(segment.extractionConfidence ?? segment.mappingConfidence) ?? null,
        segmentId: String(segment._id),
      });
    }
    for (const line of segment.lineBoxes || []) {
      if (String(line?.pageId) !== String(pageId)) continue;
      const lineRegion = normalizeRegion(line);
      if (!lineRegion) continue;
      entries.push({
        pageId: String(pageId),
        pageNumber,
        region: lineRegion,
        text: line.text || '',
        confidence: finite(line.confidence) ?? null,
        segmentId: String(segment._id),
      });
    }
  }
  return entries;
};

const finalSegmentAnchor = (segments, pageNumberById) => {
  if (!segments.length) return null;
  const last = segments[segments.length - 1];
  const pages = pageNumbersForSegment(last, pageNumberById);
  const pageNumber = pages.length ? pages[pages.length - 1] : null;
  const finalPageLines = (last.lineBoxes || []).filter((line) => (
    Number(pageNumberById[String(line?.pageId)] || 0) === pageNumber
  ));
  const region = regionForLines(finalPageLines) || normalizeRegion(last.boundingRegion);
  return region ? { pageNumber, region } : null;
};

const primaryAnchor = (segments, questionAnchor) => {
  if (segments.length) {
    const first = segments[0];
    const region = normalizeRegion(first.boundingRegion) || regionForLines(first.lineBoxes || []);
    if (region) return { pageNumber: null, region };
  }
  if (questionAnchor?.region) {
    return {
      pageNumber: finite(questionAnchor.pageNumber),
      region: normalizeRegion(questionAnchor.region),
    };
  }
  return null;
};

/**
 * One authoritative question → answer map reused by evaluation, UI, and PDF rendering.
 */
export const buildQuestionAnswerMap = ({
  answers = [],
  segments = [],
  pageNumberById = {},
  questionAnchorsByQuestionNumber = {},
} = {}) => {
  const sorted = [...answers].sort((left, right) => (
    Number(left.questionId?.order ?? 0) - Number(right.questionId?.order ?? 0)
  ));

  return sorted.map((answer) => {
    const questionNumber = Number(answer.questionId?.order ?? 0) + 1;
    const segment = resolveSegment(answer, segments);
    const questionAnchor = questionAnchorsByQuestionNumber[questionNumber] || null;
    const segmentList = segment ? [segment] : [];
    const entries = segmentEntries(segment, pageNumberById);
    const mappingConfidence = finite(segment?.mappingConfidence ?? answer?.mappingConfidence) ?? (
      answer?.evaluationStatus === 'NOT_ATTEMPTED' ? 1 : 0.5
    );

    return {
      questionId: String(answer.questionId?._id || answer.questionId || questionNumber),
      questionNumber,
      answerId: String(answer._id || `question-${questionNumber}`),
      answerSegmentIds: segment ? [String(segment._id)] : [],
      segments: entries,
      primaryAnchor: primaryAnchor(segmentList, questionAnchor),
      finalSegmentAnchor: finalSegmentAnchor(segmentList, pageNumberById),
      mappingConfidence,
      maxMarks: Number(answer.questionId?.points || 0),
      finalScore: Number(answer.pointsEarned || 0),
      notAttempted: answer?.evaluationStatus === 'NOT_ATTEMPTED'
        || answer?.aiEvaluation?.notAttempted === true,
    };
  });
};

export default buildQuestionAnswerMap;
