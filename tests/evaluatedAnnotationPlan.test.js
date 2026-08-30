import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EvaluatedDerivativeIntegrityError,
  assertDerivativeIntegrity,
  buildTeacherAnnotationPlan,
  classifyVerdict,
  formatScoreLabel,
  formatTeacherMarkLabel,
  isWordLevelRegion,
  placeTeacherMark,
  regionsOverlap,
  selectExportCorrections,
  selectExportEvidenceAnnotations,
} from '../services/offlineEvaluation/evaluatedAnnotationPlan.js';

const answers = ({
  q1 = 5, q2 = 3, q3 = 4, q4 = 0, q5 = 3,
  overrideQ2 = false,
} = {}) => ([
  { _id: 'a1', sourceAnswerSegmentId: 's1', questionId: { _id: 'q1', order: 0, points: 5, questionText: 'Q1' }, pointsEarned: q1, finalScoreSource: 'AI' },
  {
    _id: 'a2', sourceAnswerSegmentId: 's2', questionId: { _id: 'q2', order: 1, points: 5, questionText: 'Q2' }, pointsEarned: q2,
    finalScoreSource: overrideQ2 ? 'EXAMINER' : 'AI',
    examinerReviewedAt: overrideQ2 ? new Date('2026-08-30T10:00:00Z') : undefined,
    examinerFeedback: overrideQ2 ? 'Missing one required point' : '',
  },
  { _id: 'a3', sourceAnswerSegmentId: 's3', questionId: { _id: 'q3', order: 2, points: 5, questionText: 'Q3' }, pointsEarned: q3, finalScoreSource: 'AI' },
  { _id: 'a4', sourceAnswerSegmentId: 's4', questionId: { _id: 'q4', order: 3, points: 5, questionText: 'Q4' }, pointsEarned: q4, finalScoreSource: 'AI' },
  { _id: 'a5', sourceAnswerSegmentId: 's5', questionId: { _id: 'q5', order: 4, points: 5, questionText: 'Q5' }, pointsEarned: q5, finalScoreSource: 'AI' },
]);

const pageNumberById = { p1: 1, p2: 2 };

describe('teacher annotation plan — verdicts and labels', () => {
  test('classifies full, partial, and zero marks independently of AI labels', () => {
    assert.equal(classifyVerdict(5, 5), 'CORRECT');
    assert.equal(classifyVerdict(3, 5), 'PARTIAL');
    assert.equal(classifyVerdict(0, 5), 'INCORRECT');
    assert.equal(formatScoreLabel(5, 5), '5 / 5');
    assert.equal(formatScoreLabel(3, 5), '3 / 5');
    assert.equal(formatScoreLabel(0, 5), '0 / 5');
    assert.equal(formatTeacherMarkLabel({ questionNumber: 2, earned: 2, max: 5 }), 'Q2  2/5');
    assert.equal(formatTeacherMarkLabel({ questionNumber: 4, earned: 0, max: 5, notAttempted: true }), 'Q4  Not attempted 0/5');
  });
});

