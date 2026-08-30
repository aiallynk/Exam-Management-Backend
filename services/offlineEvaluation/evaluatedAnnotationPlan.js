import { normalizeRegion } from './answerAnnotationService.js';

const MARK_SIZE = { width: 0.18, height: 0.052 };
const MARK_SIZE_WITH_REMARK = { width: 0.2, height: 0.088 };
const GENERIC_REMARK = /^(this statement needs correction\.?|ai approved|approved by ai|needs review)$/i;
const SCORE_ONLY = /^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/;

export class EvaluatedDerivativeIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EvaluatedDerivativeIntegrityError';
    this.code = 'DERIVATIVE_INTEGRITY';
    this.details = details;
  }
}

export const sameMarks = (left, right) => Math.abs(Number(left) - Number(right)) < 0.001;

export const formatMarkNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return Number.isInteger(numeric) ? String(numeric) : String(Math.round(numeric * 100) / 100);
};

export const formatScoreLabel = (earned, max) => `${formatMarkNumber(earned)} / ${formatMarkNumber(max)}`;

export const classifyVerdict = (earned, max) => {
  const marks = Number(earned) || 0;
  const maximum = Number(max) || 0;
  if (marks <= 0) return 'INCORRECT';
  if (maximum > 0 && marks >= maximum) return 'CORRECT';
  return 'PARTIAL';
};

export const isWordLevelRegion = (region) => {
  const normalized = normalizeRegion(region);
  if (!normalized) return false;
  return normalized.height < 0.05 || (normalized.width < 0.25 && normalized.height < 0.09);
};

export const hasReliableAnswerRegion = (region) => {
  const normalized = normalizeRegion(region);
  return Boolean(normalized) && !isWordLevelRegion(normalized);
};

export const regionsOverlap = (left, right, padding = 0.008) => {
  if (!left || !right) return false;
  return left.x < right.x + right.width + padding
    && left.x + left.width + padding > right.x
    && left.y < right.y + right.height + padding
    && left.y + left.height + padding > right.y;
};

const fitsOnPage = (rect, occupied, padding = 0.008) => (
  rect.x >= 0.012
  && rect.y >= 0.018
  && rect.x + rect.width <= 0.988
  && rect.y + rect.height <= 0.982
  && !occupied.some((other) => regionsOverlap(rect, other, padding))
);

export const placeTeacherMark = ({
  answerRegion = null,
  occupiedRegions = [],
  existingPlacements = [],
  markSize = MARK_SIZE,
} = {}) => {
  const occupied = [...occupiedRegions, ...existingPlacements];
  const size = {
    width: Number(markSize.width) || MARK_SIZE.width,
    height: Number(markSize.height) || MARK_SIZE.height,
  };
  const reliable = hasReliableAnswerRegion(answerRegion);

  if (reliable) {
    const region = normalizeRegion(answerRegion);
    const right = {
      x: region.x + region.width + 0.012,
      y: region.y + 0.006,
      ...size,
    };
    if (fitsOnPage(right, occupied)) {
      return { ...right, confidence: 'HIGH', strategy: 'RIGHT_MARGIN' };
    }

    const clampedRight = {
      x: 0.988 - size.width,
      y: region.y + 0.006,
      ...size,
    };
    if (clampedRight.x >= region.x + region.width - 0.012 && fitsOnPage(clampedRight, occupied)) {
      return { ...clampedRight, confidence: 'HIGH', strategy: 'RIGHT_MARGIN' };
    }

    const below = {
      x: Math.min(0.988 - size.width, Math.max(0.012, region.x + region.width - size.width)),
      y: region.y + region.height + 0.01,
      ...size,
    };
    if (fitsOnPage(below, occupied)) {
      return { ...below, confidence: 'HIGH', strategy: 'BELOW_ANSWER' };
    }
  }

  for (let slot = 0; slot < 18; slot += 1) {
    const safe = {
      x: 0.832,
      y: 0.075 + slot * (size.height + 0.016),
      ...size,
    };
    if (fitsOnPage(safe, occupied)) {
      return { ...safe, confidence: reliable ? 'MEDIUM' : 'LOW', strategy: 'SAFE_MARGIN' };
    }
  }

  return {
    x: 0.832,
    y: Math.max(0.02, 0.96 - size.height),
    ...size,
    confidence: 'LOW',
    strategy: 'SAFE_MARGIN',
  };
};

const isApprovedForExport = (annotation) => {
  const status = String(annotation?.status || '').toUpperCase();
  return !status || status === 'APPROVED' || status === 'EDITED';
};

const isUsefulRemark = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length < 4 || text.length > 90) return false;
  if (GENERIC_REMARK.test(text) || SCORE_ONLY.test(text)) return false;
  return true;
};

