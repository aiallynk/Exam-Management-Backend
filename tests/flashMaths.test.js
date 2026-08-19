import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import User from '../models/User.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import WizKidsFlashRound from '../models/WizKidsFlashRound.js';
import WizKidsFlashAttemptState from '../models/WizKidsFlashAttemptState.js';
import { buildCandidateFlashState, generateFlashSequence, isFlashQuestionSubmitted } from '../services/wizKidsFlashMathsService.js';
import { buildFlashMetrics } from '../services/wizKidsAnalyticsService.js';
import { generateJuniorDeterministicNumberQuestions } from '../services/juniorAiQuestionService.js';

const baseConfig = { configVersion: 1, difficulty: 'MEDIUM', operationMode: 'ADDITION', operandCount: 6, minimumDigits: 1, maximumDigits: 2, flashDurationMs: 500, gapDurationMs: 100, answerWindowMs: 10000, negativeIntermediateAllowed: false };
const calculate = ({ operands, operators }) => operators.reduce((total, operator, index) => operator === '-' ? total - operands[index + 1] : total + operands[index + 1], operands[0]);

test('Flash Maths generation replays from config/version/seed and respects shape constraints', () => {
  const first = generateFlashSequence({ config: baseConfig, seed: 'stable-seed' });
  assert.deepEqual(generateFlashSequence({ config: { ...baseConfig }, seed: 'stable-seed' }), first);
  assert.equal(first.operands.length, baseConfig.operandCount);
  assert.equal(first.operators.length, baseConfig.operandCount - 1);
  assert.ok(first.operands.every((value) => value >= 1 && value <= 99));
  assert.equal(first.answer, calculate(first));
});

for (const operationMode of ['ADDITION', 'SUBTRACTION', 'ADD_SUB_MIXED']) {
  test(`Flash Maths ${operationMode} answer is deterministic without forbidden negative intermediates`, () => {
    const generated = generateFlashSequence({ config: { ...baseConfig, operationMode, operandCount: 12 }, seed: `seed-${operationMode}` });
    let total = generated.operands[0];
    generated.operators.forEach((operator, index) => { total = operator === '-' ? total - generated.operands[index + 1] : total + generated.operands[index + 1]; assert.ok(total >= 0); });
    assert.equal(generated.answer, total);
    if (operationMode === 'ADDITION') assert.ok(generated.operators.every((operator) => operator === '+'));
  });
}

test('candidate Flash payload contains one item and no answer, solution, seed, or sequence', () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');
  const round = { questionId: { _id: 'question-1', order: 0 }, operands: [25, 14, 7], operators: ['+', '-'], flashDurationMs: 500, gapDurationMs: 100, answerWindowMs: 10000 };
  const state = { currentQuestionId: 'question-1', roundStartedAt: startedAt, submittedQuestionIds: [] };
  const payload = buildCandidateFlashState({ state, rounds: [round], config: { mode: 'TEST' }, now: new Date(startedAt.getTime() + 650) });
  assert.deepEqual(payload.round.currentItem, { value: 14, operator: '+', index: 1 });
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['operands', 'operators', 'correctAnswer', 'solution', 'seed']) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(buildCandidateFlashState({ state, rounds: [round], config: { mode: 'TEST' }, now: new Date(startedAt.getTime() + 650) }), payload);
});

test('candidate Flash payload opens answering only after all value and gap cycles', () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');
  const round = { questionId: { _id: 'question-1', order: 0 }, operands: [2, 3], operators: ['+'], flashDurationMs: 500, gapDurationMs: 100, answerWindowMs: 10000 };
  const payload = buildCandidateFlashState({ state: { currentQuestionId: 'question-1', roundStartedAt: startedAt, submittedQuestionIds: [] }, rounds: [round], config: { mode: 'TEST' }, now: new Date(startedAt.getTime() + 1200) });
  assert.equal(payload.phase, 'ANSWER');
  assert.equal(payload.round.currentItem, null);
});

