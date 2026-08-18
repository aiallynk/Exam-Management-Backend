import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateWithNoveltyAndGrounding } from '../services/candidatePoolOrchestratorService.js';

const makeQuestion = (type, id) => {
  const base = {
    questionText: `unique-${id}`,
    questionType: type,
    correctAnswer: `answer-${id}`,
    retrievedChunksForValidation: [{ _id: `chunk-${id}`, text: `evidence-${id}` }],
  };
  if (type === 'MULTIPLE_CHOICE') {
    return { ...base, options: [`answer-${id}`, `other-${id}`] };
  }
  if (type === 'MULTIPLE_OPTIONS') {
    return {
      ...base,
      options: [`answer-${id}`, `second-${id}`, `other-${id}`],
      correctAnswer: [`answer-${id}`, `second-${id}`],
    };
  }
  return base;
};

const buildQuestions = (type, count, prefix) =>
  Array.from({ length: count }, (_, index) => makeQuestion(type, `${prefix}-${index}`));

const alwaysGrounded = async () => ({ grounded: true });
const alwaysNovel = async () => ({ likelyDuplicate: false });
const reserveAlways = async ({ question }) => ({
  novel: true,
  exactSignature: `exact-${question.questionText}`,
  nearSignature: `near-${question.questionText}`,
  blueprintSignature: `blueprint-${question.questionText}`,
});
const distinctBatchTracker = () => ({
  isDuplicate: () => false,
  record: () => {},
});

describe('Source-Grounded exact question-type distribution', () => {
  test('an 8/3/2 first response accepts only 7/3/2 and retries only the missing 0/1/2 types', async () => {
    const calls = [];
    const generatorFn = async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          candidates: [
            ...buildQuestions('MULTIPLE_CHOICE', 8, 'mcq-first'),
            ...buildQuestions('MULTIPLE_OPTIONS', 3, 'multi-first'),
            ...buildQuestions('FILL_IN_THE_BLANK', 2, 'fill-first'),
          ],
          insufficientSourceMaterial: false,
          insufficientReason: null,
        };
      }
      return {
        candidates: [
          ...buildQuestions('MULTIPLE_OPTIONS', 1, 'multi-fill'),
          ...buildQuestions('FILL_IN_THE_BLANK', 2, 'fill-fill'),
        ],
        insufficientSourceMaterial: false,
        insufficientReason: null,
      };
    };

    const result = await generateWithNoveltyAndGrounding({
      tenantId: 'tenant-test',
      userId: 'user-test',
      generationRunId: 'run-test',
      sourceIds: ['source-test'],
      topic: 'Test source',
      difficulty: 'medium',
      questionTypes: ['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'FILL_IN_THE_BLANK'],
      questionTypeDistribution: [
        { type: 'MULTIPLE_CHOICE', count: 7 },
        { type: 'MULTIPLE_OPTIONS', count: 4 },
        { type: 'FILL_IN_THE_BLANK', count: 4 },
      ],
      targetCount: 15,
      generatorFn,
      groundingFn: alwaysGrounded,
      noveltyProbeFn: alwaysNovel,
      noveltyReserveFn: reserveAlways,
      batchTrackerFactory: distinctBatchTracker,
    });

    assert.deepEqual(result.generatedDistribution, {
      MULTIPLE_CHOICE: 7,
      MULTIPLE_OPTIONS: 4,
      FILL_IN_THE_BLANK: 4,
    });
    assert.equal(result.questions.length, 15);
    assert.deepEqual(result.missingDistribution, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].questionTypes, ['MULTIPLE_OPTIONS', 'FILL_IN_THE_BLANK']);
    assert.ok(!calls[1].questionTypeDistribution.some((item) => item.type === 'MULTIPLE_CHOICE'));
  });

  test('reports the exact remaining type deficits when retries are exhausted', async () => {
    const result = await generateWithNoveltyAndGrounding({
      tenantId: 'tenant-test',
      userId: 'user-test',
      generationRunId: 'run-test',
      sourceIds: ['source-test'],
      topic: 'Test source',
      difficulty: 'medium',
      questionTypes: ['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'FILL_IN_THE_BLANK'],
      questionTypeDistribution: [
        { type: 'MULTIPLE_CHOICE', count: 7 },
        { type: 'MULTIPLE_OPTIONS', count: 4 },
        { type: 'FILL_IN_THE_BLANK', count: 4 },
      ],
      targetCount: 15,
      generatorFn: async () => ({
        candidates: [],
        insufficientSourceMaterial: true,
        insufficientReason: 'LLM_REPORTED_INSUFFICIENT',
      }),
      groundingFn: alwaysGrounded,
      noveltyProbeFn: alwaysNovel,
      noveltyReserveFn: reserveAlways,
      batchTrackerFactory: distinctBatchTracker,
    });

    assert.deepEqual(result.missingDistribution, [
      { type: 'MULTIPLE_CHOICE', count: 7 },
      { type: 'MULTIPLE_OPTIONS', count: 4 },
      { type: 'FILL_IN_THE_BLANK', count: 4 },
    ]);
    assert.equal(result.acceptedCount, 0);
  });
});
