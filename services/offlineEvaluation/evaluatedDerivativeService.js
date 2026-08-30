import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import Answer from '../../models/Answer.js';
import AnswerScript from '../../models/AnswerScript.js';
import AnswerScriptPage from '../../models/AnswerScriptPage.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import AnswerAnnotation from '../../models/AnswerAnnotation.js';
import Exam from '../../models/Exam.js';
import ExamAttempt from '../../models/ExamAttempt.js';
import User from '../../models/User.js';
import { logError } from '../../utils/logger.js';
import { getPrivateObjectBuffer, putPrivateObject } from '../storage/imageStorage.js';
import {
  assertDerivativeIntegrity,
  buildTeacherAnnotationPlan,
} from './evaluatedAnnotationPlan.js';
import { buildQuestionAnswerMap } from './questionAnswerMapService.js';
import { formatRubricRowsForAppendix } from './rubricScoreNormalization.js';
import { isUnresolvedScore, resolveAuthoritativeScore } from './scoreResolutionService.js';

const PAGE = { width: 595.28, height: 841.89, margin: 46 };
const COLORS = {
  correct: rgb(0.06, 0.52, 0.27),
  incorrect: rgb(0.78, 0.11, 0.11),
  partial: rgb(0.82, 0.45, 0.04),
  score: rgb(0.12, 0.16, 0.24),
  remark: rgb(0.28, 0.22, 0.18),
  underline: rgb(0.72, 0.16, 0.16),
  leader: rgb(0.38, 0.42, 0.48),
  highlightIncorrect: rgb(1, 0.66, 0.7),
  highlightPartial: rgb(1, 0.82, 0.36),
  highlightCorrect: rgb(0.48, 0.82, 0.58),
  scoreCorrectFill: rgb(0.9, 0.98, 0.93),
  scoreIncorrectFill: rgb(1, 0.92, 0.92),
  scorePartialFill: rgb(1, 0.96, 0.86),
  commentFill: rgb(1, 0.98, 0.91),
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const printable = (value) => String(value ?? '')
  .replace(/[\r\t]+/g, ' ')
  .replace(/[^\x20-\x7E\n]/g, '?')
  .trim();

const wrap = (font, text, size, maxWidth) => {
  const words = printable(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

const finalComment = (answer) => {
  if (answer.moderatorReviewedAt) return { label: 'Evaluator Remark', text: answer.moderatorFeedback || '' };
  if (answer.examinerReviewedAt) return { label: 'Evaluator Remark', text: answer.examinerFeedback || '' };
  return { label: 'AI Feedback', text: answer.aiEvaluation?.feedback || '' };
};

const formatAppendixTotal = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return Number.isInteger(numeric) ? String(numeric) : String(Math.round(numeric * 100) / 100);
};

const formatAppendixReviewStatus = (row) => {
  if (row.scoreSource) return row.scoreSource;
  if (row.finalStatus === 'AI Evaluated' && !row.examinerOverride) return 'AI Evaluated — Review Pending';
  return row.finalStatus;
};

const reviewStatusLabel = (value) => ({
  NOT_ATTEMPTED: 'Not Attempted',
  NOT_EVALUATED: 'Pending',
  AUTO_EVALUATED: 'AI Evaluated',
  AI_EVALUATED: 'AI Evaluated',
  PENDING_REVIEW: 'Pending',
  UNDER_REVIEW: 'Pending',
  REVIEWED: 'Review Complete',
  FLAGGED: 'Flagged',
  MODERATED: 'Review Complete',
  FINALIZED: 'Finalized',
  EVALUATION_FAILED: 'Pending',
}[String(value || '').toUpperCase()] || 'Pending');

const scoreSourceLabel = (answer) => {
  const source = String(answer?.finalScoreSource || '').toUpperCase();
  if (source === 'RULE_ENGINE') return 'Final Score set by assessment rules';
  if (source === 'AI') return answer?.examinerReviewedAt || answer?.moderatorReviewedAt ? 'AI Score Approved' : 'AI Evaluated — Review Pending';
  if (['EXAMINER', 'MODERATOR', 'ADMIN_OVERRIDE'].includes(source)) return 'Evaluator Modified';
  return '';
};

export const buildDerivativeReviewRows = (answers = []) => answers.map((answer) => {
  const rubric = formatRubricRowsForAppendix(answer, answer.questionId?.evaluationConfig?.rubric || []);
  const comment = finalComment(answer);
  return {
    questionNumber: Number(answer.questionId?.order ?? 0) + 1,
    questionText: answer.questionId?.questionText || '',
    marksObtained: resolveAuthoritativeScore(answer),
    maxMarks: Number(answer.questionId?.points || 0),
    comment: comment.text,
    commentLabel: comment.label,
    rubricAvailable: rubric.available,
    rubric: rubric.rows,
    rubricReason: rubric.reason || '',
    hasRubricConfig: Array.isArray(answer.questionId?.evaluationConfig?.rubric) && answer.questionId.evaluationConfig.rubric.length > 0,
    finalStatus: reviewStatusLabel(answer.evaluationStatus),
    scoreSource: scoreSourceLabel(answer),
    examinerOverride: Boolean(answer.examinerReviewedAt || answer.moderatorReviewedAt),
  };
});

const detectedQuestionNumber = (value) => {
  const match = String(value || '').match(/(?:question\s*|q\s*)?(\d+)/i);
  return match ? Number(match[1]) : null;
};

// Blank responses do not always materialize an AnswerSegment. The page-level
// extraction record still owns the observed question-label geometry, so reuse
// it as a question anchor instead of fabricating a bottom-page score location.
export const buildQuestionAnchorsByQuestionNumber = (pages = []) => {
  const anchors = {};
  for (const page of pages) {
    for (const proposal of page?.extractionSegments || []) {
      const questionNumber = detectedQuestionNumber(proposal?.detectedQuestionNumber)
        || detectedQuestionNumber(proposal?.text);
      const region = proposal?.region || proposal?.boundingRegion;
      if (!questionNumber || !region || anchors[questionNumber]) continue;
      anchors[questionNumber] = { pageNumber: Number(page.pageNumber), region };
    }
  }
  return anchors;
};

const appendOriginal = async ({ pdf, sourceBuffer, mimeType }) => {
  const frames = [];
  if (mimeType === 'application/pdf') {
    const sourcePdf = await PDFDocument.load(sourceBuffer);
    const copied = await pdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
    copied.forEach((page) => {
      pdf.addPage(page);
      frames.push({
        x: 0,
        y: 0,
        width: page.getWidth(),
        height: page.getHeight(),
      });
    });
    return frames;
  }
  const image = mimeType === 'image/png'
    ? await pdf.embedPng(sourceBuffer)
    : await pdf.embedJpg(sourceBuffer);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const scale = Math.min(
    (PAGE.width - PAGE.margin * 2) / image.width,
    (PAGE.height - PAGE.margin * 2) / image.height,
  );
  const width = image.width * scale;
  const height = image.height * scale;
  const frame = {
    x: (PAGE.width - width) / 2,
    y: (PAGE.height - height) / 2,
    width,
    height,
  };
  page.drawImage(image, frame);
  frames.push(frame);
  return frames;
};

const toPdfRect = (frame, region) => ({
  x: frame.x + Number(region.x) * frame.width,
  y: frame.y + (1 - Number(region.y) - Number(region.height)) * frame.height,
  width: Number(region.width) * frame.width,
  height: Number(region.height) * frame.height,
});

const toPdfPoint = (frame, point) => ({
  x: frame.x + Number(point.x) * frame.width,
  y: frame.y + (1 - Number(point.y)) * frame.height,
});

// PDF coordinates may be A4-sized or the full dimensions of a scanned page.
// Coordinates were normalized already; every visible size must be normalized
// as well so Fit Page remains readable for either source.
export const pageRelativeMetrics = ({ page, frame }) => {
  const width = Math.max(Number(frame?.width) || 0, Number(page?.getWidth?.()) || 0, 1);
  const height = Math.max(Number(frame?.height) || 0, Number(page?.getHeight?.()) || 0, 1);
  return {
    scoreFontSize: clamp(width * 0.032, 18, Math.max(18, width * 0.042)),
    commentFontSize: clamp(width * 0.017, 9.5, Math.max(11, width * 0.024)),
    symbolSize: clamp(width * 0.045, 24, Math.max(28, width * 0.064)),
    scorePaddingX: clamp(width * 0.011, 7, Math.max(10, width * 0.018)),
    scorePaddingY: clamp(height * 0.009, 6, Math.max(9, height * 0.016)),
    markerBorder: clamp(width * 0.0028, 1.5, Math.max(2, width * 0.005)),
    annotationStroke: clamp(width * 0.003, 1.6, Math.max(2.2, width * 0.0055)),
    underlineOffset: clamp(height * 0.003, 1.5, Math.max(2.5, height * 0.006)),
    highlightPadX: clamp(width * 0.004, 2, Math.max(3, width * 0.009)),
    highlightPadY: clamp(height * 0.003, 1.5, Math.max(2.5, height * 0.007)),
    calloutPadding: clamp(width * 0.009, 5, Math.max(7, width * 0.015)),
    leaderStroke: clamp(width * 0.0018, 1, Math.max(1.4, width * 0.0035)),
  };
};

const clampPdfRectToFrame = (rect, frame) => {
  const x = clamp(rect.x, frame.x, frame.x + frame.width);
  const y = clamp(rect.y, frame.y, frame.y + frame.height);
  const right = clamp(rect.x + rect.width, frame.x, frame.x + frame.width);
  const top = clamp(rect.y + rect.height, frame.y, frame.y + frame.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, top - y) };
};

const expandPdfRect = (rect, frame, horizontal, vertical) => clampPdfRectToFrame({
  x: rect.x - horizontal,
  y: rect.y - vertical,
  width: rect.width + horizontal * 2,
  height: rect.height + vertical * 2,
}, frame);

const rectsOverlap = (left, right, gap = 0) => (
  left.x < right.x + right.width + gap
  && left.x + left.width + gap > right.x
  && left.y < right.y + right.height + gap
  && left.y + left.height + gap > right.y
);

const drawCheck = (page, x, y, size, color, thickness) => {
  page.drawLine({
    start: { x, y: y + size * 0.42 },
    end: { x: x + size * 0.34, y },
    thickness,
    color,
  });
  page.drawLine({
    start: { x: x + size * 0.34, y },
    end: { x: x + size, y: y + size * 0.82 },
    thickness,
    color,
  });
};

const drawCross = (page, x, y, size, color, thickness) => {
  page.drawLine({
    start: { x, y },
    end: { x: x + size, y: y + size },
    thickness,
    color,
  });
  page.drawLine({
    start: { x: x + size, y },
    end: { x, y: y + size },
    thickness,
    color,
  });
};

const drawTeacherMark = ({ page, frame, mark, regular, bold }) => {
  const box = toPdfRect(frame, mark.placement);
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const metrics = pageRelativeMetrics({ page, frame });
  const fill = mark.verdict === 'CORRECT'
    ? COLORS.scoreCorrectFill
    : mark.verdict === 'INCORRECT' ? COLORS.scoreIncorrectFill : COLORS.scorePartialFill;
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: fill,
    opacity: 0.92,
    borderColor: mark.verdict === 'INCORRECT' ? COLORS.incorrect : mark.verdict === 'CORRECT' ? COLORS.correct : COLORS.partial,
    borderWidth: metrics.markerBorder,
    borderOpacity: 0.85,
  });
  const symbolSize = Math.min(metrics.symbolSize, Math.max(metrics.scoreFontSize * 1.18, box.height * 0.58));
  const labelY = box.y + box.height - metrics.scorePaddingY - metrics.scoreFontSize;
  const symbolY = labelY + Math.max(0, (metrics.scoreFontSize - symbolSize) * 0.24);
  const verdictColor = mark.verdict === 'INCORRECT' ? COLORS.incorrect : COLORS.correct;
  const symbolX = box.x + metrics.scorePaddingX;
  if (mark.verdict === 'INCORRECT') drawCross(page, symbolX, symbolY, symbolSize, verdictColor, metrics.annotationStroke);
  else if (mark.verdict === 'CORRECT') drawCheck(page, symbolX, symbolY, symbolSize, verdictColor, metrics.annotationStroke);

  const label = mark.displayLabel || `Q${mark.questionNumber}  ${mark.scoreLabel}`;
  const labelX = box.x + metrics.scorePaddingX + (mark.verdict === 'PARTIAL' ? 0 : symbolSize + metrics.scorePaddingX * 0.75);
  page.drawText(label, {
    x: labelX,
    y: labelY,
    size: metrics.scoreFontSize,
    font: bold,
    color: mark.verdict === 'INCORRECT' ? COLORS.incorrect : COLORS.score,
  });

  if (mark.remark) {
    wrap(regular, mark.remark, metrics.commentFontSize, Math.max(56, box.width - metrics.scorePaddingX * 2)).slice(0, 2).forEach((line, index) => {
      page.drawText(line, {
        x: box.x + metrics.scorePaddingX,
        y: labelY - metrics.commentFontSize * 1.15 - (index * metrics.commentFontSize * 1.18),
        size: metrics.commentFontSize,
        font: regular,
        color: COLORS.remark,
      });
    });
  }

  if (mark.placement.strategy === 'SAFE_MARGIN' && mark.placement.leaderTo) {
    page.drawLine({
      start: { x: box.x, y: box.y + box.height * 0.5 },
      end: toPdfPoint(frame, mark.placement.leaderTo),
      thickness: metrics.leaderStroke,
      color: COLORS.leader,
      opacity: 0.8,
    });
  }
};