test('candidate Flash payload holds on ANSWERED phase with feedback, no leaked fields, and does not drift with time until advanced', () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');
  const roundOne = { questionId: { _id: 'question-1', order: 0 }, operands: [25, 14], operators: ['+'], flashDurationMs: 500, gapDurationMs: 100, answerWindowMs: 10000 };
  const roundTwo = { questionId: { _id: 'question-2', order: 1 }, operands: [8, 3], operators: ['-'], flashDurationMs: 500, gapDurationMs: 100, answerWindowMs: 10000 };
  const state = {
    currentQuestionId: 'question-1',
    roundStartedAt: startedAt,
    submittedQuestionIds: ['question-1'],
    roundTimings: [{ questionId: 'question-1', startedAt, answerOpenedAt: startedAt, submittedAt: startedAt, responseTimeMs: 1200, isCorrect: true, timedOut: false }],
  };
  const payload = buildCandidateFlashState({ state, rounds: [roundOne, roundTwo], config: { mode: 'TEST' }, now: startedAt });
  assert.equal(payload.phase, 'ANSWERED');
  assert.deepEqual(payload.feedback, { isCorrect: true, timedOut: false });
  assert.equal(payload.round.currentItem, null);
  assert.equal(payload.isLastRound, false);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['operands', 'operators', 'correctAnswer', 'solution', 'seed']) assert.equal(serialized.includes(forbidden), false);
  // Elapsed time alone must never move the state off ANSWERED — only an explicit advance call does.
  assert.deepEqual(buildCandidateFlashState({ state, rounds: [roundOne, roundTwo], config: { mode: 'TEST' }, now: new Date(startedAt.getTime() + 60000) }), payload);
});

test('Flash feedback is present in TEST mode too (no longer Practice-only) and isLastRound is set on the final round', () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');
  const round = { questionId: { _id: 'question-1', order: 0 }, operands: [10, 2], operators: ['+'], flashDurationMs: 500, gapDurationMs: 100, answerWindowMs: 10000 };
  const state = {
    currentQuestionId: 'question-1',
    roundStartedAt: startedAt,
    submittedQuestionIds: ['question-1'],
    roundTimings: [{ questionId: 'question-1', startedAt, answerOpenedAt: startedAt, submittedAt: startedAt, responseTimeMs: 900, isCorrect: false, timedOut: false }],
  };
  const payload = buildCandidateFlashState({ state, rounds: [round], config: { mode: 'TEST' }, now: startedAt });
  assert.equal(payload.phase, 'ANSWERED');
  assert.deepEqual(payload.feedback, { isCorrect: false, timedOut: false });
  assert.equal(payload.isLastRound, true);
});

test('Flash "next" advance route and sequence-uniqueness retry exist and are guarded', () => {
  const routeSource = readFileSync(new URL('../routes/wizKidsFlashMaths.js', import.meta.url), 'utf8');
  const serviceSource = readFileSync(new URL('../services/wizKidsFlashMathsService.js', import.meta.url), 'utf8');
  assert.match(routeSource, /attempts\/:attemptId\/next/);
  assert.match(routeSource, /advanceFlashRound/);
  assert.match(serviceSource, /export const advanceFlashRound/);
  assert.match(serviceSource, /Answer the current Flash Maths round before moving on\./);
  assert.match(serviceSource, /MAX_FLASH_SEQUENCE_RETRIES/);
  assert.match(serviceSource, /fingerprintFlashSequence/);
});

test('duplicate Flash submissions are recognized before scoring', () => {
  assert.equal(isFlashQuestionSubmitted({ submittedQuestionIds: ['one'] }, 'one'), true);
  assert.equal(isFlashQuestionSubmitted({ submittedQuestionIds: ['one'] }, 'two'), false);
});

test('Flash schemas stay isolated and unique per core question or attempt', () => {
  assert.equal(WizKidsExamConfig.schema.path('interactionMode').enumValues.includes('FLASH_MATHS'), true);
  assert.equal(WizKidsExamConfig.schema.path('flashMaths.difficulty').enumValues.includes('ULTRA_HARD'), true);
  assert.ok(WizKidsFlashRound.schema.indexes().some(([fields, options]) => fields.questionId === 1 && options.unique));
  assert.ok(WizKidsFlashAttemptState.schema.indexes().some(([fields, options]) => fields.attemptId === 1 && options.unique));
});

test('Flash analytics are derived and do not calculate academic marks', () => {
  const metrics = buildFlashMetrics({ states: [{ roundTimings: [{ questionId: 'q1', responseTimeMs: 2000, isCorrect: true }, { questionId: 'q2', responseTimeMs: 4000, isCorrect: false }] }], rounds: [{ questionId: 'q1', operationMode: 'ADDITION', operands: [2, 3, 4], flashDurationMs: 500, gapDurationMs: 100 }, { questionId: 'q2', operationMode: 'ADDITION', operands: [20, 30, 40], flashDurationMs: 500, gapDurationMs: 100 }] });
  assert.equal(metrics.attempted, 2); assert.equal(metrics.accuracy, 50); assert.equal(metrics.averageResponseTime, 3);
  assert.equal(Object.hasOwn(metrics, 'score'), false); assert.equal(Object.hasOwn(metrics, 'marks'), false);
});

