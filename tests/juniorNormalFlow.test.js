import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JUNIOR_ALLOWED_QUESTION_TYPES,
  findUnsupportedJuniorQuestionType,
  isJuniorQuestionTypeAllowed,
} from '../utils/juniorQuestionPolicy.js';
import { DOMAIN_TO_CAPABILITY } from '../services/wizKidsExamService.js';

test('Junior normal-flow policy allows the approved core question types', () => {
  assert.deepEqual(JUNIOR_ALLOWED_QUESTION_TYPES, [
    'MULTIPLE_CHOICE',
    'MULTIPLE_OPTIONS',
    'TRUE_FALSE',
    'SHORT_ANSWER',
    'FILL_IN_THE_BLANK',
    'MATCHING',
    'NUMBER',
    'IMAGE_BASED',
  ]);
  assert.equal(isJuniorQuestionTypeAllowed('NUMBER'), true);
  assert.equal(isJuniorQuestionTypeAllowed('ESSAY'), false);
  assert.equal(isJuniorQuestionTypeAllowed('CODING'), false);
});

test('Junior normal-flow policy reports direct-API unsuitable types', () => {
  assert.equal(findUnsupportedJuniorQuestionType(['NUMBER', 'CODING']), 'CODING');
  assert.equal(findUnsupportedJuniorQuestionType(['MULTIPLE_CHOICE', 'MATCHING']), null);
});

test('every selectable Junior domain has an independent capability gate', () => {
  assert.deepEqual(Object.keys(DOMAIN_TO_CAPABILITY).sort(), [
    'LOGIC',
    'MENTAL_MATHS',
    'OLYMPIAD',
    'SUPER_MATHS',
    'VEDIC_MATHS',
  ]);
  Object.values(DOMAIN_TO_CAPABILITY).forEach((featureKey) => {
    assert.match(featureKey, /^WIZKIDS_/);
  });
});