const evidenceStyle = (type, text = '') => {
  const normalized = String(type || '').toUpperCase();
  const semanticText = String(text || '').toLowerCase();
  const positive = /\b(good|correct|strong|clear|well done)\b/.test(semanticText);
  const negative = /\b(missing|incorrect|wrong|error|repeat|repeated|similar|confus)/.test(semanticText);
  if (normalized === 'CHECK') return { color: COLORS.correct, symbol: 'CHECK' };
  if (normalized === 'CROSS') return { color: COLORS.incorrect, symbol: 'CROSS' };
  if (normalized === 'HIGHLIGHT') return {
    color: positive ? COLORS.correct : negative ? COLORS.incorrect : COLORS.partial,
    highlight: positive ? COLORS.highlightCorrect : negative ? COLORS.highlightIncorrect : COLORS.highlightPartial,
  };
  if (normalized === 'UNDERLINE') return { color: positive ? COLORS.correct : negative ? COLORS.underline : COLORS.partial, underline: true };
  if (['COMMENT', 'MISSING_POINT', 'RUBRIC_NOTE'].includes(normalized)) return { color: COLORS.remark, comment: true };
  if (normalized === 'SPELLING' || normalized === 'GRAMMAR') return { color: COLORS.underline, underline: true };
  return null;
};

