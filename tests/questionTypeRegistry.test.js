import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getQuestionTypeDefinition,
  normalizeQuestionType,
  validateGeneratedQuestionShape,
  computeDistributionDiagnostics,
} from '../utils/questionTypeRegistry.js';
import { normalizeQuestionCorrectAnswer, parseNumericAnswer } from '../utils/questionOptionSanitizer.js';

describe('normalizeQuestionType — alias resolution', () => {
  test('resolves canonical snake_case ids from the master requirement', () => {
    assert.equal(normalizeQuestionType('multiple_select'), 'MULTIPLE_OPTIONS');
    assert.equal(normalizeQuestionType('numeric'), 'NUMBER');
    assert.equal(normalizeQuestionType('single_choice'), 'MULTIPLE_CHOICE');
    assert.equal(normalizeQuestionType('true_false'), 'TRUE_FALSE');
    assert.equal(normalizeQuestionType('fill_blank'), 'FILL_IN_THE_BLANK');
  });

  test('resolves legacy/alternate spellings', () => {
    assert.equal(normalizeQuestionType('mcq'), 'MULTIPLE_CHOICE');
    assert.equal(normalizeQuestionType('MCQ'), 'MULTIPLE_CHOICE');
    assert.equal(normalizeQuestionType('Multi Select MCQ'), 'MULTIPLE_OPTIONS');
    assert.equal(normalizeQuestionType('numerical'), 'NUMBER');
    assert.equal(normalizeQuestionType('NUMERIC'), 'NUMBER');
  });

  test('resolves the already-canonical backend enum values to themselves', () => {
    assert.equal(normalizeQuestionType('MULTIPLE_OPTIONS'), 'MULTIPLE_OPTIONS');
    assert.equal(normalizeQuestionType('NUMBER'), 'NUMBER');
  });

  test('multiple_select must never resolve to single_choice', () => {
    assert.notEqual(normalizeQuestionType('multiple_select'), normalizeQuestionType('single_choice'));
  });

  test('numeric must never resolve to single_choice / MULTIPLE_CHOICE', () => {
    assert.notEqual(normalizeQuestionType('numeric'), 'MULTIPLE_CHOICE');
  });

  test('unknown values resolve to null, never silently to MCQ', () => {
    assert.equal(normalizeQuestionType('totally_unknown_type_xyz'), null);
    assert.notEqual(normalizeQuestionType('totally_unknown_type_xyz'), 'MULTIPLE_CHOICE');
  });

  test('unknown/empty input returns null', () => {
    assert.equal(normalizeQuestionType(''), null);
    assert.equal(normalizeQuestionType(null), null);
    assert.equal(normalizeQuestionType(undefined), null);
  });
});

describe('validateGeneratedQuestionShape', () => {
  test('MULTIPLE_OPTIONS with 2+ correct answers is valid', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'MULTIPLE_OPTIONS',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: ['A', 'C'],
    });
    assert.equal(result.valid, true);
  });

  test('MULTIPLE_OPTIONS with only 1 correct answer is invalid (must not behave like single_choice)', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'MULTIPLE_OPTIONS',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: ['A'],
    });
    assert.equal(result.valid, false);
  });

  test('MULTIPLE_OPTIONS with a scalar (non-array) correctAnswer is invalid', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'MULTIPLE_OPTIONS',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: 'A',
    });
    assert.equal(result.valid, false);
  });

  test('MULTIPLE_OPTIONS with fewer than 2 options is invalid', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'MULTIPLE_OPTIONS',
      options: ['A'],
      correctAnswer: ['A'],
    });
    assert.equal(result.valid, false);
  });

  test('NUMBER with a numeric correctAnswer and no options is valid', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'NUMBER',
      correctAnswer: '42',
    });
    assert.equal(result.valid, true);
  });

  test('NUMBER with a non-numeric correctAnswer is invalid (must not silently pass as MCQ text)', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'NUMBER',
      correctAnswer: 'Option A',
    });
    assert.equal(result.valid, false);
  });

  test('NUMBER with an options array present is invalid', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'NUMBER',
      options: ['Option A', 'Option B'],
      correctAnswer: '42',
    });
    assert.equal(result.valid, false);
  });

  test('MULTIPLE_CHOICE with fewer than 2 options is invalid', () => {
    const result = validateGeneratedQuestionShape({
      questionType: 'MULTIPLE_CHOICE',
      options: ['Only one'],
      correctAnswer: 'Only one',
    });
    assert.equal(result.valid, false);
  });

  test('unknown question type is invalid', () => {
    const result = validateGeneratedQuestionShape({ questionType: 'NOT_A_REAL_TYPE', correctAnswer: 'x' });
    assert.equal(result.valid, false);
  });
});

