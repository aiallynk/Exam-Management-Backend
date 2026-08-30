import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { buildEvaluatedDerivativePdf, buildQuestionAnchorsByQuestionNumber, pageRelativeMetrics } from '../services/offlineEvaluation/evaluatedDerivativeService.js';
import { EvaluatedDerivativeIntegrityError } from '../services/offlineEvaluation/evaluatedAnnotationPlan.js';

const extractPdfText = (buffer) => {
  const raw = Buffer.from(buffer);
  const latin = raw.toString('latin1');
  const chunks = [];
  const pattern = /\/Length\s+(\d+)\s*>>\s*stream\r?\n/g;
  let match = pattern.exec(latin);
  while (match) {
    const start = match.index + match[0].length;
    const payload = raw.subarray(start, start + Number(match[1]));
    try {
      chunks.push(inflateSync(payload).toString('latin1'));
    } catch {
      chunks.push(payload.toString('latin1'));
    }
    match = pattern.exec(latin);
  }
  return chunks
    .flatMap((chunk) => [
      ...[...chunk.matchAll(/\((?:\\.|[^\\)])*\)/g)].map((item) => item[0].slice(1, -1).replace(/\\(.)/g, '$1')),
      ...[...chunk.matchAll(/<([0-9A-Fa-f]+)>/g)].map((item) => Buffer.from(item[1], 'hex').toString('latin1')),
    ])
    .join('\n');
};

const scriptMeta = {
  originalFileName: 'handwritten-answers.pdf',
  evaluationSummary: { totalScore: 15, maxScore: 25 },
  status: 'COMPLETED',
};

const buildHandwrittenSource = async ({ pages = 2 } = {}) => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const rules = [
    {
      heading: 'Class test — Science',
      lines: [
        'Q1. Explain photosynthesis.',
        '   Plants use sunlight, water and carbon dioxide',
        '   to make glucose and release oxygen.',
        'Q2. Name two products of photosynthesis.',
        '   Glucose and oxygen are produced.',
        'Q3. Why is chlorophyll important?',
        '   It absorbs light energy for the reaction.',
        '   The answer continues onto the next page...',
      ],
    },
    {
      heading: 'Class test — Science (continued)',
      lines: [
        '...so the leaf can capture sunlight.',
        'Q4. Write the word equation.',
        '   carbon + water -> sugar',
        'Q5. State one factor that affects the rate.',
        '   Light intensity affects the rate.',
      ],
    },
    {
      heading: 'Class test — Science (final page)',
      lines: [
        'Q6. Give one limitation.',
        '   The response is incomplete.',
        'Q7. Explain the final idea.',
        '   The answer continues from page two.',
        'Q8. State the final conclusion.',
        '   No response was written.',
      ],
    },
  ].slice(0, pages);

  rules.forEach((pageSpec) => {
    const page = source.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(0.99, 0.98, 0.95) });
    for (let y = 780; y > 60; y -= 22) {
      page.drawLine({ start: { x: 48, y }, end: { x: 547, y }, thickness: 0.4, color: rgb(0.72, 0.8, 0.9) });
    }
    page.drawText(pageSpec.heading, { x: 52, y: 800, size: 13, font, color: rgb(0.15, 0.18, 0.25) });
    pageSpec.lines.forEach((line, index) => {
      page.drawText(line, {
        x: 56,
        y: 750 - index * 36,
        size: 12,
        font,
        color: rgb(0.08, 0.12, 0.2),
      });
    });
  });
  return Buffer.from(await source.save());
};

