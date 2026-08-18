import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuestionDistributionError,
  enforceQuestionDistribution,
  normalizeToRequestedType,
} from '../services/aiService.js';

// Regression coverage for a reported production bug: requesting a mix of
// MULTIPLE_CHOICE / SHORT_ANSWER / PARAGRAPH questions produced wrong final
// counts. Root cause #1: paragraph-group sub-questions were pooled/counted
// under their own sub-answer-type instead of the PARAGRAPH quota they were
// generated for (fixed in enforceQuestionDistribution's pooling key). Root
// cause #2: an earlier fix attempt let a paragraph-quota candidate with real
// options come back typed MULTIPLE_CHOICE — which silently shifted that
// slot's tally from PARAGRAPH into MULTIPLE_CHOICE as soon as anything
// counts questions by questionType (the distribution summary UI, the
// request-vs-generated validation), producing "requested 4 MCQ / 3
// Paragraph, got 5 MCQ / 2 Paragraph" — the exact shape of this second bug
// report. normalizeToRequestedType's PARAGRAPH branch must always return
// questionType: 'PARAGRAPH', full stop, so a slot filled by that branch can
// never be tallied under a different type.

const paragraphGroupedShortAnswer = {
  questionText: 'What is the main theme of the passage?',
  questionType: 'SHORT_ANSWER',
  questionFormat: 'PARAGRAPH',
  passage: 'Once upon a time in a distant land, a young explorer set out to map the coastline.',
  correctAnswer: 'Exploration and discovery',
};

const paragraphGroupedMultipleChoice = {
  questionText: 'Where did the explorer travel?',
  questionType: 'MULTIPLE_CHOICE',
  questionFormat: 'PARAGRAPH',
  passage: 'Once upon a time in a distant land, a young explorer set out to map the coastline.',
  options: ['A distant land', 'A busy city', 'The moon', 'A desert'],
  correctAnswer: 'A distant land',
};

const standaloneShortAnswer = {
  questionText: 'Define photosynthesis.',
  questionType: 'SHORT_ANSWER',
  correctAnswer: 'The process by which plants convert light into energy.',
};

const standaloneMcq = {
  questionText: 'What is 2 + 2?',
  questionType: 'MULTIPLE_CHOICE',
  options: ['3', '4', '5', '6'],
  correctAnswer: '4',
};

const tallyByType = (result) =>
  result.reduce((acc, q) => {
    acc[q.questionType] = (acc[q.questionType] || 0) + 1;
    return acc;
  }, {});

