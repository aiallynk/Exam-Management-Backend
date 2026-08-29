import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  buildDerivativeReviewRows,
  buildEvaluatedDerivativePdf,
} from '../services/offlineEvaluation/evaluatedDerivativeService.js';

const originalPdf = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  return Buffer.from(await pdf.save());
};

describe('evaluated AnswerScript derivative', () => {
  test('uses final evaluator values and never resurrects removed AI feedback', () => {
    const [row] = buildDerivativeReviewRows([{
      pointsEarned: 4,
      examinerReviewedAt: new Date(),
      examinerFeedback: '',
      aiEvaluation: { feedback: 'obsolete AI remark' },
      evaluationStatus: 'REVIEWED',
      finalScoreSource: 'EXAMINER',
      rubricEvaluation: { finalScores: [{ criterion: 'Accuracy', marks: 4, maxMarks: 5, comment: 'Final criterion note' }] },
      questionId: { order: 0, questionText: 'Explain the process.', points: 5 },
    }]);
    assert.equal(row.comment, '');
    assert.equal(row.marksObtained, 4);
    assert.equal(row.rubric[0].comment, 'Final criterion note');
    assert.equal(row.finalStatus, 'REVIEWED');
  });

  test('keeps the original page and appends a structured review page', async () => {
    const source = await originalPdf();
    const sourceDigest = Buffer.from(source);
    const derivative = await buildEvaluatedDerivativePdf({
      sourceBuffer: source,
      mimeType: 'application/pdf',
      candidate: { name: 'Candidate One' },
      exam: { title: 'Science Assessment' },
      script: {
        originalFileName: 'science.pdf',
        status: 'FINALIZED',
        evaluationSummary: { totalScore: 4, maxScore: 5 },
      },
      answers: [{
        pointsEarned: 4,
        examinerReviewedAt: new Date(),
        examinerFeedback: 'Clear scientific reasoning.',
        evaluationStatus: 'FINALIZED',
        finalScoreSource: 'EXAMINER',
        questionId: { order: 0, questionText: 'Explain photosynthesis.', points: 5 },
      }],
    });
    assert.deepEqual(source, sourceDigest, 'source buffer must remain unchanged');
    const parsed = await PDFDocument.load(derivative);
    assert.equal(parsed.getPageCount(), 2);
    assert.ok(derivative.length > source.length);
  });
});
