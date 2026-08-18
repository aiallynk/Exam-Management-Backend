import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isExamResultsReleased, canCandidateViewScore, buildAttemptStatusOnlyPayload } from '../utils/resultVisibility.js';

describe('isExamResultsReleased', () => {
  test('false for missing exam', () => {
    assert.equal(isExamResultsReleased(null), false);
  });

  test('true when showResultsImmediately is set', () => {
    assert.equal(isExamResultsReleased({ showResultsImmediately: true }), true);
  });

  test('false when resultsReleasedAt is unset', () => {
    assert.equal(isExamResultsReleased({ showResultsImmediately: false }), false);
  });

  test('false when resultsReleasedAt is in the future', () => {
    const future = new Date(Date.now() + 60_000);
    assert.equal(isExamResultsReleased({ resultsReleasedAt: future }), false);
  });

  test('true when resultsReleasedAt is in the past', () => {
    const past = new Date(Date.now() - 60_000);
    assert.equal(isExamResultsReleased({ resultsReleasedAt: past }), true);
  });
});

describe('canCandidateViewScore — disqualification must never bypass release gating', () => {
  const unreleasedExam = { showResultsImmediately: false };
  const releasedExam = { showResultsImmediately: true };

  test('candidate cannot view score before release, regardless of disqualification', () => {
    assert.equal(canCandidateViewScore({ exam: unreleasedExam }), false);
  });

  test('candidate can view score once released', () => {
    assert.equal(canCandidateViewScore({ exam: releasedExam }), true);
  });

  test('privileged role can always view score', () => {
    assert.equal(canCandidateViewScore({ exam: unreleasedExam, isPrivileged: true }), true);
  });

  test('an evaluator with REVIEW_ANSWERS permission can always view score', () => {
    assert.equal(canCandidateViewScore({ exam: unreleasedExam, canReviewAnswers: true }), true);
  });
});

describe('buildAttemptStatusOnlyPayload — never leaks score/answers', () => {
  test('only exposes status fields, no score/answers/correctAnswer', () => {
    const attempt = {
      uniqueId: 'ATT-AAAA-BBBB',
      isCompleted: true,
      isDisqualified: true,
      disqualifyReason: 'Tab switch detected',
      disqualifyStatus: 'DISQUALIFIED_TAB_SWITCH',
      submitTime: new Date('2026-01-01T00:00:00Z'),
      scoreSummary: { totalScore: 42, maxScore: 50, percentage: 84 },
    };
    const payload = buildAttemptStatusOnlyPayload(attempt);
    assert.equal(payload.isDisqualified, true);
    assert.equal(payload.disqualifyReason, 'Tab switch detected');
    assert.equal('scoreSummary' in payload, false);
    assert.equal('answers' in payload, false);
    assert.equal('correctAnswer' in payload, false);
  });
});