const drawCommentCallout = ({ page, frame, anchor, text, regular, metrics, reservedBoxes = [] }) => {
  const note = printable(text).slice(0, 110);
  if (!note) return;
  const maxWidth = Math.min(frame.width * 0.28, Math.max(frame.width * 0.16, 150));
  const lines = wrap(regular, note, metrics.commentFontSize, maxWidth - metrics.calloutPadding * 2).slice(0, 2);
  const width = Math.min(maxWidth, Math.max(
    frame.width * 0.15,
    ...lines.map((line) => regular.widthOfTextAtSize(line, metrics.commentFontSize) + metrics.calloutPadding * 2),
  ));
  const height = lines.length * metrics.commentFontSize * 1.22 + metrics.calloutPadding * 2;
  const candidates = [
    { x: anchor.x + anchor.width + metrics.calloutPadding, y: anchor.y + anchor.height - height },
    { x: anchor.x + anchor.width - width, y: anchor.y - height - metrics.calloutPadding },
    { x: anchor.x + anchor.width - width, y: anchor.y + anchor.height + metrics.calloutPadding },
    { x: anchor.x - width - metrics.calloutPadding, y: anchor.y + anchor.height - height },
  ].map((candidate) => clampPdfRectToFrame({ ...candidate, width, height }, frame));
  const callout = candidates.find((candidate) => (
    candidate.width >= width * 0.9
    && candidate.height >= height * 0.9
    && !reservedBoxes.some((reserved) => rectsOverlap(candidate, reserved, metrics.calloutPadding * 0.45))
  ));
  if (!callout) return;
  page.drawLine({
    start: { x: callout.x, y: callout.y + callout.height * 0.5 },
    end: { x: anchor.x + anchor.width, y: anchor.y + anchor.height * 0.5 },
    thickness: metrics.leaderStroke,
    color: COLORS.leader,
    opacity: 0.8,
  });
  page.drawRectangle({
    ...callout,
    color: COLORS.commentFill,
    opacity: 0.94,
    borderColor: COLORS.remark,
    borderWidth: metrics.markerBorder * 0.72,
    borderOpacity: 0.68,
  });
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: callout.x + metrics.calloutPadding,
      y: callout.y + callout.height - metrics.calloutPadding - metrics.commentFontSize - index * metrics.commentFontSize * 1.2,
      size: metrics.commentFontSize,
      font: regular,
      color: COLORS.remark,
    });
  });
};