const representativeAnswers = () => ([
  {
    _id: 'a1', sourceAnswerSegmentId: 's1',
    questionId: { _id: 'q1', order: 0, points: 5, questionText: 'Explain photosynthesis' },
    pointsEarned: 5, evaluationStatus: 'FINALIZED', finalScoreSource: 'AI',
  },
  {
    _id: 'a2', sourceAnswerSegmentId: 's2',
    questionId: { _id: 'q2', order: 1, points: 5, questionText: 'Name two products' },
    pointsEarned: 3, evaluationStatus: 'REVIEWED', finalScoreSource: 'EXAMINER',
    examinerReviewedAt: new Date('2026-08-30T10:00:00Z'),
    examinerFeedback: 'Missing one required point',
  },
  {
    _id: 'a3', sourceAnswerSegmentId: 's3',
    questionId: { _id: 'q3', order: 2, points: 5, questionText: 'Why is chlorophyll important?' },
    pointsEarned: 4, evaluationStatus: 'FINALIZED', finalScoreSource: 'AI',
  },
  {
    _id: 'a4', sourceAnswerSegmentId: 's4',
    questionId: { _id: 'q4', order: 3, points: 5, questionText: 'Write the word equation' },
    pointsEarned: 0, evaluationStatus: 'NOT_ATTEMPTED', finalScoreSource: 'AI',
    aiEvaluation: { notAttempted: true },
  },
  {
    _id: 'a5', sourceAnswerSegmentId: 's5',
    questionId: { _id: 'q5', order: 4, points: 5, questionText: 'State one factor' },
    pointsEarned: 3, evaluationStatus: 'FINALIZED', finalScoreSource: 'AI',
  },
]);

const representativeSegments = () => ([
  { _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.10, width: 0.68, height: 0.16 } },
  { _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.28, width: 0.68, height: 0.14 } },
  { _id: 's3', pageIds: ['p1', 'p2'], boundingRegion: { x: 0.08, y: 0.46, width: 0.70, height: 0.36 } },
  { _id: 's4', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.18, width: 0.68, height: 0.16 } },
  { _id: 's5', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.40, width: 0.68, height: 0.16 } },
]);

