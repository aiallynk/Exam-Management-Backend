import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildPendingReviewFilter,
  buildFinalizeReadiness,
  resolvePostMaterializeStatus,
} from '../services/offlineEvaluation/answerScriptFinalizeReadiness.js';

describe('post-materialize script status', () => {
  test('does not force Needs Review when no answers require attention', () => {
    assert.deepEqual(resolvePostMaterializeStatus(0), { status: 'EVALUATED', statusReason: '' });
  });

  test('keeps Needs Review only when answers actually require attention', () => {
    const next = resolvePostMaterializeStatus(2);
    assert.equal(next.status, 'NEEDS_REVIEW');
    assert.match(next.statusReason, /2 answer/);
  });
});

describe('finalize readiness', () => {
  const ready = {
    scriptStatus: 'NEEDS_REVIEW',
    candidateId: 'c1',
    materializedAttemptId: 'a1',
    unmappedCount: 0,
    pendingReviewCount: 0,
  };

  test('unlocks finalize for a wrongly stuck Needs Review sheet with no real blockers', () => {
    const result = buildFinalizeReadiness(ready);
    assert.equal(result.canFinalize, true);
    assert.deepEqual(result.blockers, []);
  });

  test('locks finalize when an evaluator still has mandatory review items', () => {
    const result = buildFinalizeReadiness({ ...ready, pendingReviewCount: 3 });
    assert.equal(result.canFinalize, false);
    assert.equal(result.blockers[0].code, 'EVALUATOR_REVIEW');
  });

  test('locks finalize when a question region is still unmapped', () => {
    const result = buildFinalizeReadiness({ ...ready, unmappedCount: 1 });
    assert.equal(result.canFinalize, false);
    assert.equal(result.blockers[0].code, 'QUESTION_MAPPING');
  });

  test('does not count a rubric failure that already has an evaluator manual score', () => {
    const failureClause = buildPendingReviewFilter().$or.find((clause) => clause.scoringMode === 'EVALUATION_FAILED');
    assert.deepEqual(failureClause.$or, [
      { scoreResolved: { $ne: true } },
      { finalScore: null },
      { evaluatorDecision: { $nin: ['OVERRIDE', 'MANUAL_SCORE'] } },
    ]);
  });
});
