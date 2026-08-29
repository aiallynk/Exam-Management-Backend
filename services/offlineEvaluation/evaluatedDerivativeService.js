import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import Answer from '../../models/Answer.js';
import AnswerScript from '../../models/AnswerScript.js';
import Exam from '../../models/Exam.js';
import User from '../../models/User.js';
import { getPrivateObjectBuffer, putPrivateObject } from '../storage/imageStorage.js';

const PAGE = { width: 595.28, height: 841.89, margin: 46 };
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

export const buildDerivativeReviewRows = (answers = []) => answers.map((answer) => ({
  questionNumber: Number(answer.questionId?.order ?? 0) + 1,
  questionText: answer.questionId?.questionText || '',
  marksObtained: Number(answer.pointsEarned || 0),
  maxMarks: Number(answer.questionId?.points || 0),
  comment: finalComment(answer),
  rubric: Array.isArray(answer.rubricEvaluation?.finalScores)
    ? answer.rubricEvaluation.finalScores.map((item) => ({
      criterion: item?.criterion || item?.label || item?.key || 'Criterion',
      marks: Number(item?.marks ?? item?.score ?? 0),
      maxMarks: Number(item?.maxMarks ?? 0),
      comment: item?.comment || item?.feedback || '',
    }))
    : [],
  finalStatus: answer.evaluationStatus || 'NOT_EVALUATED',
  scoreSource: answer.finalScoreSource || '',
}));

const appendOriginal = async ({ pdf, sourceBuffer, mimeType }) => {
  if (mimeType === 'application/pdf') {
    const sourcePdf = await PDFDocument.load(sourceBuffer);
    const copied = await pdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
    copied.forEach((page) => pdf.addPage(page));
    return;
  }
  const image = mimeType === 'image/png'
    ? await pdf.embedPng(sourceBuffer)
    : await pdf.embedJpg(sourceBuffer);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const scale = Math.min(
    (PAGE.width - PAGE.margin * 2) / image.width,
    (PAGE.height - PAGE.margin * 2) / image.height,
  );
  page.drawImage(image, {
    x: (PAGE.width - image.width * scale) / 2,
    y: (PAGE.height - image.height * scale) / 2,
    width: image.width * scale,
    height: image.height * scale,
  });
};

export const buildEvaluatedDerivativePdf = async ({ sourceBuffer, mimeType, candidate, exam, script, answers }) => {
  const pdf = await PDFDocument.create();
  await appendOriginal({ pdf, sourceBuffer, mimeType });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const rows = buildDerivativeReviewRows(answers);

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
  line('Total', `${script.evaluationSummary?.totalScore ?? 0} / ${script.evaluationSummary?.maxScore ?? 0}`);
  line('Final status', script.status === 'FINALIZED' ? 'FINALIZED' : 'READY FOR FINALIZATION');
  y -= 8;
  paragraph('The original pages above are unchanged. Because reliable mark coordinates were not available for every response, final scores and comments are presented in this structured appendix rather than placed at guessed positions.');
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
    row.rubric.forEach((criterion) => paragraph(
      `Rubric - ${criterion.criterion}: ${criterion.marks}${criterion.maxMarks ? ` / ${criterion.maxMarks}` : ''}${criterion.comment ? ` - ${criterion.comment}` : ''}`,
      { size: 8, indent: 10 },
    ));
    paragraph(`Final evaluator status: ${row.finalStatus}${row.scoreSource ? ` (${row.scoreSource})` : ''}`, { size: 8 });
    y -= 10;
  });

  return Buffer.from(await pdf.save());
};

export const generateEvaluatedDerivative = async ({ answerScriptId, actorUserId, scriptDocument = null }) => {
  const script = scriptDocument || await AnswerScript.findById(answerScriptId);
  if (!script) throw new Error('Answer script not found.');
  if (!script.materializedAttemptId) throw new Error('Answer script has not been materialized into an attempt.');
  const [sourceBuffer, exam, candidate, answers] = await Promise.all([
    getPrivateObjectBuffer({ key: script.sourceFile.key }),
    Exam.findById(script.examId).select('title').lean(),
    User.findById(script.candidateId).select('name').lean(),
    Answer.find({ attemptId: script.materializedAttemptId })
      .populate('questionId', 'questionText points order')
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  if (!sourceBuffer) throw new Error('Original answer script is unavailable in private storage.');
  const pdfBuffer = await buildEvaluatedDerivativePdf({
    sourceBuffer,
    mimeType: script.mimeType,
    candidate,
    exam,
    script,
    answers,
  });
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
  script.evaluatedDerivative = {
    key: stored.key,
    checksum: crypto.createHash('sha256').update(pdfBuffer).digest('hex'),
    sizeBytes: pdfBuffer.length,
    mimeType: 'application/pdf',
    generatedAt,
    generatedBy: actorUserId || null,
    layoutMode: 'STRUCTURED_REVIEW_APPENDIX',
  };
  await script.save();
  return { script, pdfBuffer };
};
