import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WizKidsPracticeCheck from '../models/WizKidsPracticeCheck.js';
import {
  PRACTICE_SUPPORTED_QUESTION_TYPES,
  checkAnswerCorrectness,
  evaluatePracticeModeGate,
  WizKidsPracticeError,
} from '../services/wizKidsPracticeService.js';

// WizKids Phase 7 — Practice Mode.
// Covers: DOCS/XAMIGO_WIZKIDS_MASTER_DEVELOPMENT_PROMPT.md §30/§54 Phase 7,
// including the explicitly-required critical security test: "Standard
// exams must never successfully access or invoke the Practice
// answer-checking behavior." Same pure-logic/schema-introspection
// convention as Phases 1-6 (no live-database infrastructure in this repo).

describe('CRITICAL SECURITY TEST — standard exams can never pass the Practice answer-checking gate', () => {
  test('a STANDARD-module exam is rejected regardless of any other favorable state (mode=PRACTICE, capability enabled)', () => {
    // Every other input is deliberately set to the MOST permissive possible
    // value — if the gate were broken, this is exactly the combination that
    // would slip through. It must not.
    const gate = evaluatePracticeModeGate({
      exam: { productModule: 'STANDARD' },
      config: { mode: 'PRACTICE' },
      practiceFeatureEnabled: true,
    });
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /only available for WizKids exams/i);
  });

  test('a missing exam (null/undefined) is rejected, not treated as an open default', () => {
    assert.equal(evaluatePracticeModeGate({ exam: null, config: null, practiceFeatureEnabled: true }).allowed, false);
    assert.equal(evaluatePracticeModeGate({ config: null, practiceFeatureEnabled: true }).allowed, false);
  });

  test('a WizKids exam in TEST/OLYMPIAD/WORKSHEET/COMPETITION mode (i.e. any non-PRACTICE mode) is rejected — instant feedback must never leak into a real assessment', () => {
    for (const mode of ['TEST', 'OLYMPIAD', 'WORKSHEET', 'COMPETITION']) {
      const gate = evaluatePracticeModeGate({
        exam: { productModule: 'WIZKIDS' },
        config: { mode },
        practiceFeatureEnabled: true,
      });
      assert.equal(gate.allowed, false, `mode ${mode} must not pass the Practice gate`);
      assert.match(gate.reason, /only available in Practice mode/i);
    }
  });

  test('a WizKids Practice-mode exam is still rejected if the WIZKIDS_PRACTICE capability is not effectively enabled for the tenant', () => {
    const gate = evaluatePracticeModeGate({
      exam: { productModule: 'WIZKIDS' },
      config: { mode: 'PRACTICE' },
      practiceFeatureEnabled: false,
    });
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /WIZKIDS_PRACTICE capability is not enabled/i);
  });

  test('the gate opens only when all three conditions hold simultaneously (master prompt §30)', () => {
    const gate = evaluatePracticeModeGate({
      exam: { productModule: 'WIZKIDS' },
      config: { mode: 'PRACTICE' },
      practiceFeatureEnabled: true,
    });
    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, '');
  });
});