const clipRemark = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);

const finalAnswerRemark = (answer) => {
  if (answer?.moderatorReviewedAt) return answer.moderatorFeedback || '';
  if (answer?.examinerReviewedAt) return answer.examinerFeedback || '';
  return '';
};

export const shortTeacherRemark = (answer, annotations = []) => {
  const fromAnswer = finalAnswerRemark(answer);
  if (isUsefulRemark(fromAnswer)) return clipRemark(fromAnswer);

  const answerId = String(answer?._id || '');
  const questionId = String(answer?.questionId?._id || answer?.questionId || '');
  const related = annotations.filter((annotation) => {
    if (!isApprovedForExport(annotation)) return false;
    const type = String(annotation.type || '').toUpperCase();
    if (!['COMMENT', 'MISSING_POINT', 'RUBRIC_NOTE'].includes(type)) return false;
    const annotationAnswerId = String(annotation.answerId || '');
    const annotationQuestionId = String(annotation.questionId?._id || annotation.questionId || '');
    return (answerId && annotationAnswerId === answerId)
      || (questionId && annotationQuestionId === questionId);
  });
  const useful = related.find((annotation) => isUsefulRemark(annotation.message));
  return useful ? clipRemark(useful.message) : '';
};

export const selectExportEvidenceAnnotations = (annotations = [], pageNumberById = {}) => (
  annotations
    .filter((annotation) => {
      if (!isApprovedForExport(annotation)) return false;
      const type = String(annotation.type || '').toUpperCase();
      if (!['CORRECT', 'INCORRECT', 'PARTIAL', 'MISSING_POINT', 'SPELLING', 'GRAMMAR', 'COMMENT'].includes(type)) return false;
      const region = normalizeRegion(annotation.region);
      if (!region) return false;
      if (['SPELLING', 'GRAMMAR'].includes(type) && (region.height > 0.08 || region.width > 0.72)) return false;
      return Boolean(annotation.message || annotation.suggestedCorrection || annotation.evidenceText);
    })
    .map((annotation) => ({
      type: String(annotation.type).toUpperCase(),
      region: normalizeRegion(annotation.region),
      pageNumber: Number(pageNumberById[String(annotation.pageId)] || 0),
      message: String(annotation.message || '').slice(0, 120),
      suggestedCorrection: String(annotation.suggestedCorrection || '').slice(0, 80),
      evidenceText: String(annotation.evidenceText || '').slice(0, 120),
    }))
    .filter((item) => item.pageNumber > 0)
);

export const selectExportCorrections = (annotations = [], pageNumberById = {}) => (
  selectExportEvidenceAnnotations(annotations, pageNumberById)
    .filter((item) => ['SPELLING', 'GRAMMAR'].includes(item.type))
);

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

const occupiedRegionsOnPage = ({ segments, pageNumber, pageNumberById, includeLineBoxes = true }) => {
  const occupied = [];
  for (const segment of segments) {
    const pages = pageNumbersForSegment(segment, pageNumberById);
    if (!pages.includes(pageNumber)) continue;
    if (!pages.length || pages[0] === pageNumber) {
      const region = normalizeRegion(segment.boundingRegion);
      if (region) occupied.push(region);
    }
    if (includeLineBoxes && pages[0] === pageNumber) {
      for (const line of segment.lineBoxes || []) {
        const region = normalizeRegion(line);
        if (region) occupied.push(region);
      }
    }
  }
  return occupied;
};

