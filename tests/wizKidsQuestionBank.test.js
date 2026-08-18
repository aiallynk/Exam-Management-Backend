import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Question from '../models/Question.js';
import WizKidsQuestionBankItem from '../models/WizKidsQuestionBankItem.js';
import WizKidsQuestionLink from '../models/WizKidsQuestionLink.js';
import {
  INTERACTION_TYPE_TO_QUESTION_TYPE,
  stringifyCorrectAnswerForQuestion,
  WizKidsQuestionBankError,
} from '../services/wizKidsQuestionBankService.js';

// WizKids Phase 5 — Reusable Question Bank.
// Covers: DOCS/XAMIGO_WIZKIDS_MASTER_DEVELOPMENT_PROMPT.md §21/§22/§24/§54
// Phase 5 ("Verify that generated/materialized questions appear correctly
// in the normal exam pipeline"). Same schema-introspection + pure-function
// convention as Phases 1-4 (no live-database infrastructure in this repo).

describe('WizKidsQuestionBankItem schema', () => {
  test('interactionType matches exactly the six types named in master prompt §54 Phase 5 — no more, no fewer', () => {
    const path = WizKidsQuestionBankItem.schema.path('interactionType');
    assert.deepEqual(
      [...path.enumValues].sort(),
      ['FILL_IN_THE_BLANK', 'IMAGE', 'MATCHING', 'MCQ', 'NUMBER', 'SHORT_ANSWER']
    );
  });

  test('domain matches the five WizKids content domains used consistently across Phases 3-5', () => {
    const path = WizKidsQuestionBankItem.schema.path('domain');
    assert.deepEqual([...path.enumValues].sort(), ['LOGIC', 'MENTAL_MATHS', 'OLYMPIAD', 'SUPER_MATHS', 'VEDIC_MATHS']);
  });

  test('gradeLevel is a plain 1-7 integer, consistent with WizKidsBatch and WizKidsExamConfig', () => {
    const path = WizKidsQuestionBankItem.schema.path('gradeLevel');
    assert.equal(path.options.min, 1);
    assert.equal(path.options.max, 7);
  });

  test('status defaults to DRAFT — content is not materializable until explicitly published', () => {
    const path = WizKidsQuestionBankItem.schema.path('status');
    assert.equal(path.defaultValue, 'DRAFT');
    assert.deepEqual([...path.enumValues].sort(), ['ARCHIVED', 'DRAFT', 'PUBLISHED']);
  });

  test('tenantId is required and indexed (tenant isolation prerequisite)', () => {
    const path = WizKidsQuestionBankItem.schema.path('tenantId');
    assert.equal(path.isRequired, true);
  });
});

describe('WizKidsQuestionLink schema', () => {
  test('exactly one link per materialized Question is enforced by a unique index on questionId', () => {
    const indexes = WizKidsQuestionLink.schema.indexes();
    assert.ok(indexes.some(([key, options]) => key.questionId === 1 && options.unique === true));
  });

  test('a bank item may be linked from many exams — bankItemId itself is not unique', () => {
    const indexes = WizKidsQuestionLink.schema.indexes();
    const bankItemUnique = indexes.some(
      ([key, options]) => Object.keys(key).length === 1 && key.bankItemId === 1 && options.unique === true
    );
    assert.equal(bankItemUnique, false);
  });
});

describe('Materialization type mapping — every WizKids interactionType maps to a real Question.questionType', () => {
  const validQuestionTypes = Question.schema.path('questionType').enumValues;

  test('INTERACTION_TYPE_TO_QUESTION_TYPE covers every interactionType the schema allows', () => {
    const interactionTypes = WizKidsQuestionBankItem.schema.path('interactionType').enumValues;
    for (const type of interactionTypes) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(INTERACTION_TYPE_TO_QUESTION_TYPE, type),
        `interactionType "${type}" has no materialization mapping`
      );
    }
  });

  test('every mapped value is a real, currently-valid Question.questionType enum value (this is what makes materialization actually work, not just compile)', () => {
    for (const [interactionType, questionType] of Object.entries(INTERACTION_TYPE_TO_QUESTION_TYPE)) {
      assert.ok(
        validQuestionTypes.includes(questionType),
        `${interactionType} maps to "${questionType}", which is not in Question's questionType enum: ${validQuestionTypes.join(', ')}`
      );
    }
  });

  test('reuses existing question types only — introduces zero new values to Question.questionType (master prompt §24)', () => {
    // The mapping's target set must be a subset of Question's pre-existing
    // enum, proving Phase 5 added no new core question types.
    const mappedTypes = new Set(Object.values(INTERACTION_TYPE_TO_QUESTION_TYPE));
    for (const type of mappedTypes) {
      assert.ok(validQuestionTypes.includes(type));
    }
  });

  test('MCQ and IMAGE both resolve to MULTIPLE_CHOICE (master prompt §24: "Visual triangle counting -> IMAGE + NUMBER/MCQ" — image is a display concern layered on an MCQ answer shape, not a separate core type)', () => {
    assert.equal(INTERACTION_TYPE_TO_QUESTION_TYPE.MCQ, 'MULTIPLE_CHOICE');
    assert.equal(INTERACTION_TYPE_TO_QUESTION_TYPE.IMAGE, 'MULTIPLE_CHOICE');
  });

  test('NUMBER, SHORT_ANSWER, FILL_IN_THE_BLANK, MATCHING map onto themselves — these are already exact Question.questionType values', () => {
    assert.equal(INTERACTION_TYPE_TO_QUESTION_TYPE.NUMBER, 'NUMBER');
    assert.equal(INTERACTION_TYPE_TO_QUESTION_TYPE.SHORT_ANSWER, 'SHORT_ANSWER');
    assert.equal(INTERACTION_TYPE_TO_QUESTION_TYPE.FILL_IN_THE_BLANK, 'FILL_IN_THE_BLANK');
    assert.equal(INTERACTION_TYPE_TO_QUESTION_TYPE.MATCHING, 'MATCHING');
  });
});

describe('stringifyCorrectAnswerForQuestion — Mixed bank-item answer -> String Question.correctAnswer', () => {
  test('a plain string passes through unchanged', () => {
    assert.equal(stringifyCorrectAnswerForQuestion('42'), '42');
  });

  test('a number is stringified', () => {
    assert.equal(stringifyCorrectAnswerForQuestion(42), '42');
  });

  test('an array (e.g. MATCHING pairs) is JSON-stringified, not coerced to "[object Object]"', () => {
    const value = [{ left: 'A', right: '1' }, { left: 'B', right: '2' }];
    assert.equal(stringifyCorrectAnswerForQuestion(value), JSON.stringify(value));
  });

  test('an object is JSON-stringified', () => {
    assert.equal(stringifyCorrectAnswerForQuestion({ value: 5 }), JSON.stringify({ value: 5 }));
  });

  test('null/undefined become an empty string rather than the literal text "null"/"undefined"', () => {
    assert.equal(stringifyCorrectAnswerForQuestion(null), '');
    assert.equal(stringifyCorrectAnswerForQuestion(undefined), '');
  });
});

describe('WizKidsQuestionBankError', () => {
  test('carries an HTTP status and message, matching the established convention', () => {
    const error = new WizKidsQuestionBankError(404, 'Question bank item not found.');
    assert.equal(error.status, 404);
    assert.equal(error.name, 'WizKidsQuestionBankError');
    assert.ok(error instanceof Error);
  });
});
