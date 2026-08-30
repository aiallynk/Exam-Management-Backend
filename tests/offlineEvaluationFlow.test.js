import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildRubricEvaluationPayload,
  formatRubricRowsForAppendix,
  normalizeRubricCriterionScores,
} from '../services/offlineEvaluation/rubricScoreNormalization.js';
import {
  mapObservationsToAnnotations,
  matchPhraseToLineBoxes,
  tokenOverlapScore,
} from '../services/offlineEvaluation/evidenceAnnotationService.js';
import {
  findSegmentForQuestion,
  validateMaterializationIntegrity,
} from '../services/offlineEvaluation/materializationIntegrity.js';
import { buildProcessingStatusPayload } from '../services/offlineEvaluation/answerScriptProcessingStatus.js';
import { selectExportEvidenceAnnotations } from '../services/offlineEvaluation/evaluatedAnnotationPlan.js';

describe('rubric score normalization', () => {
  test('maps AI score field to marks consistently', () => {
    const normalized = normalizeRubricCriterionScores([
      { criterion: 'Concept clarity', score: 3, maxScore: 5, comment: 'Good' },
      { criterion: 'Examples', score: 2, maxScore: 2 },
    ]);
    assert.equal(normalized.entries[0].marks, 3);
    assert.equal(normalized.entries[0].maxMarks, 5);
    assert.equal(normalized.total, 5);
  });

  test('buildRubricEvaluationPayload preserves question score', () => {
    const payload = buildRubricEvaluationPayload({
      rubricScores: [{ criterion: 'A', score: 4, maxScore: 5 }],
      pointsEarned: 4,
    });
    assert.equal(payload.finalMark, 4);
    assert.equal(payload.finalScores[0].marks, 4);
  });

  test('uses criterion identity rather than a mismatched array position', () => {
    const normalized = normalizeRubricCriterionScores([
      { key: 'coverage', score: 2, maxScore: 2 },
      { key: 'accuracy', score: 3, maxScore: 3 },
    ], [
      { key: 'accuracy', criterion: 'Accuracy', maxScore: 3 },
      { key: 'coverage', criterion: 'Coverage', maxScore: 2 },
    ]);
    assert.deepEqual(normalized.entries.map((entry) => [entry.criterion, entry.marks]), [
      ['Accuracy', 3],
      ['Coverage', 2],
    ]);
  });

  test('reports an unavailable breakdown rather than fake zero criteria after a question-level override', () => {
    const rubric = [
      { key: 'process', criterion: 'Process', maxScore: 3 },
      { key: 'clarity', criterion: 'Clarity', maxScore: 2 },
    ];
    const formatted = formatRubricRowsForAppendix({
      pointsEarned: 5,
      rubricEvaluation: {
        aiScores: [{ key: 'process', score: 0, maxScore: 3 }, { key: 'clarity', score: 0, maxScore: 2 }],
        finalScores: [],
        finalMark: 5,
        overriddenBy: 'evaluator-1',
        overrideReason: 'Checked against the handwritten response.',
      },
    }, rubric);
    assert.equal(formatted.available, false);
    assert.equal(formatted.reason, 'QUESTION_LEVEL_OVERRIDE');
    assert.deepEqual(formatted.rows, []);
  });
});

describe('evidence annotation mapping', () => {
  const lineBoxes = [
    { id: 'l1', text: 'Photosynthesis converts light energy', x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
    { id: 'l2', text: 'into chemical energy in plants', x: 0.1, y: 0.25, width: 0.48, height: 0.04 },
  ];

  test('fuzzy-matches quoted evidence to OCR lines', () => {
    const match = matchPhraseToLineBoxes('photosynthesis converts light', lineBoxes);
    assert.ok(match);
    assert.ok(match.score >= 0.45);
    assert.equal(match.lineId, 'l1');
  });

  test('falls back to margin comment when phrase cannot be matched', () => {
    const annotations = mapObservationsToAnnotations({
      segment: { boundingRegion: { x: 0.08, y: 0.3, width: 0.7, height: 0.15 }, lineBoxes },
      result: {
        pointsEarned: 0,
        maxScore: 5,
        aiEvaluation: { missingConcepts: ['Mitochondria role in respiration'] },
      },
      pageId: 'p1',
    });
    assert.ok(annotations.some((item) => item.type === 'MISSING_POINT'));
  });

  test('creates underline region for incorrect statement match', () => {
    const annotations = mapObservationsToAnnotations({
      segment: { boundingRegion: { x: 0.08, y: 0.3, width: 0.7, height: 0.15 }, lineBoxes },
      result: {
        pointsEarned: 2,
        maxScore: 5,
        aiEvaluation: { incorrectStatements: ['light energy into chemical energy'] },
      },
      pageId: 'p1',
    });
    assert.ok(annotations.some((item) => item.type === 'INCORRECT' && item.region));
  });
});

describe('materialization integrity', () => {
  test('requires every assessment question to have an answer', () => {
    assert.throws(() => validateMaterializationIntegrity({
      expectedQuestions: [{ questionId: 'q1', displayNumber: 1, points: 5 }],
      answers: [],
    }), /Missing answer record/);
  });

  test('finds segment by detected question number', () => {
    const segment = findSegmentForQuestion([
      { detectedQuestionNumber: '4', extractedText: '' },
    ], { questionId: 'missing', displayNumber: 4 });
    assert.equal(segment.detectedQuestionNumber, '4');
  });

  test('materialization must not call save on lean segment documents', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../services/offlineEvaluation/attemptMaterializationService.js', import.meta.url),
      'utf8',
    ));
    assert.equal(/AnswerSegment\.find\(\{ answerScriptId: script\._id \}\)\.lean\(\)/.test(source), false);
    assert.equal(source.includes('await segment.save()'), true);
  });
});

describe('processing status payload', () => {
  test('marks active OCR stage without forcing full detail reload semantics', () => {
    const payload = buildProcessingStatusPayload({
      status: 'EXTRACTING',
      pageCount: 3,
      processingMeta: { pagesProcessed: 2, pagesTotal: 3, stage: 'EXTRACTING_PAGE_2' },
    });
    assert.equal(payload.currentStage, 'OCR_PROCESSING');
    assert.equal(payload.polling, true);
    assert.match(payload.message, /Reading page 2 of 3/);
  });

  test('stops polling once ready for review', () => {
    const payload = buildProcessingStatusPayload({ status: 'EVALUATED' });
    assert.equal(payload.currentStage, 'READY_FOR_REVIEW');
    assert.equal(payload.polling, false);
  });
});

describe('evidence export selection', () => {
  test('exports approved teacher-style evidence annotations', () => {
    const exported = selectExportEvidenceAnnotations([
      { type: 'HIGHLIGHT', source: 'EVALUATOR', status: 'APPROVED', region: { x: 0.1, y: 0.2, width: 0.4, height: 0.03 }, pageId: 'p1', message: 'Wrong formula' },
      { type: 'SCORE', status: 'APPROVED', region: { x: 0.8, y: 0.2, width: 0.1, height: 0.04 }, pageId: 'p1' },
    ], { p1: 1 });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].type, 'HIGHLIGHT');
  });
});

describe('token overlap', () => {
  test('scores partial overlap for handwriting OCR drift', () => {
    assert.ok(tokenOverlapScore('cell membrane transport', 'cell membrane active transport') >= 0.5);
  });
});