describe('teacher annotation plan — required render cases', () => {
  test('1. full-mark answer renders CORRECT 5 / 5 once', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[0]],
      segments: [{ _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.12, width: 0.68, height: 0.18 } }],
      pageNumberById,
      attemptTotal: 5,
    });
    assert.equal(plan.marks.length, 1);
    assert.equal(plan.marks[0].verdict, 'CORRECT');
    assert.equal(plan.marks[0].scoreLabel, '5 / 5');
    assert.equal(plan.marks[0].placement.strategy, 'RIGHT_MARGIN');
    assertDerivativeIntegrity(plan, { answers: [answers()[0]], attemptTotal: 5 });
  });

  test('2. zero-mark answer renders INCORRECT 0 / 5', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[3]],
      segments: [{ _id: 's4', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.55, width: 0.7, height: 0.2 } }],
      pageNumberById,
      attemptTotal: 0,
    });
    assert.equal(plan.marks[0].verdict, 'INCORRECT');
    assert.equal(plan.marks[0].scoreLabel, '0 / 5');
  });

  test('3. partial-mark answer renders PARTIAL 3 / 5', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[1]],
      segments: [{ _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.1, y: 0.32, width: 0.66, height: 0.16 } }],
      pageNumberById,
      attemptTotal: 3,
    });
    assert.equal(plan.marks[0].verdict, 'PARTIAL');
    assert.equal(plan.marks[0].scoreLabel, '3 / 5');
  });

  test('4. human-overridden AI score uses the stored examiner mark, not the AI SCORE annotation', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: answers({ q2: 3, overrideQ2: true }).slice(1, 2),
      segments: [{ _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.1, y: 0.3, width: 0.65, height: 0.2 } }],
      annotations: [{
        answerId: 'a2',
        type: 'SCORE',
        status: 'REJECTED',
        message: '5 / 5',
        proposedScore: 5,
        region: { x: 0.8, y: 0.3, width: 0.12, height: 0.05 },
        pageId: 'p1',
      }, {
        answerId: 'a2',
        type: 'SCORE',
        status: 'APPROVED',
        message: '5 / 5',
        proposedScore: 5,
        region: { x: 0.8, y: 0.36, width: 0.12, height: 0.05 },
        pageId: 'p1',
      }],
      pageNumberById,
      attemptTotal: 3,
    });
    assert.equal(plan.marks[0].scoreLabel, '3 / 5');
    assert.equal(plan.marks[0].marksObtained, 3);
    assert.match(plan.marks[0].remark, /Missing one required point/);
    assert.equal(plan.corrections.length, 0);
  });

  test('5. multi-page answer script keeps one mark per question on its own page', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[0], answers()[3]],
      segments: [
        { _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.1, y: 0.15, width: 0.65, height: 0.25 } },
        { _id: 's4', pageIds: ['p2'], boundingRegion: { x: 0.1, y: 0.2, width: 0.65, height: 0.25 } },
      ],
      pageNumberById,
      attemptTotal: 5,
    });
    assert.equal(plan.marks[0].pageNumber, 1);
    assert.equal(plan.marks[1].pageNumber, 2);
    assert.equal(plan.marks.length, 2);
  });

  test('6. multiple questions on one page do not collide and keep distinct scores', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[0], answers()[1], answers()[2]],
      segments: [
        { _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.10, width: 0.68, height: 0.16 } },
        { _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.32, width: 0.68, height: 0.16 } },
        { _id: 's3', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.54, width: 0.68, height: 0.16 } },
      ],
      pageNumberById,
      attemptTotal: 12,
    });
    assert.equal(plan.marks.length, 3);
    assert.deepEqual(plan.marks.map((mark) => mark.scoreLabel), ['5 / 5', '3 / 5', '4 / 5']);
    assert.ok(!regionsOverlap(plan.marks[0].placement, plan.marks[1].placement, 0));
    assert.ok(!regionsOverlap(plan.marks[1].placement, plan.marks[2].placement, 0));
    plan.marks.forEach((mark) => assert.equal(mark.pageNumber, 1));
  });

  test('7. one answer spanning two pages is marked once on the last page', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[2]],
      segments: [{
        _id: 's3',
        pageIds: ['p1', 'p2'],
        boundingRegion: { x: 0.08, y: 0.55, width: 0.7, height: 0.35 },
      }],
      pageNumberById,
      attemptTotal: 4,
    });
    assert.equal(plan.marks.length, 1);
    assert.equal(plan.marks[0].spansPages, true);
    assert.equal(plan.marks[0].pageNumber, 2);
    assert.equal(plan.marks[0].scoreLabel, '4 / 5');
    assert.equal(plan.marks[0].placement.strategy, 'SAFE_MARGIN');
  });

  test('7b. a blank mapped question uses its local question anchor, not a bottom-page score slot', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [{
        ...answers()[3],
        evaluationStatus: 'NOT_ATTEMPTED',
        aiEvaluation: { notAttempted: true },
      }],
      segments: [],
      // A blank response has no materialized AnswerSegment. Reuse the
      // persisted page-extraction question label rather than a page corner.
      questionAnchorsByQuestionNumber: {
        4: { pageNumber: 2, region: { x: 0.08, y: 0.31, width: 0.18, height: 0.035 } },
      },
      pageNumberById,
      attemptTotal: 0,
    });
    assert.equal(plan.marks[0].pageNumber, 2);
    assert.equal(plan.marks[0].remark, 'Not attempted');
    assert.equal(plan.marks[0].placement.strategy, 'RIGHT_MARGIN');
    assert.ok(Math.abs(plan.marks[0].placement.y - 0.316) < 0.03);
  });

  test('7c. a blank-question score avoids the next answer while staying beside its question anchor', () => {
    const blank = {
      ...answers()[3],
      evaluationStatus: 'NOT_ATTEMPTED',
      aiEvaluation: { notAttempted: true },
    };
    const nextAnswer = answers()[4];
    const plan = buildTeacherAnnotationPlan({
      answers: [blank, nextAnswer],
      segments: [{ _id: 's5', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.36, width: 0.68, height: 0.11 } }],
      questionAnchorsByQuestionNumber: {
        4: { pageNumber: 2, region: { x: 0.08, y: 0.31, width: 0.18, height: 0.035 } },
      },
      pageNumberById,
      attemptTotal: 3,
    });
    const q4 = plan.marks.find((mark) => mark.questionNumber === 4);
    const q5 = plan.marks.find((mark) => mark.questionNumber === 5);
    assert.equal(q4.placement.strategy, 'SAFE_MARGIN');
    assert.ok(q4.placement.x >= 0.76, 'Q4 uses the right-side margin rather than Q5 space');
    assert.ok(!regionsOverlap(q4.placement, { x: 0.08, y: 0.36, width: 0.68, height: 0.11 }, 0));
    assert.ok(!regionsOverlap(q4.placement, q5.placement, 0));
  });

  test('8. insufficient blank margin falls back to below-answer or a safe page margin', () => {
    const wide = placeTeacherMark({
      answerRegion: { x: 0.04, y: 0.12, width: 0.94, height: 0.78 },
      occupiedRegions: [{ x: 0.04, y: 0.12, width: 0.94, height: 0.78 }],
    });
    assert.ok(['BELOW_ANSWER', 'SAFE_MARGIN'].includes(wide.strategy));
    assert.ok(wide.x + wide.width <= 1);
    assert.ok(wide.y + wide.height <= 1);

    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[0]],
      segments: [{ _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.04, y: 0.08, width: 0.94, height: 0.86 } }],
      pageNumberById,
      attemptTotal: 5,
    });
    assert.ok(['BELOW_ANSWER', 'SAFE_MARGIN'].includes(plan.marks[0].placement.strategy));
    assert.ok(plan.marks[0].placement.confidence !== 'HIGH' || plan.marks[0].placement.strategy === 'BELOW_ANSWER');
  });

  test('9. rejected and proposed annotations never become export corrections', () => {
    const corrections = selectExportCorrections([
      { type: 'SPELLING', status: 'PROPOSED', region: { x: 0.2, y: 0.3, width: 0.18, height: 0.03 }, message: 'enviroment', pageId: 'p1' },
      { type: 'SPELLING', status: 'REJECTED', region: { x: 0.2, y: 0.4, width: 0.18, height: 0.03 }, message: 'recieve', pageId: 'p1' },
      { type: 'GRAMMAR', status: 'APPROVED', region: { x: 0.22, y: 0.5, width: 0.2, height: 0.03 }, message: 'was', pageId: 'p1' },
      { type: 'SCORE', status: 'APPROVED', region: { x: 0.8, y: 0.1, width: 0.12, height: 0.05 }, message: '5 / 5', pageId: 'p1' },
      { type: 'CORRECT', status: 'APPROVED', region: { x: 0.1, y: 0.1, width: 0.7, height: 0.2 }, message: '', pageId: 'p1' },
    ], pageNumberById);
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].type, 'GRAMMAR');
  });

  test('10. rendered question marks exactly match final authoritative scores and attempt total', () => {
    const authoritative = answers({ q1: 5, q2: 3, q3: 4, q4: 0, q5: 3, overrideQ2: true });
    const plan = buildTeacherAnnotationPlan({
      answers: authoritative,
      segments: [
        { _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.08, width: 0.68, height: 0.14 } },
        { _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.26, width: 0.68, height: 0.14 } },
        { _id: 's3', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.44, width: 0.68, height: 0.14 } },
        { _id: 's4', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.12, width: 0.68, height: 0.2 } },
        { _id: 's5', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.40, width: 0.68, height: 0.2 } },
      ],
      annotations: [{
        type: 'SCORE', status: 'APPROVED', answerId: 'a1', pageId: 'p1',
        message: '2 / 5', proposedScore: 2, region: { x: 0.8, y: 0.08, width: 0.12, height: 0.05 },
      }],
      pageNumberById,
      attemptTotal: 15,
    });
    assert.deepEqual(plan.marks.map((mark) => mark.scoreLabel), ['5 / 5', '3 / 5', '4 / 5', '0 / 5', '3 / 5']);
    assert.equal(plan.displayedTotal, 15);
    assert.equal(plan.marks.length, 5);
    assert.equal(new Set(plan.marks.map((mark) => mark.questionNumber)).size, 5);
    assertDerivativeIntegrity(plan, { answers: authoritative, attemptTotal: 15 });
  });

  test('12. Ravi fixture — Q2 score stays with Q2 and every mark includes question number', () => {
    const authoritative = answers({ q1: 5, q2: 2, q3: 4, q4: 0, q5: 3 });
    const plan = buildTeacherAnnotationPlan({
      answers: authoritative,
      segments: [
        { _id: 's1', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.08, width: 0.68, height: 0.14 } },
        { _id: 's2', pageIds: ['p1'], boundingRegion: { x: 0.08, y: 0.26, width: 0.68, height: 0.14 } },
        {
          _id: 's3',
          pageIds: ['p1', 'p2'],
          boundingRegion: { x: 0.08, y: 0.54, width: 0.68, height: 0.16 },
          lineBoxes: [
            { pageId: 'p2', x: 0.08, y: 0.10, width: 0.68, height: 0.05 },
            { pageId: 'p2', x: 0.08, y: 0.16, width: 0.68, height: 0.05 },
          ],
        },
        { _id: 's5', pageIds: ['p2'], boundingRegion: { x: 0.08, y: 0.40, width: 0.68, height: 0.18 } },
      ],
      questionAnchorsByQuestionNumber: {
        4: { pageNumber: 2, region: { x: 0.08, y: 0.31, width: 0.18, height: 0.035 } },
      },
      pageNumberById,
      attemptTotal: 14,
    });

    assert.deepEqual(plan.marks.map((mark) => mark.scoreLabel), ['5 / 5', '2 / 5', '4 / 5', '0 / 5', '3 / 5']);
    assert.equal(plan.displayedTotal, 14);

    const q1 = plan.marks.find((mark) => mark.questionNumber === 1);
    const q2 = plan.marks.find((mark) => mark.questionNumber === 2);
    const q3 = plan.marks.find((mark) => mark.questionNumber === 3);
    const q4 = plan.marks.find((mark) => mark.questionNumber === 4);
    const q5 = plan.marks.find((mark) => mark.questionNumber === 5);

    plan.marks.forEach((mark) => {
      assert.match(mark.displayLabel, new RegExp(`^Q${mark.questionNumber}\\s`));
    });

    assert.equal(q1.pageNumber, 1);
    assert.equal(q2.pageNumber, 1);
    assert.equal(q3.pageNumber, 2);
    assert.equal(q4.pageNumber, 2);
    assert.equal(q5.pageNumber, 2);

    const q3StartRegion = { x: 0.08, y: 0.54, width: 0.68, height: 0.16 };
    assert.ok(q2.placement.y < q3StartRegion.y + q3StartRegion.height * 0.5, 'Q2 marker must not sit inside Q3 start region');
    assert.ok(!regionsOverlap(q2.placement, q3StartRegion, 0.02));
    assert.ok(q3.placement.y >= 0.08 && q3.placement.y <= 0.28, 'Q3 final score anchors near continuation on page 2');

    assertDerivativeIntegrity(plan, { answers: authoritative, attemptTotal: 14 });
  });

  test('11. evaluator check, cross, highlight, and underline stay on original-page coordinates for export', () => {
    const evidence = selectExportEvidenceAnnotations([
      { type: 'CHECK', source: 'EVALUATOR', status: 'APPROVED', region: { x: 0.8, y: 0.12, width: 0.04, height: 0.05 }, pageId: 'p1' },
      { type: 'CROSS', source: 'EVALUATOR', status: 'APPROVED', region: { x: 0.8, y: 0.24, width: 0.04, height: 0.05 }, pageId: 'p1' },
      { type: 'HIGHLIGHT', source: 'EVALUATOR', status: 'APPROVED', region: { x: 0.2, y: 0.42, width: 0.22, height: 0.04 }, pageId: 'p2' },
      { type: 'UNDERLINE', source: 'EVALUATOR', status: 'APPROVED', region: { x: 0.2, y: 0.52, width: 0.24, height: 0.02 }, pageId: 'p2' },
    ], pageNumberById);
    assert.deepEqual(evidence.map((item) => item.type), ['CHECK', 'CROSS', 'HIGHLIGHT', 'UNDERLINE']);
    assert.deepEqual(evidence.map((item) => item.pageNumber), [1, 1, 2, 2]);
  });
});

