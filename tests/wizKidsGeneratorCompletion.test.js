import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDeterministicQuestion, INITIAL_TEMPLATE_DEFINITIONS } from '../services/wizKidsQuestionGeneratorService.js';
import { scoreWizKidsObjectiveAnswer } from '../services/wizKidsCompletionService.js';

const template = (strategy, overrides = {}) => ({
  _id: '64b64c0f8d0f0d0f0d0f0d01',
  templateKey: `TEST_${strategy}`,
  version: 1,
  domain: 'MENTAL_MATHS',
  gradeLevel: 4,
  strategy,
  rules: {},
  ...overrides,
});

test('WizKids deterministic generator replays exactly from template version and seed', () => {
  const source = template('ARITHMETIC', { rules: { operation: 'ADDITION', digits: { minimum: 2, maximum: 2 }, carry: { allowed: true } } });
  const first = generateDeterministicQuestion({ template: source, seed: 'tenant-a/assignment-1/question-3' });
  const replay = generateDeterministicQuestion({ template: source, seed: 'tenant-a/assignment-1/question-3' });
  const changed = generateDeterministicQuestion({ template: source, seed: 'tenant-a/assignment-1/question-4' });
  assert.deepEqual(first, replay);
  assert.notEqual(first.questionContent, changed.questionContent);
  assert.equal(first.generatorMetadata.templateVersion, 1);
  assert.equal(first.generatorMetadata.seed, 'tenant-a/assignment-1/question-3');
  const [left, right] = first.questionContent.split(' + ').map(Number);
  assert.ok((left % 10) + (right % 10) >= 10, 'carry-required addition must carry in the units column');
});

test('initial deterministic templates are finite, non-AI strategies and generate complete question-bank shapes', () => {
  assert.ok(INITIAL_TEMPLATE_DEFINITIONS.length >= 10);
  for (const definition of INITIAL_TEMPLATE_DEFINITIONS) {
    const generated = generateDeterministicQuestion({ template: template(definition.strategy, definition), seed: 'stable-seed' });
    assert.ok(generated.questionContent);
    assert.notEqual(generated.correctAnswer, '');
    assert.ok(['NUMBER', 'MCQ'].includes(generated.interactionType));
    assert.equal(generated.generatorMetadata.strategy, definition.strategy);
  }
});

test('logic odd-one-out is deterministic MCQ content with a correct generated option', () => {
  const generated = generateDeterministicQuestion({ template: template('LOGIC_ODD_ONE_OUT', { domain: 'LOGIC' }), seed: 'logic-01' });
  assert.equal(generated.interactionType, 'MCQ');
  assert.equal(generated.options.length, 4);
  assert.ok(generated.options.includes(generated.correctAnswer));
});

test('WizKids completion scores only objective answers without semantic or AI evaluation', () => {
  assert.deepEqual(
    scoreWizKidsObjectiveAnswer({ question: { questionType: 'NUMBER', correctAnswer: '24' }, answer: '24 apples' }),
    { supported: true, isCorrect: true }
  );
  assert.deepEqual(
    scoreWizKidsObjectiveAnswer({ question: { questionType: 'MULTIPLE_CHOICE', correctAnswer: 'Blue' }, answer: ' blue ' }),
    { supported: true, isCorrect: true }
  );
  assert.deepEqual(
    scoreWizKidsObjectiveAnswer({ question: { questionType: 'MATCHING', correctAnswer: '[{"left":"A","right":"1"}]' }, answer: '[{"left":"A","right":"1"}]' }),
    { supported: true, isCorrect: true }
  );
  assert.deepEqual(
    scoreWizKidsObjectiveAnswer({ question: { questionType: 'ESSAY', correctAnswer: 'x' }, answer: 'x' }),
    { supported: false, isCorrect: false }
  );
});