describe('evaluated derivative generation', () => {
  test('scales visible teacher marks with each source-page dimension', () => {
    const appendix = pageRelativeMetrics({
      page: { getWidth: () => 595.28, getHeight: () => 841.89 },
      frame: { width: 595.28, height: 841.89 },
    });
    const highResolutionScan = pageRelativeMetrics({
      page: { getWidth: () => 1795, getHeight: () => 2436 },
      frame: { width: 1795, height: 2436 },
    });
    assert.ok(appendix.scoreFontSize >= 18);
    assert.ok(highResolutionScan.scoreFontSize > appendix.scoreFontSize * 2.9);
    assert.ok(highResolutionScan.symbolSize > appendix.symbolSize * 2.9);
    assert.ok(highResolutionScan.annotationStroke > appendix.annotationStroke * 2.9);
  });

  test('reuses page extraction geometry as the local anchor for an unattempted question', () => {
    const anchors = buildQuestionAnchorsByQuestionNumber([{
      pageNumber: 2,
      extractionSegments: [{ detectedQuestionNumber: 'Q4', region: { x: 0.08, y: 0.42, width: 0.16, height: 0.035 } }],
    }]);
    assert.deepEqual(anchors[4], {
      pageNumber: 2,
      region: { x: 0.08, y: 0.42, width: 0.16, height: 0.035 },
    });
  });

  test('burns teacher marks onto a working copy and leaves source bytes unused as the original', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([400, 600]);
    const font = await source.embedFont(StandardFonts.Helvetica);
    page.drawText('Student handwritten answer', { x: 40, y: 500, size: 16, font });
    const sourceBuffer = Buffer.from(await source.save());
    const derivative = await buildEvaluatedDerivativePdf({
      sourceBuffer,
      mimeType: 'application/pdf',
      candidate: { name: 'Ravi' },
      exam: { title: 'Handwritten Subjective Evaluation Test' },
      script: { originalFileName: 'fixture.pdf', evaluationSummary: { totalScore: 4, maxScore: 5 }, status: 'COMPLETED' },
      answers: [{
        _id: 'a1',
        sourceAnswerSegmentId: 's1',
        questionId: { order: 0, questionText: 'Explain photosynthesis', points: 5 },
        pointsEarned: 4,
        aiEvaluation: { feedback: 'Long feedback stays in the appendix, not as a huge page stamp.', pointsEarned: 3.5 },
        evaluationStatus: 'FINALIZED',
        finalScoreSource: 'EXAMINER',
        examinerReviewedAt: new Date('2026-08-30T10:00:00Z'),
        examinerFeedback: 'Almost complete',
      }],
      segments: [{ _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.12, y: 0.16, width: 0.62, height: 0.22 } }],
      annotations: [{
        pageId: 'p1',
        type: 'SCORE',
        status: 'APPROVED',
        region: { x: 0.7, y: 0.1, width: 0.18, height: 0.06 },
        message: '3 / 5',
      }, {
        pageId: 'p1',
        type: 'SPELLING',
        status: 'APPROVED',
        region: { x: 0.2, y: 0.3, width: 0.18, height: 0.03 },
        message: 'environment',
      }, {
        pageId: 'p1',
        type: 'COMMENT',
        status: 'APPROVED',
        region: { x: 0, y: 0, width: 0, height: 0 },
        message: 'should not draw',
      }],
      pageNumberById: { p1: 1 },
      attemptTotal: 4,
    });
    assert.ok(derivative.length > sourceBuffer.length);
    const loaded = await PDFDocument.load(derivative);
    assert.ok(loaded.getPageCount() >= 2);
    const parsed = extractPdfText(derivative);
    assert.match(parsed, /4 \/ 5/);
    assert.doesNotMatch(parsed, /3 \/ 5/);
    assert.doesNotMatch(parsed, /AI Approved/);
  });

  test('representative script shows authoritative 5/5 3/5 4/5 0/5 3/5 and rejects a contradictory attempt total', async () => {
    const sourceBuffer = await buildHandwrittenSource({ pages: 2 });
    const answers = representativeAnswers();
    const derivative = await buildEvaluatedDerivativePdf({
      sourceBuffer,
      mimeType: 'application/pdf',
      candidate: { name: 'Asha' },
      exam: { title: 'Science class test' },
      script: scriptMeta,
      answers,
      segments: representativeSegments(),
      annotations: [{
        pageId: 'p1', type: 'SPELLING', status: 'PROPOSED',
        region: { x: 0.2, y: 0.3, width: 0.2, height: 0.03 }, message: 'enviroment',
      }, {
        pageId: 'p2', type: 'SCORE', status: 'APPROVED',
        region: { x: 0.78, y: 0.18, width: 0.16, height: 0.05 }, message: '5 / 5', proposedScore: 5,
      }],
      pageNumberById: { p1: 1, p2: 2 },
      attemptTotal: 15,
    });
    const parsed = extractPdfText(derivative);
    assert.match(parsed, /5 \/ 5/);
    assert.match(parsed, /3 \/ 5/);
    assert.match(parsed, /4 \/ 5/);
    assert.match(parsed, /0 \/ 5/);
    assert.match(parsed, /Not attempted/);
    assert.match(parsed, /15 \/ 25/);
    assert.doesNotMatch(parsed, /Edit Score|\bApprove\b|\bFlag\b|enviroment/);

    await assert.rejects(
      () => buildEvaluatedDerivativePdf({
        sourceBuffer,
        mimeType: 'application/pdf',
        candidate: { name: 'Asha' },
        exam: { title: 'Science class test' },
        script: scriptMeta,
        answers,
        segments: representativeSegments(),
        pageNumberById: { p1: 1, p2: 2 },
        attemptTotal: 10,
      }),
      (error) => error instanceof EvaluatedDerivativeIntegrityError && error.code === 'DERIVATIVE_INTEGRITY',
    );
  });

  test('three-page paper fixture retains its original pages and overlays final 0 scores plus manual pen marks', async () => {
    const sourceBuffer = await buildHandwrittenSource({ pages: 3 });
    const answers = [
      { _id: 'a1', sourceAnswerSegmentId: 's1', questionId: { order: 0, questionText: 'Q1', points: 5 }, pointsEarned: 5, evaluationStatus: 'FINALIZED' },
      { _id: 'a2', sourceAnswerSegmentId: 's2', questionId: { order: 1, questionText: 'Q2', points: 5 }, pointsEarned: 3, evaluationStatus: 'FINALIZED' },
      { _id: 'a3', sourceAnswerSegmentId: 's3', questionId: { order: 2, questionText: 'Q3', points: 5 }, pointsEarned: 3, evaluationStatus: 'FINALIZED' },
      { _id: 'a4', sourceAnswerSegmentId: 's4', questionId: { order: 3, questionText: 'Q4', points: 5 }, pointsEarned: 0, evaluationStatus: 'FINALIZED' },
      { _id: 'a5', sourceAnswerSegmentId: 's5', questionId: { order: 4, questionText: 'Q5', points: 5 }, pointsEarned: 4, evaluationStatus: 'FINALIZED' },
      { _id: 'a6', sourceAnswerSegmentId: 's6', questionId: { order: 5, questionText: 'Q6', points: 5 }, pointsEarned: 2, evaluationStatus: 'FINALIZED' },
      { _id: 'a7', sourceAnswerSegmentId: 's7', questionId: { order: 6, questionText: 'Q7', points: 5 }, pointsEarned: 4, evaluationStatus: 'FINALIZED' },
      { _id: 'a8', sourceAnswerSegmentId: 's8', questionId: { order: 7, questionText: 'Q8', points: 5 }, pointsEarned: 0, evaluationStatus: 'FINALIZED' },
    ];
    const derivative = await buildEvaluatedDerivativePdf({
      sourceBuffer,
      mimeType: 'application/pdf',
      candidate: { name: 'Asha' },
      exam: { title: 'Three-page paper review' },
      script: scriptMeta,
      answers,
      segments: [
        { _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.10, width: 0.68, height: 0.11 } },
        { _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.25, width: 0.68, height: 0.11 } },
        { _id: 's3', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.42, width: 0.68, height: 0.11 } },
        { _id: 's4', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.60, width: 0.68, height: 0.11 } },
        { _id: 's5', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.15, width: 0.68, height: 0.11 } },
        { _id: 's6', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.42, width: 0.68, height: 0.11 } },
        { _id: 's7', pageIds: ['p2', 'p3'], boundingRegion: { x: 0.08, y: 0.46, width: 0.68, height: 0.14 } },
        { _id: 's8', pageIds: ['p3'], boundingRegion: { x: 0.08, y: 0.66, width: 0.68, height: 0.10 } },
      ],
      annotations: [
        { type: 'HIGHLIGHT', source: 'EVALUATOR', status: 'APPROVED', pageId: 'p1', region: { x: 0.2, y: 0.31, width: 0.2, height: 0.03 }, message: 'Missing one point' },
        { type: 'CHECK', source: 'EVALUATOR', status: 'APPROVED', pageId: 'p2', region: { x: 0.8, y: 0.17, width: 0.04, height: 0.05 } },
        { type: 'UNDERLINE', source: 'EVALUATOR', status: 'APPROVED', pageId: 'p2', region: { x: 0.2, y: 0.48, width: 0.22, height: 0.02 } },
        { type: 'CROSS', source: 'EVALUATOR', status: 'APPROVED', pageId: 'p3', region: { x: 0.8, y: 0.68, width: 0.04, height: 0.05 } },
      ],
      pageNumberById: { p1: 1, p2: 2, p3: 3 },
      attemptTotal: 21,
    });
    const loaded = await PDFDocument.load(derivative);
    const parsed = extractPdfText(derivative);
    assert.ok(loaded.getPageCount() >= 4, 'three original pages plus secondary appendix');
    assert.match(parsed, /5 \/ 5/);
    assert.match(parsed, /3 \/ 5/);
    assert.match(parsed, /0 \/ 5/);
    assert.match(parsed, /21 \/ 40/);
  });
});