describe('enforceQuestionDistribution — final per-type tally always matches the requested distribution exactly', () => {
  test('the reported 5 MCQ + 5 Multi-select + 5 Fill Blank case remains exactly 5 + 5 + 5', () => {
    const questions = [
      ...Array.from({ length: 5 }, (_, index) => ({
        questionText: `MCQ ${index + 1}`,
        questionType: index % 2 === 0 ? 'mcq' : 'single_choice',
        options: ['A', 'B', 'C', 'D'],
        correctAnswer: 'A',
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        questionText: `Multi ${index + 1}`,
        questionType: index % 2 === 0 ? 'multiple_select' : 'multi-select',
        options: ['A', 'B', 'C', 'D'],
        correctAnswer: ['A', 'C'],
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        questionText: `Fill ____ ${index + 1}`,
        questionType: index % 2 === 0 ? 'fill_blank' : 'FILL_IN_THE_BLANK',
        correctAnswer: `answer-${index + 1}`,
      })),
    ];

    const result = enforceQuestionDistribution({
      questions,
      typeDistribution: [
        { type: 'multiple_choice', count: 5 },
        { type: 'multiple_select', count: 5 },
        { type: 'fill_blank', count: 5 },
      ],
      count: 15,
      topic: 'Regression test',
    });

    assert.equal(result.length, 15);
    assert.deepEqual(tallyByType(result), {
      MULTIPLE_CHOICE: 5,
      MULTIPLE_OPTIONS: 5,
      FILL_IN_THE_BLANK: 5,
    });
  });

  test('a missing requested type is rejected instead of being filled by relabeling overflow from another type', () => {
    // Mirrors the exact reported scenario: AI under-delivers standalone MCQ
    // (2 valid) and over-delivers SHORT_ANSWER (5 valid), plus a paragraph
    // group with one open-ended and one MCQ-shaped sub-question.
    const questions = [
      { questionText: 'MCQ 1', questionType: 'MULTIPLE_CHOICE', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A' },
      { questionText: 'MCQ 2', questionType: 'MULTIPLE_CHOICE', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B' },
      { questionText: 'SA 1', questionType: 'SHORT_ANSWER', correctAnswer: 'a1' },
      { questionText: 'SA 2', questionType: 'SHORT_ANSWER', correctAnswer: 'a2' },
      { questionText: 'SA 3', questionType: 'SHORT_ANSWER', correctAnswer: 'a3' },
      { questionText: 'SA 4', questionType: 'SHORT_ANSWER', correctAnswer: 'a4' },
      { questionText: 'SA 5', questionType: 'SHORT_ANSWER', correctAnswer: 'a5' },
      paragraphGroupedShortAnswer,
      { ...paragraphGroupedShortAnswer, questionText: 'What happened next?', correctAnswer: 'They found the coast.' },
      paragraphGroupedMultipleChoice,
    ];

    assert.throws(
      () => enforceQuestionDistribution({
        questions,
        typeDistribution: [
          { type: 'MULTIPLE_CHOICE', count: 4 },
          { type: 'PARAGRAPH', count: 3 },
          { type: 'SHORT_ANSWER', count: 3 },
        ],
        count: 10,
      }),
      (error) => {
        assert.ok(error instanceof QuestionDistributionError);
        assert.deepEqual(error.missingDistribution, [
          { type: 'MULTIPLE_CHOICE', expected: 4, actual: 2, count: 2 },
        ]);
        return true;
      }
    );
  });

  test('requesting 1 MCQ / 1 SHORT_ANSWER / 2 PARAGRAPH yields exactly those counts, not an inflated SHORT_ANSWER bucket', () => {
    const result = enforceQuestionDistribution({
      questions: [standaloneMcq, standaloneShortAnswer, paragraphGroupedShortAnswer, paragraphGroupedMultipleChoice],
      typeDistribution: [
        { type: 'MULTIPLE_CHOICE', count: 1 },
        { type: 'SHORT_ANSWER', count: 1 },
        { type: 'PARAGRAPH', count: 2 },
      ],
      count: 4,
      topic: 'General knowledge',
    });

    assert.equal(result.length, 4);
    assert.deepEqual(tallyByType(result), { MULTIPLE_CHOICE: 1, SHORT_ANSWER: 1, PARAGRAPH: 2 });

    const paragraphResults = result.filter((q) => q.questionType === 'PARAGRAPH');
    assert.ok(paragraphResults.some((q) => q.passage === paragraphGroupedShortAnswer.passage));
  });

  test('a PARAGRAPH-grouped sub-question is never pooled toward PARAGRAPH when the caller never requested any PARAGRAPH questions', () => {
    const result = enforceQuestionDistribution({
      questions: [standaloneMcq, paragraphGroupedShortAnswer],
      typeDistribution: [{ type: 'MULTIPLE_CHOICE', count: 1 }, { type: 'SHORT_ANSWER', count: 1 }],
      count: 2,
      topic: 'General knowledge',
    });
    assert.equal(result.length, 2);
    assert.deepEqual(tallyByType(result), { MULTIPLE_CHOICE: 1, SHORT_ANSWER: 1 });
  });
});

describe('normalizeToRequestedType — PARAGRAPH branch always returns questionType: PARAGRAPH', () => {
  test('a candidate with real options still resolves to PARAGRAPH (with passage), never a different type', () => {
    const output = normalizeToRequestedType({
      question: paragraphGroupedMultipleChoice,
      type: 'PARAGRAPH',
      index: 0,
      topic: 'Adventure story',
    });
    assert.equal(output.questionType, 'PARAGRAPH');
    assert.equal(output.options, undefined);
    assert.equal(output.passage, paragraphGroupedMultipleChoice.passage);
  });

  test('a candidate with no options stays a subjective PARAGRAPH question with the passage attached', () => {
    const output = normalizeToRequestedType({
      question: paragraphGroupedShortAnswer,
      type: 'PARAGRAPH',
      index: 0,
      topic: 'Adventure story',
    });
    assert.equal(output.questionType, 'PARAGRAPH');
    assert.equal(output.options, undefined);
    assert.equal(output.passage, paragraphGroupedShortAnswer.passage);
  });
});
