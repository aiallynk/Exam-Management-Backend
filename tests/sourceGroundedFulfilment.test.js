import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeShortfallDistribution,
  distributionToCountMap,
} from '../utils/sourceGroundedFulfilment.js';

describe('computeShortfallDistribution — always-fulfil top-up math (Blueprint §4C)', () => {
  test('explicit distribution: shortfall is requested minus grounded, per type', () => {
    const { shortfallDistribution, shortfallCount } = computeShortfallDistribution({
      requestedDistribution: [
        { type: 'MULTIPLE_CHOICE', count: 6 },
        { type: 'SHORT_ANSWER', count: 4 },
      ],
      requestedCount: 10,
      generatedByType: { MULTIPLE_CHOICE: 4, SHORT_ANSWER: 1 },
    });
    assert.deepEqual(shortfallDistribution, [
      { type: 'MULTIPLE_CHOICE', count: 2 },
      { type: 'SHORT_ANSWER', count: 3 },
    ]);
    assert.equal(shortfallCount, 5);
  });

  test('zero shortfall when grounded already met the request → no top-up', () => {
    const { shortfallDistribution, shortfallCount } = computeShortfallDistribution({
      requestedDistribution: [{ type: 'MULTIPLE_CHOICE', count: 5 }],
      requestedCount: 5,
      generatedByType: { MULTIPLE_CHOICE: 5 },
    });
    assert.deepEqual(shortfallDistribution, []);
    assert.equal(shortfallCount, 0);
  });

  test('grounded over-production of one type never creates negative top-up for another', () => {
    const { shortfallDistribution, shortfallCount } = computeShortfallDistribution({
      requestedDistribution: [
        { type: 'MULTIPLE_CHOICE', count: 3 },
        { type: 'TRUE_FALSE', count: 3 },
      ],
      requestedCount: 6,
      generatedByType: { MULTIPLE_CHOICE: 5, TRUE_FALSE: 1 },
    });
    assert.deepEqual(shortfallDistribution, [{ type: 'TRUE_FALSE', count: 2 }]);
    assert.equal(shortfallCount, 2);
  });

  test('no explicit distribution: even split of requestedCount across fallbackTypes, remainder first', () => {
    const { shortfallDistribution, shortfallCount } = computeShortfallDistribution({
      requestedDistribution: [],
      requestedCount: 10,
      generatedByType: { MULTIPLE_CHOICE: 2 },
      fallbackTypes: ['MULTIPLE_CHOICE', 'SHORT_ANSWER', 'TRUE_FALSE'],
    });
    // even split of 10 over 3 types = 4 / 3 / 3, minus grounded MCQ 2
    assert.deepEqual(shortfallDistribution, [
      { type: 'MULTIPLE_CHOICE', count: 2 },
      { type: 'SHORT_ANSWER', count: 3 },
      { type: 'TRUE_FALSE', count: 3 },
    ]);
    assert.equal(shortfallCount, 8);
  });

  test('no explicit distribution and no usable type list: bare remaining count, empty distribution', () => {
    const { shortfallDistribution, shortfallCount } = computeShortfallDistribution({
      requestedDistribution: [],
      requestedCount: 8,
      generatedByType: { MULTIPLE_CHOICE: 3 },
      fallbackTypes: [],
    });
    assert.deepEqual(shortfallDistribution, []);
    assert.equal(shortfallCount, 5);
  });

  test('unknown types and non-positive counts are dropped', () => {
    assert.deepEqual(
      distributionToCountMap([
        { type: 'MULTIPLE_CHOICE', count: 2 },
        { type: 'NOT_A_REAL_TYPE', count: 3 },
        { type: 'SHORT_ANSWER', count: 0 },
        { type: 'SHORT_ANSWER', count: -1 },
      ]),
      { MULTIPLE_CHOICE: 2 },
    );
  });
});