describe('checkAnswerCorrectness — instant right/wrong feedback per question type', () => {
  test('MULTIPLE_CHOICE — case/whitespace-insensitive exact match', () => {
    const question = { questionType: 'MULTIPLE_CHOICE', correctAnswer: 'Paris' };
    assert.equal(checkAnswerCorrectness(question, 'Paris'), true);
    assert.equal(checkAnswerCorrectness(question, '  paris  '), true);
    assert.equal(checkAnswerCorrectness(question, 'London'), false);
  });

  test('NUMBER — numeric comparison via the existing parseNumericAnswer utility, tolerant of surrounding text/units', () => {
    const question = { questionType: 'NUMBER', correctAnswer: '42' };
    assert.equal(checkAnswerCorrectness(question, '42'), true);
    assert.equal(checkAnswerCorrectness(question, '42.0'), true);
    assert.equal(checkAnswerCorrectness(question, 'the answer is 42'), true);
    assert.equal(checkAnswerCorrectness(question, '43'), false);
  });

  test('NUMBER — non-numeric submitted text is incorrect, not a crash', () => {
    const question = { questionType: 'NUMBER', correctAnswer: '42' };
    assert.equal(checkAnswerCorrectness(question, 'not a number'), false);
  });

  test('SHORT_ANSWER and FILL_IN_THE_BLANK use the same case/whitespace-insensitive comparison', () => {
    assert.equal(checkAnswerCorrectness({ questionType: 'SHORT_ANSWER', correctAnswer: 'Photosynthesis' }, 'photosynthesis'), true);
    assert.equal(checkAnswerCorrectness({ questionType: 'FILL_IN_THE_BLANK', correctAnswer: 'seven' }, ' Seven '), true);
  });

  test('MATCHING — deep-equal comparison of pair structures, not string equality', () => {
    const pairs = [{ left: 'A', right: '1' }, { left: 'B', right: '2' }];
    const question = { questionType: 'MATCHING', correctAnswer: JSON.stringify(pairs) };
    assert.equal(checkAnswerCorrectness(question, JSON.stringify(pairs)), true);
    assert.equal(checkAnswerCorrectness(question, JSON.stringify(pairs.slice().reverse())), false);
  });

  test('MATCHING — malformed JSON submission is incorrect, not a thrown exception', () => {
    const question = { questionType: 'MATCHING', correctAnswer: JSON.stringify([{ left: 'A', right: '1' }]) };
    assert.equal(checkAnswerCorrectness(question, '{not valid json'), false);
  });

  test('an unsupported question type (e.g. ESSAY, CODING) returns null, not a false "incorrect"', () => {
    assert.equal(checkAnswerCorrectness({ questionType: 'ESSAY', correctAnswer: 'x' }, 'x'), null);
    assert.equal(checkAnswerCorrectness({ questionType: 'CODING', correctAnswer: '' }, 'code'), null);
  });
});

describe('PRACTICE_SUPPORTED_QUESTION_TYPES matches exactly what checkAnswerCorrectness actually handles', () => {
  test('every listed type returns a real boolean from checkAnswerCorrectness, never null', () => {
    for (const type of PRACTICE_SUPPORTED_QUESTION_TYPES) {
      const result = checkAnswerCorrectness({ questionType: type, correctAnswer: type === 'MATCHING' ? '[]' : 'x' }, type === 'MATCHING' ? '[]' : 'x');
      assert.notEqual(result, null, `${type} is listed as supported but checkAnswerCorrectness returned null for it`);
    }
  });

  test('is exactly the five objective types materializeQuestion can produce (Phase 5) — no subjective/coding types', () => {
    assert.deepEqual(
      [...PRACTICE_SUPPORTED_QUESTION_TYPES].sort(),
      ['FILL_IN_THE_BLANK', 'MATCHING', 'MULTIPLE_CHOICE', 'NUMBER', 'SHORT_ANSWER']
    );
  });
});

describe('WizKidsPracticeCheck schema — append-only attempt history', () => {
  test('required fields enforce full traceability: tenant, attempt, exam, question, user, correctness', () => {
    for (const field of ['tenantId', 'attemptId', 'examId', 'questionId', 'userId', 'isCorrect']) {
      const path = WizKidsPracticeCheck.schema.path(field);
      assert.ok(path, `${field} must exist on the schema`);
      assert.equal(path.isRequired, true, `${field} must be required`);
    }
  });

  test('no unique index forces one check per question — a student may retry and check the same question multiple times', () => {
    const indexes = WizKidsPracticeCheck.schema.indexes();
    const hasUniqueQuestionConstraint = indexes.some(
      ([key, options]) => key.attemptId === 1 && key.questionId === 1 && options.unique === true
    );
    assert.equal(hasUniqueQuestionConstraint, false);
  });
});

describe('WizKidsPracticeError', () => {
  test('carries an HTTP status and message, matching the established convention', () => {
    const error = new WizKidsPracticeError(403, 'The WIZKIDS_PRACTICE capability is not enabled for this tenant.');
    assert.equal(error.status, 403);
    assert.equal(error.name, 'WizKidsPracticeError');
    assert.ok(error instanceof Error);
  });
});
