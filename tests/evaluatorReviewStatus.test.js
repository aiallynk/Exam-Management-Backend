import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReviewStatus } from '../services/evaluatorAssignmentService.js';

describe('deriveReviewStatus — an untouched attempt must never show as Reviewed', () => {
  test('never entered the review pipeline -> NOT_REQUIRED, not Reviewed', () => {
    // This is the exact AUTOMATIC-evaluation-mode bug: 0 pending because
    // nothing was ever marked PENDING_REVIEW, not because a human reviewed it.
    assert.equal(deriveReviewStatus({ pending: 0, reviewable: 0 }), 'NOT_REQUIRED');
  });

  test('answers pending human review -> PENDING_REVIEW', () => {
    assert.equal(deriveReviewStatus({ pending: 3, reviewable: 5 }), 'PENDING_REVIEW');
  });

  test('evaluator opened but has not finished -> still PENDING_REVIEW', () => {
    assert.equal(deriveReviewStatus({ pending: 1, reviewable: 5 }), 'PENDING_REVIEW');
  });

  test('all reviewable answers finalized -> REVIEWED', () => {
    assert.equal(deriveReviewStatus({ pending: 0, reviewable: 5 }), 'REVIEWED');
  });
});
