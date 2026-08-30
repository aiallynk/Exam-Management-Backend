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
import { formatRubricRowsForAppendix } from './rubricScoreNormalization.js';

const PAGE = { width: 595.28, height: 841.89, margin: 46 };
const COLORS = {
  correct: rgb(0.06, 0.52, 0.27),
  incorrect: rgb(0.78, 0.11, 0.11),
  partial: rgb(0.82, 0.45, 0.04),
  score: rgb(0.12, 0.16, 0.24),
  remark: rgb(0.28, 0.22, 0.18),
  underline: rgb(0.72, 0.16, 0.16),
  highlightIncorrect: rgb(1, 0.86, 0.86),
  highlightPartial: rgb(1, 0.94, 0.82),
};

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
  if (answer.moderatorReviewedAt) return answer.moderatorFeedback || '';
  if (answer.examinerReviewedAt) return answer.examinerFeedback || '';
  return answer.aiEvaluation?.feedback || '';
};

const formatAppendixTotal = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return Number.isInteger(numeric) ? String(numeric) : String(Math.round(numeric * 100) / 100);
};

export const buildDerivativeReviewRows = (answers = []) => answers.map((answer) => {
  const rubric = formatRubricRowsForAppendix(answer, answer.questionId?.evaluationConfig?.rubric || []);
  return {
    questionNumber: Number(answer.questionId?.order ?? 0) + 1,
    questionText: answer.questionId?.questionText || '',
    marksObtained: Number(answer.pointsEarned || 0),
    maxMarks: Number(answer.questionId?.points || 0),
    comment: finalComment(answer),
    rubricAvailable: rubric.available,
    rubric: rubric.rows,
    hasRubricConfig: Array.isArray(answer.questionId?.evaluationConfig?.rubric) && answer.questionId.evaluationConfig.rubric.length > 0,
    finalStatus: answer.evaluationStatus || 'NOT_EVALUATED',
    scoreSource: answer.finalScoreSource || '',
    examinerOverride: Boolean(answer.examinerReviewedAt || answer.moderatorReviewedAt),
  };
});

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

const drawCheck = (page, x, y, size, color) => {
  page.drawLine({
    start: { x, y: y + size * 0.42 },
    end: { x: x + size * 0.34, y },
    thickness: 1.7,
    color,
  });
  page.drawLine({
    start: { x: x + size * 0.34, y },
    end: { x: x + size, y: y + size * 0.82 },
    thickness: 1.7,
    color,
  });
};

const drawCross = (page, x, y, size, color) => {
  page.drawLine({
    start: { x, y },
    end: { x: x + size, y: y + size },
    thickness: 1.6,
    color,
  });
  page.drawLine({
    start: { x: x + size, y },
    end: { x, y: y + size },
    thickness: 1.6,
    color,
  });
};

const drawTeacherMark = ({ page, frame, mark, regular, bold }) => {
  const box = toPdfRect(frame, mark.placement);
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const symbolSize = 14;
  const symbolY = box.y + box.height - 18;
  const verdictColor = mark.verdict === 'INCORRECT' ? COLORS.incorrect : COLORS.correct;
  if (mark.verdict === 'INCORRECT') drawCross(page, box.x, symbolY, symbolSize, verdictColor);
  else drawCheck(page, box.x, symbolY, symbolSize, verdictColor);

  const showQuestion = mark.placement.strategy === 'SAFE_MARGIN' || mark.placement.confidence === 'LOW';
  const label = showQuestion ? `Q${mark.questionNumber}  ${mark.scoreLabel}` : mark.scoreLabel;
  page.drawText(label, {
    x: box.x + 18,
    y: symbolY + 1,
    size: 14,
    font: bold,
    color: mark.verdict === 'INCORRECT' ? COLORS.incorrect : COLORS.score,
  });

  if (mark.remark) {
    wrap(regular, mark.remark, 8.5, Math.max(56, box.width - 6)).slice(0, 2).forEach((line, index) => {
      page.drawText(line, {
        x: box.x + 18,
        y: symbolY - 13 - (index * 10),
        size: 8.5,
        font: regular,
        color: COLORS.remark,
      });
    });
  }
};