describe('parseNumericAnswer / normalizeQuestionCorrectAnswer(NUMBER)', () => {
  test('extracts a plain number', () => {
    assert.equal(parseNumericAnswer('42'), '42');
  });

  test('extracts a decimal number', () => {
    assert.equal(parseNumericAnswer('3.14'), '3.14');
  });

  test('extracts a negative number', () => {
    assert.equal(parseNumericAnswer('-7.5'), '-7.5');
  });

  test('extracts a number embedded in text (e.g. with a unit)', () => {
    assert.equal(parseNumericAnswer('42 cm'), '42');
  });

  test('returns empty string for non-numeric text (never passes MCQ-shaped text through)', () => {
    assert.equal(parseNumericAnswer('Option A'), '');
    assert.equal(parseNumericAnswer('True'), '');
  });

  test('normalizeQuestionCorrectAnswer routes NUMBER through numeric parsing', () => {
    assert.equal(
      normalizeQuestionCorrectAnswer({ questionType: 'NUMBER', correctAnswer: '42', options: [] }),
      '42'
    );
    assert.equal(
      normalizeQuestionCorrectAnswer({ questionType: 'NUMBER', correctAnswer: 'Option A', options: [] }),
      ''
    );
  });
});

describe('computeDistributionDiagnostics', () => {
  const makeQuestions = (spec) => {
    const questions = [];
    Object.entries(spec).forEach(([type, count]) => {
      for (let i = 0; i < count; i += 1) questions.push({ questionType: type });
    });
    return questions;
  };

  test('reports valid when generated matches requested exactly (the reported 3 multiple_select + 2 numeric case)', () => {
    const requested = [{ type: 'multiple_select', count: 3 }, { type: 'numeric', count: 2 }];
    const generated = makeQuestions({ MULTIPLE_OPTIONS: 3, NUMBER: 2 });
    const result = computeDistributionDiagnostics(requested, generated);
    assert.deepEqual(result.requested, { MULTIPLE_OPTIONS: 3, NUMBER: 2 });
    assert.deepEqual(result.generated, { MULTIPLE_OPTIONS: 3, NUMBER: 2 });
    assert.equal(result.validationStatus, 'valid');
  });

  test('reports mismatch when everything collapsed to one type (the reported defect)', () => {
    const requested = [{ type: 'multiple_select', count: 3 }, { type: 'numeric', count: 2 }];
    const generated = makeQuestions({ MULTIPLE_CHOICE: 5 });
    const result = computeDistributionDiagnostics(requested, generated);
    assert.equal(result.validationStatus, 'mismatch');
  });

  test('reports mismatch when counts are close but not exact', () => {
    const requested = [{ type: 'multiple_select', count: 3 }, { type: 'numeric', count: 2 }];
    const generated = makeQuestions({ MULTIPLE_OPTIONS: 4, NUMBER: 1 });
    const result = computeDistributionDiagnostics(requested, generated);
    assert.equal(result.validationStatus, 'mismatch');
  });

  test('reports mismatch when an unexpected type appears', () => {
    const requested = [{ type: 'multiple_select', count: 3 }, { type: 'numeric', count: 2 }];
    const generated = makeQuestions({ MULTIPLE_OPTIONS: 3, NUMBER: 1, TRUE_FALSE: 1 });
    const result = computeDistributionDiagnostics(requested, generated);
    assert.equal(result.validationStatus, 'mismatch');
  });

  test('reports unspecified when no distribution was requested', () => {
    const result = computeDistributionDiagnostics([], makeQuestions({ MULTIPLE_CHOICE: 5 }));
    assert.equal(result.validationStatus, 'unspecified');
  });
});
