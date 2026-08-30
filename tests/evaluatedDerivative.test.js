import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { buildEvaluatedDerivativePdf } from '../services/offlineEvaluation/evaluatedDerivativeService.js';
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
    pointsEarned: 0, evaluationStatus: 'FINALIZED', finalScoreSource: 'AI',
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
    assert.match(parsed, /15 \/ 25/);
    assert.doesNotMatch(parsed, /Edit Score|Approve|Flag|AI Approved|enviroment/);

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
});