const evidenceStyle = (type) => {
  const normalized = String(type || '').toUpperCase();
  if (normalized === 'CORRECT') return { color: COLORS.correct, highlight: null, underline: true };
  if (normalized === 'PARTIAL') return { color: COLORS.partial, highlight: COLORS.highlightPartial, underline: true };
  if (normalized === 'MISSING_POINT') return { color: COLORS.remark, highlight: null, underline: false, marginOnly: true };
  return { color: COLORS.incorrect, highlight: COLORS.highlightIncorrect, underline: true };
};

const drawEvidenceAnnotation = ({ page, frame, annotation, regular }) => {
  const box = toPdfRect(frame, annotation.region);
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const style = evidenceStyle(annotation.type);
  if (style.highlight && box.width > 8 && box.height > 4) {
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      color: style.highlight,
      opacity: 0.35,
      borderWidth: 0,
    });
  }
  if (style.underline) {
    page.drawLine({
      start: { x: box.x, y: box.y - 0.8 },
      end: { x: box.x + box.width, y: box.y - 0.8 },
      thickness: style.marginOnly ? 0 : 1.1,
      color: style.color,
    });
  }
  const note = annotation.message || annotation.suggestedCorrection || annotation.evidenceText;
  if (note && (style.marginOnly || box.width < 48)) {
    wrap(regular, note, 7.5, Math.max(72, box.width + 40)).slice(0, 2).forEach((line, index) => {
      page.drawText(line, {
        x: Math.min(frame.x + frame.width - 120, box.x + box.width + 4),
        y: box.y + box.height - (index * 9),
        size: 7.5,
        font: regular,
        color: style.color,
      });
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
  attemptTotal = null,
}) => {
  const plan = buildTeacherAnnotationPlan({
    answers,
    segments,
    annotations,
    pageNumberById,
    attemptTotal,
  });
  assertDerivativeIntegrity(plan, { answers, attemptTotal });

  const pdf = await PDFDocument.create();
  const frames = await appendOriginal({ pdf, sourceBuffer, mimeType });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sourcePages = pdf.getPages();

  plan.marks.forEach((mark) => {
    const index = Math.max(0, Number(mark.pageNumber) - 1);
    const page = sourcePages[index] || sourcePages[sourcePages.length - 1];
    const frame = frames[index] || frames[frames.length - 1];
    if (page && frame) drawTeacherMark({ page, frame, mark, regular, bold });
  });

  plan.corrections.forEach((correction) => {
    const index = Math.max(0, Number(correction.pageNumber) - 1);
    const page = sourcePages[index];
    const frame = frames[index];
    if (page && frame) drawEvidenceAnnotation({ page, frame, annotation: correction, regular });
  });

  (plan.evidence || []).forEach((annotation) => {
    if (['SPELLING', 'GRAMMAR'].includes(annotation.type)) return;
    const index = Math.max(0, Number(annotation.pageNumber) - 1);
    const page = sourcePages[index];
    const frame = frames[index];
    if (page && frame) drawEvidenceAnnotation({ page, frame, annotation, regular });
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
      paragraph(`Evaluator comment: ${row.comment}`, { size: 9 });
    }
    if (row.rubricAvailable) {
      row.rubric.forEach((criterion) => paragraph(
        `Rubric - ${criterion.criterion}: ${criterion.marks}${criterion.maxMarks ? ` / ${criterion.maxMarks}` : ''}${criterion.comment ? ` - ${criterion.comment}` : ''}`,
        { size: 8, indent: 10 },
      ));
    } else if (row.hasRubricConfig) {
      paragraph('Rubric breakdown unavailable', { size: 8, indent: 10 });
    }
    paragraph(`Final evaluator status: ${row.finalStatus}${row.scoreSource ? ` (${row.scoreSource})` : ''}`, { size: 8 });
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
    AnswerScriptPage.find({ answerScriptId: script._id }).select('_id pageNumber').lean(),
    AnswerSegment.find({ answerScriptId: script._id })
      .select('_id materializedAnswerId questionId pageIds boundingRegion lineBoxes')
      .lean(),
    AnswerAnnotation.find({ answerScriptId: script._id, status: { $in: ['APPROVED', 'EDITED'] } }).lean(),
  ]);
  if (!sourceBuffer) throw new Error('Original answer script is unavailable in private storage.');
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
