import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBalancedSplit,
  planDistribution,
} from '../services/responseDistributionService.js';

describe('computeBalancedSplit', () => {
  test('3 evaluators / 10 candidates -> 4,3,3', () => {
    assert.deepEqual(computeBalancedSplit(10, 3), [4, 3, 3]);
  });

  test('4 evaluators / 3 candidates -> 1,1,1,0', () => {
    assert.deepEqual(computeBalancedSplit(3, 4), [1, 1, 1, 0]);
  });

  test('1 evaluator / 10 candidates -> 10', () => {
    assert.deepEqual(computeBalancedSplit(10, 1), [10]);
  });

  test('even split', () => {
    assert.deepEqual(computeBalancedSplit(10, 2), [5, 5]);
  });

  test('zero candidates -> all-zero buckets', () => {
    assert.deepEqual(computeBalancedSplit(0, 3), [0, 0, 0]);
  });

  test('zero buckets -> empty', () => {
    assert.deepEqual(computeBalancedSplit(10, 0), []);
  });
});

const attemptIds = (n) => Array.from({ length: n }, (_, i) => `attempt-${i}`);
const bucketSizes = (finalCounts) => Object.values(finalCounts).sort((a, b) => b - a);

describe('planDistribution — bucket sizes match computeBalancedSplit for a fresh run', () => {
  for (const strategy of ['RANDOM_BALANCED', 'ROUND_ROBIN', 'WORKLOAD_BASED']) {
    test(`${strategy}: 10 attempts / 3 evaluators -> sizes [4,3,3]`, () => {
      const { assignments, finalCounts } = planDistribution({
        attemptIds: attemptIds(10),
        evaluatorIds: ['e1', 'e2', 'e3'],
        strategy,
      });
      assert.deepEqual(bucketSizes(finalCounts), computeBalancedSplit(10, 3));
      assert.equal(assignments.length, 10);
      assert.equal(new Set(assignments.map((a) => a.attemptId)).size, 10, 'no attempt assigned twice');
    });

    test(`${strategy}: 3 attempts / 4 evaluators -> three get 1, one gets 0`, () => {
      const { finalCounts } = planDistribution({
        attemptIds: attemptIds(3),
        evaluatorIds: ['e1', 'e2', 'e3', 'e4'],
        strategy,
      });
      assert.deepEqual(bucketSizes(finalCounts), [1, 1, 1, 0]);
    });

    test(`${strategy}: 10 attempts / 1 evaluator -> all 10 to that evaluator`, () => {
      const { assignments, finalCounts } = planDistribution({
        attemptIds: attemptIds(10),
        evaluatorIds: ['solo'],
        strategy,
      });
      assert.equal(finalCounts.solo, 10);
      assert.equal(assignments.length, 10);
    });
  }
});

describe('planDistribution — incremental idempotency', () => {
  test('calling again with no new attempts assigns nothing', () => {
    const { assignments } = planDistribution({
      attemptIds: [],
      evaluatorIds: ['e1', 'e2', 'e3'],
      strategy: 'RANDOM_BALANCED',
      currentCounts: { e1: 4, e2: 3, e3: 3 },
    });
    assert.equal(assignments.length, 0);
  });

  test('one attempt at a time preserves overall balance (simulating the auto-distribute-on-submit hook)', () => {
    const evaluatorIds = ['e1', 'e2', 'e3'];
    const counts = { e1: 0, e2: 0, e3: 0 };
    for (let i = 0; i < 10; i += 1) {
      const { assignments } = planDistribution({
        attemptIds: [`attempt-${i}`],
        evaluatorIds,
        strategy: 'WORKLOAD_BASED',
        currentCounts: counts,
      });
      assert.equal(assignments.length, 1);
      counts[assignments[0].evaluatorId] += 1;
    }
    assert.deepEqual(bucketSizes(counts), [4, 3, 3]);
  });

  test('registering a new evaluator later only affects attempts not yet assigned', () => {
    // First pass: 2 evaluators split 6 attempts (3/3).
    const first = planDistribution({
      attemptIds: attemptIds(6),
      evaluatorIds: ['e1', 'e2'],
      strategy: 'RANDOM_BALANCED',
    });
    assert.deepEqual(bucketSizes(first.finalCounts), [3, 3]);

    // A 3rd evaluator joins; only the next 3 NEW attempts are planned for
    // all three — already-assigned attempts from the first pass are never
    // re-included by the caller (getUnassignedCompletedAttemptIds excludes
    // them), so this simulates that by only passing the new IDs.
    const second = planDistribution({
      attemptIds: ['attempt-6', 'attempt-7', 'attempt-8'],
      evaluatorIds: ['e1', 'e2', 'e3'],
      strategy: 'RANDOM_BALANCED',
      currentCounts: { e1: 3, e2: 3, e3: 0 },
    });
    // The brand-new evaluator (0 baseline) should pick up the new work first.
    assert.equal(second.finalCounts.e3, 3);
    assert.equal(second.finalCounts.e1, 3);
    assert.equal(second.finalCounts.e2, 3);
  });
});

describe('planDistribution — strategy-specific ordering', () => {
  test('ROUND_ROBIN is deterministic cyclic order regardless of baseline', () => {
    const { assignments } = planDistribution({
      attemptIds: ['a0', 'a1', 'a2', 'a3', 'a4'],
      evaluatorIds: ['e1', 'e2'],
      strategy: 'ROUND_ROBIN',
    });
    assert.deepEqual(assignments.map((a) => a.evaluatorId), ['e1', 'e2', 'e1', 'e2', 'e1']);
  });

  test('no evaluators -> no assignments', () => {
    const { assignments } = planDistribution({ attemptIds: attemptIds(5), evaluatorIds: [], strategy: 'RANDOM_BALANCED' });
    assert.equal(assignments.length, 0);
  });
});