export const buildTeacherAnnotationPlan = ({
  answers = [],
  segments = [],
  annotations = [],
  pageNumberById = {},
  attemptTotal = null,
} = {}) => {
  const sorted = [...answers].sort((left, right) => (
    Number(left.questionId?.order ?? 0) - Number(right.questionId?.order ?? 0)
  ));
  const placementsByPage = new Map();
  const marks = sorted.map((answer) => {
    const questionNumber = Number(answer.questionId?.order ?? 0) + 1;
    const marksObtained = Number(answer.pointsEarned || 0);
    const maxMarks = Number(answer.questionId?.points || 0);
    const segment = resolveSegment(answer, segments);
    const pageNumbers = pageNumbersForSegment(segment, pageNumberById);
    const spansPages = pageNumbers.length > 1;
    const pageNumber = spansPages ? pageNumbers[pageNumbers.length - 1] : (pageNumbers[0] || 1);
    const answerRegion = !spansPages && hasReliableAnswerRegion(segment?.boundingRegion)
      ? normalizeRegion(segment.boundingRegion)
      : null;
    const remark = answer?.evaluationStatus === 'NOT_ATTEMPTED'
      ? 'Not attempted'
      : shortTeacherRemark(answer, annotations);
    const markSize = remark ? MARK_SIZE_WITH_REMARK : MARK_SIZE;
    const existingPlacements = placementsByPage.get(pageNumber) || [];
    const placement = placeTeacherMark({
      answerRegion,
      occupiedRegions: occupiedRegionsOnPage({ segments, pageNumber, pageNumberById }),
      existingPlacements,
      markSize,
    });
    placementsByPage.set(pageNumber, [...existingPlacements, placement]);
    return {
      answerId: answer._id ? String(answer._id) : `question-${questionNumber}`,
      questionId: String(answer.questionId?._id || answer.questionId || questionNumber),
      questionNumber,
      marksObtained,
      maxMarks,
      scoreLabel: formatScoreLabel(marksObtained, maxMarks),
      verdict: classifyVerdict(marksObtained, maxMarks),
      remark,
      pageNumber,
      spansPages,
      placement,
    };
  });

  return {
    marks,
    corrections: selectExportCorrections(annotations, pageNumberById),
    evidence: selectExportEvidenceAnnotations(annotations, pageNumberById),
    displayedTotal: marks.reduce((sum, mark) => sum + Number(mark.marksObtained), 0),
    attemptTotal: attemptTotal == null ? null : Number(attemptTotal),
  };
};

export const assertDerivativeIntegrity = (plan, { answers = [], attemptTotal = null } = {}) => {
  const expected = [...answers]
    .sort((left, right) => Number(left.questionId?.order ?? 0) - Number(right.questionId?.order ?? 0))
    .map((answer) => ({
      questionNumber: Number(answer.questionId?.order ?? 0) + 1,
      marksObtained: Number(answer.pointsEarned || 0),
      maxMarks: Number(answer.questionId?.points || 0),
    }));

  if (!plan || !Array.isArray(plan.marks)) {
    throw new EvaluatedDerivativeIntegrityError('Evaluated paper is missing a rendered-mark list.');
  }
  if (plan.marks.length !== expected.length) {
    throw new EvaluatedDerivativeIntegrityError(
      'Evaluated paper is missing or duplicating question marks.',
      { expected: expected.length, rendered: plan.marks.length },
    );
  }

  const seen = new Set();
  for (const mark of plan.marks) {
    if (seen.has(mark.questionNumber)) {
      throw new EvaluatedDerivativeIntegrityError(
        `Question ${mark.questionNumber} appears more than once on the evaluated paper.`,
        { questionNumber: mark.questionNumber },
      );
    }
    seen.add(mark.questionNumber);
    const authoritative = expected.find((item) => item.questionNumber === mark.questionNumber);
    if (!authoritative) {
      throw new EvaluatedDerivativeIntegrityError(
        `Rendered mark for question ${mark.questionNumber} has no authoritative answer.`,
        { questionNumber: mark.questionNumber },
      );
    }
    if (!sameMarks(mark.marksObtained, authoritative.marksObtained)
      || !sameMarks(mark.maxMarks, authoritative.maxMarks)
      || mark.scoreLabel !== formatScoreLabel(authoritative.marksObtained, authoritative.maxMarks)) {
      throw new EvaluatedDerivativeIntegrityError(
        `Rendered score for question ${mark.questionNumber} does not match the stored final score.`,
        {
          questionNumber: mark.questionNumber,
          rendered: mark.scoreLabel,
          stored: formatScoreLabel(authoritative.marksObtained, authoritative.maxMarks),
        },
      );
    }
  }

  for (const authoritative of expected) {
    if (!seen.has(authoritative.questionNumber)) {
      throw new EvaluatedDerivativeIntegrityError(
        `Question ${authoritative.questionNumber} is missing from the evaluated paper.`,
        { questionNumber: authoritative.questionNumber },
      );
    }
  }

  const displayedTotal = plan.marks.reduce((sum, mark) => sum + Number(mark.marksObtained), 0);
  const answerTotal = expected.reduce((sum, item) => sum + item.marksObtained, 0);
  if (!sameMarks(displayedTotal, answerTotal) || !sameMarks(plan.displayedTotal, answerTotal)) {
    throw new EvaluatedDerivativeIntegrityError(
      'Displayed question marks do not sum to the authoritative answer total.',
      { displayedTotal, answerTotal },
    );
  }

  const finalTotal = attemptTotal == null ? answerTotal : Number(attemptTotal);
  if (!sameMarks(displayedTotal, finalTotal)) {
    throw new EvaluatedDerivativeIntegrityError(
      'Displayed question marks do not match the final attempt total.',
      { displayedTotal, attemptTotal: finalTotal },
    );
  }

  return true;
};