const drawEvidenceAnnotation = ({ page, frame, annotation, regular, layer = 'stroke', reservedBoxes = [] }) => {
  const box = toPdfRect(frame, annotation.region);
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const note = annotation.message || annotation.suggestedCorrection || annotation.evidenceText;
  const style = evidenceStyle(annotation.type, note);
  if (!style) return;
  const metrics = pageRelativeMetrics({ page, frame });
  if (layer === 'comment') {
    if (style.comment) drawCommentCallout({ page, frame, anchor: box, text: note, regular, metrics, reservedBoxes });
    return;
  }
  if (style.comment) return;
  const expandedBox = expandPdfRect(box, frame, metrics.highlightPadX, metrics.highlightPadY);
  if (layer === 'highlight') {
    if (style.highlight && expandedBox.width > metrics.highlightPadX * 2 && expandedBox.height > metrics.highlightPadY * 2) {
      page.drawRectangle({ ...expandedBox, color: style.highlight, opacity: 0.32, borderWidth: 0 });
    }
    return;
  }
  if (style.symbol === 'CHECK') {
    const x = box.x + Math.min(metrics.highlightPadX, box.width * 0.16);
    const y = box.y + Math.max(metrics.highlightPadY, box.height * 0.42);
    const width = Math.max(metrics.symbolSize * 0.72, Math.min(metrics.symbolSize, box.width * 0.88));
    const height = Math.max(metrics.symbolSize * 0.58, Math.min(metrics.symbolSize * 0.78, box.height * 0.88));
    page.drawLine({ start: { x, y }, end: { x: x + width * 0.34, y: y - height * 0.42 }, thickness: metrics.annotationStroke, color: style.color });
    page.drawLine({ start: { x: x + width * 0.34, y: y - height * 0.42 }, end: { x: x + width, y: y + height * 0.44 }, thickness: metrics.annotationStroke, color: style.color });
  }
  if (style.symbol === 'CROSS') {
    const inset = Math.max(metrics.annotationStroke, Math.min(metrics.symbolSize * 0.16, Math.min(box.width, box.height) * 0.16));
    page.drawLine({ start: { x: box.x + inset, y: box.y + inset }, end: { x: box.x + box.width - inset, y: box.y + box.height - inset }, thickness: metrics.annotationStroke, color: style.color });
    page.drawLine({ start: { x: box.x + inset, y: box.y + box.height - inset }, end: { x: box.x + box.width - inset, y: box.y + inset }, thickness: metrics.annotationStroke, color: style.color });
  }
  if (style.underline) {
    const y = Math.max(frame.y, box.y - metrics.underlineOffset);
    page.drawLine({
      start: { x: box.x, y },
      end: { x: box.x + box.width, y },
      thickness: metrics.annotationStroke,
      color: style.color,
    });
  }
};