describe('teacher annotation plan — integrity failures', () => {
  test('fails closed when the attempt total disagrees with stored answers', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: answers(),
      segments: [],
      pageNumberById,
    });
    assert.throws(
      () => assertDerivativeIntegrity(plan, { answers: answers(), attemptTotal: 10 }),
      (error) => error instanceof EvaluatedDerivativeIntegrityError && error.code === 'DERIVATIVE_INTEGRITY',
    );
  });

  test('fails closed when a rendered score is tampered away from the stored answer', () => {
    const plan = buildTeacherAnnotationPlan({
      answers: [answers()[0]],
      segments: [],
      pageNumberById,
      attemptTotal: 5,
    });
    plan.marks[0].marksObtained = 4;
    plan.marks[0].scoreLabel = '4 / 5';
    assert.throws(
      () => assertDerivativeIntegrity(plan, { answers: [answers()[0]], attemptTotal: 5 }),
      EvaluatedDerivativeIntegrityError,
    );
  });

  test('word-level OCR boxes are not treated as full answers but can anchor a blank-question score', () => {
    assert.equal(isWordLevelRegion({ x: 0.2, y: 0.3, width: 0.12, height: 0.03 }), true);
    const placement = placeTeacherMark({
      answerRegion: { x: 0.2, y: 0.3, width: 0.12, height: 0.03 },
    });
    assert.equal(placement.strategy, 'RIGHT_MARGIN');
    assert.equal(placement.confidence, 'MEDIUM');
  });
});