test('Junior AI numeric adapter is deterministic and records replay provenance', () => {
  const input = { count: 3, difficulty: 'medium', juniorContext: { gradeLevel: 4, domains: ['MENTAL_MATHS'] }, topic: 'addition', seedBase: 'junior-ai-seed' };
  const first = generateJuniorDeterministicNumberQuestions(input);
  assert.deepEqual(generateJuniorDeterministicNumberQuestions(input), first);
  assert.equal(first.length, 3);
  assert.ok(first.every((question) => question.questionType === 'NUMBER' && question.generatorMetadata?.seed));
});

test('Candidate academic profile is optional and constrained to Grades 1-7', () => {
  assert.equal(User.schema.path('academicProfile.gradeLevel').options.min, 1);
  assert.equal(User.schema.path('academicProfile.gradeLevel').options.max, 7);
  const candidate = new User({ name: 'Candidate', email: 'candidate@example.com', password: 'not-hashed-here', role: 'CANDIDATE' });
  assert.equal(candidate.academicProfile?.gradeLevel ?? null, null);
});

test('Flash routes are tenant, role, product, interaction, and capability guarded', () => {
  const routeSource = readFileSync(new URL('../routes/wizKidsFlashMaths.js', import.meta.url), 'utf8');
  const serviceSource = readFileSync(new URL('../services/wizKidsFlashMathsService.js', import.meta.url), 'utf8');
  assert.match(routeSource, /requireAuth, requireTenant, requireTenantFeature\('WIZKIDS'\), requireTenantFeature\('WIZKIDS_SPEED_MODE'\)/);
  assert.match(routeSource, /requireRole\('CANDIDATE'\)/);
  assert.match(serviceSource, /ExamAttempt\.findOne\(\{ _id: attemptId, tenantId, userId \}\)/);
  assert.match(serviceSource, /productModule: 'WIZKIDS'/);
  assert.match(serviceSource, /interactionMode !== 'FLASH_MATHS'/);
});

test('candidate question delivery discloses Flash Maths interaction type without leaking evaluationConfig/correctAnswer', () => {
  const questionsSource = readFileSync(new URL('../routes/questions.js', import.meta.url), 'utf8');
  assert.match(questionsSource, /const \{ correctAnswer, evaluationConfig, matchingPairs, options, \.\.\.candidateQuestion \} = serializedQuestion;/);
  assert.match(questionsSource, /evaluationConfig\?\.flashMaths \? \{ interactionType: 'FLASH_MATHS' \} : \{\}/);
});

test('generic exam submission completes Flash Maths (mixed-paper) attempts deterministically, not just STANDARD WizKids attempts', () => {
  const completionSource = readFileSync(new URL('../services/wizKidsCompletionService.js', import.meta.url), 'utf8');
  const flashServiceSource = readFileSync(new URL('../services/wizKidsFlashMathsService.js', import.meta.url), 'utf8');
  const attemptsSource = readFileSync(new URL('../routes/attempts.js', import.meta.url), 'utf8');
  // assertCompletableAttempt must accept an array of expected interaction modes, mirroring
  // the existing expectedMode array support, so both plain and Flash-configured WizKids
  // exams can complete through the same generic submit path.
  assert.match(completionSource, /const expectedInteractionModes = Array\.isArray\(expectedInteractionMode\) \? expectedInteractionMode : \[expectedInteractionMode\];/);
  assert.match(completionSource, /expectedInteractionModes\.includes\(String\(config\.interactionMode \|\| 'STANDARD'\)\)/);
  // The dedicated Flash completion endpoint keeps its own narrow guard.
  assert.match(flashServiceSource, /expectedInteractionMode: 'FLASH_MATHS'/);
  // The generic /exams/submit handler must widen its own request to allow FLASH_MATHS,
  // not just STANDARD, so a Flash question rendered inside the normal Take Exam page can
  // still be submitted (previously this threw a 403 before scoring even started).
  assert.match(attemptsSource, /expectedInteractionMode: \['STANDARD', 'FLASH_MATHS'\]/);
});