export const buildEvaluatedDerivativePdf = async ({
  sourceBuffer,
  mimeType,
  candidate,
  exam,
  script,
  answers,
  annotations = [],
  segments = [],
  pageNumberById = {},
  questionAnchorsByQuestionNumber = {},
  attemptTotal = null,
}) => {
  const questionAnswerMap = buildQuestionAnswerMap({
    answers,
    segments,
    pageNumberById,
    questionAnchorsByQuestionNumber,
  });
  const plan = buildTeacherAnnotationPlan({
    answers,
    segments,
    annotations,
    pageNumberById,
    questionAnchorsByQuestionNumber,
    attemptTotal,
  });
  assertDerivativeIntegrity(plan, { answers, attemptTotal, questionAnswerMap });

  const pdf = await PDFDocument.create();
  const frames = await appendOriginal({ pdf, sourceBuffer, mimeType });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sourcePages = pdf.getPages();

  // Z-order: transparent highlighter first, then pen strokes, then the final
  // score, then compact comments. Original page content remains the base.
  (plan.evidence || []).forEach((annotation) => {
    const index = Math.max(0, Number(annotation.pageNumber) - 1);
    const page = sourcePages[index];
    const frame = frames[index];
    if (page && frame) drawEvidenceAnnotation({ page, frame, annotation, regular, layer: 'highlight' });
  });

  (plan.evidence || []).forEach((annotation) => {
    const index = Math.max(0, Number(annotation.pageNumber) - 1);
    const page = sourcePages[index];
    const frame = frames[index];
    if (page && frame) drawEvidenceAnnotation({ page, frame, annotation, regular, layer: 'stroke' });
  });

  const scoreBoxesByPage = new Map();
  plan.marks.forEach((mark) => {
    const index = Math.max(0, Number(mark.pageNumber) - 1);
    const page = sourcePages[index] || sourcePages[sourcePages.length - 1];
    const frame = frames[index] || frames[frames.length - 1];
    if (page && frame) {
      drawTeacherMark({ page, frame, mark, regular, bold });
      const boxes = scoreBoxesByPage.get(index) || [];
      boxes.push(toPdfRect(frame, mark.placement));
      scoreBoxesByPage.set(index, boxes);
    }
  });

  (plan.evidence || []).forEach((annotation) => {
    const index = Math.max(0, Number(annotation.pageNumber) - 1);
    const page = sourcePages[index];
    const frame = frames[index];
    if (page && frame) drawEvidenceAnnotation({
      page,
      frame,
      annotation,
      regular,
      layer: 'comment',
      reservedBoxes: scoreBoxesByPage.get(index) || [],
    });
  });

  const rows = buildDerivativeReviewRows(answers);
  const displayedMax = plan.marks.reduce((sum, mark) => sum + Number(mark.maxMarks), 0);
  let page;
  let y;
  const newReviewPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.margin;
    page.drawText('XamiGo Evaluated Answer Script', { x: PAGE.margin, y, size: 17, font: bold, color: rgb(0.12, 0.24, 0.47) });
    y -= 28;
  };
  const ensure = (height = 20) => { if (!page || y - height < PAGE.margin) newReviewPage(); };
  const line = (label, value, { size = 10, gap = 15 } = {}) => {
    ensure(gap + 5);
    page.drawText(`${printable(label)}:`, { x: PAGE.margin, y, size, font: bold });
    page.drawText(printable(value), { x: PAGE.margin + 110, y, size, font: regular, maxWidth: PAGE.width - PAGE.margin * 2 - 110 });
    y -= gap;
  };
  const paragraph = (text, { size = 9, indent = 0, color = rgb(0.2, 0.24, 0.3) } = {}) => {
    const lines = wrap(regular, text, size, PAGE.width - PAGE.margin * 2 - indent);
    lines.forEach((entry) => {
      ensure(13);
      page.drawText(entry, { x: PAGE.margin + indent, y, size, font: regular, color });
      y -= 12;
    });
  };

  newReviewPage();
  line('Candidate', candidate?.name || 'Mapped candidate');
  line('Assessment', exam?.title || 'Assessment');
  line('Original file', script.originalFileName || 'Uploaded answer script');
  line('Total', `${formatAppendixTotal(plan.displayedTotal)} / ${formatAppendixTotal(displayedMax)}`);
  line('Final status', ['FINALIZED', 'COMPLETED'].includes(script.status) ? 'COMPLETED' : 'READY FOR FINALIZATION');
  y -= 8;
  paragraph(plan.marks.length
    ? 'The scanned pages above are the original answer sheet with teacher-style marks. The immutable original upload remains unchanged; this appendix records the same authoritative final marks and feedback for audit.'
    : 'The immutable original remains unchanged. Final marks and feedback are recorded in this structured appendix.');
  y -= 12;

  rows.forEach((row) => {
    ensure(90);
    page.drawRectangle({ x: PAGE.margin, y: y - 4, width: PAGE.width - PAGE.margin * 2, height: 1, color: rgb(0.82, 0.85, 0.9) });
    y -= 18;
    page.drawText(`Question ${row.questionNumber} - ${row.marksObtained} / ${row.maxMarks}`, { x: PAGE.margin, y, size: 11, font: bold });
    y -= 16;
    paragraph(row.questionText, { size: 9 });
    if (row.comment) {
      y -= 3;
      paragraph(`${row.commentLabel}: ${row.comment}`, { size: 9 });
    }
    if (row.rubricAvailable) {
      row.rubric.forEach((criterion) => paragraph(
        `Rubric - ${criterion.criterion}: ${criterion.marks}${criterion.maxMarks ? ` / ${criterion.maxMarks}` : ''}${criterion.comment ? ` - ${criterion.comment}` : ''}`,
        { size: 8, indent: 10 },
      ));
    } else if (row.hasRubricConfig) {
      paragraph(
        row.rubricReason === 'QUESTION_LEVEL_OVERRIDE'
          ? 'Rubric breakdown unavailable — Final Score was set by the evaluator.'
          : 'Rubric breakdown unavailable',
        { size: 8, indent: 10 },
      );
    }
    paragraph(`Review status: ${formatAppendixReviewStatus(row)}`, { size: 8 });
    y -= 10;
  });

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
};

export const generateEvaluatedDerivative = async ({ answerScriptId, actorUserId, scriptDocument = null }) => {
  const script = scriptDocument || await AnswerScript.findById(answerScriptId);
  if (!script) throw new Error('Answer script not found.');
  if (!script.materializedAttemptId) throw new Error('Answer script has not been materialized into an attempt.');
  const [sourceBuffer, exam, candidate, attempt, answers, pages, segments, annotations] = await Promise.all([
    getPrivateObjectBuffer({ key: script.normalizedObject?.key || script.sourceFile.key }),
    Exam.findById(script.examId).select('title').lean(),
    User.findById(script.candidateId).select('name').lean(),
    ExamAttempt.findById(script.materializedAttemptId).select('scoreSummary').lean(),
    Answer.find({ attemptId: script.materializedAttemptId })
      .populate('questionId', 'questionText points order evaluationConfig')
      .sort({ createdAt: 1 })
      .lean(),
    AnswerScriptPage.find({ answerScriptId: script._id }).select('_id pageNumber extractionSegments').lean(),
    AnswerSegment.find({ answerScriptId: script._id })
      .select('_id materializedAnswerId questionId pageIds boundingRegion lineBoxes')
      .lean(),
    AnswerAnnotation.find({ answerScriptId: script._id, status: { $in: ['APPROVED', 'EDITED'] } }).lean(),
  ]);
  if (!sourceBuffer) throw new Error('Original answer script is unavailable in private storage.');
  if (attempt?.scoreSummary?.isFinal === false || answers.some((answer) => isUnresolvedScore(answer) || resolveAuthoritativeScore(answer) === null)) {
    throw new Error('The evaluated paper cannot be rendered while any answer has only a proposed or failed evaluation score.');
  }
  const attemptTotal = Number.isFinite(Number(attempt?.scoreSummary?.totalScore))
    ? Number(attempt.scoreSummary.totalScore)
    : answers.reduce((sum, answer) => sum + Number(answer.pointsEarned || 0), 0);
  let pdfBuffer;
  try {
    pdfBuffer = await buildEvaluatedDerivativePdf({
      sourceBuffer,
      mimeType: script.normalizedObject?.key ? 'application/pdf' : script.mimeType,
      candidate,
      exam,
      script,
      answers,
      annotations,
      segments,
      pageNumberById: Object.fromEntries(pages.map((page) => [String(page._id), page.pageNumber])),
      questionAnchorsByQuestionNumber: buildQuestionAnchorsByQuestionNumber(pages),
      attemptTotal,
    });
  } catch (error) {
    logError(error, 'evaluatedDerivative.integrity');
    throw error;
  }
  const stored = await putPrivateObject({
    tenantId: script.tenantId,
    category: 'answer-scripts',
    subpath: ['evaluated-derivatives'],
    fileStem: `${script._id}-evaluated`,
    extension: '.pdf',
    buffer: pdfBuffer,
    contentType: 'application/pdf',
  });
  const generatedAt = new Date();
  const displayedMax = answers.reduce((sum, answer) => sum + Number(answer.questionId?.points || 0), 0);
  script.evaluatedDerivative = {
    key: stored.key,
    checksum: crypto.createHash('sha256').update(pdfBuffer).digest('hex'),
    sizeBytes: pdfBuffer.length,
    mimeType: 'application/pdf',
    generatedAt,
    generatedBy: actorUserId || null,
    layoutMode: answers.length ? 'GEOMETRY_ANNOTATED' : 'STRUCTURED_REVIEW_APPENDIX',
    status: 'READY',
  };
  script.evaluationSummary = {
    ...script.evaluationSummary,
    totalScore: attemptTotal,
    maxScore: displayedMax,
  };
  script.storageMetrics = { ...script.storageMetrics, annotatedBytes: pdfBuffer.length };
  await script.save();
  return { script, pdfBuffer };
};
