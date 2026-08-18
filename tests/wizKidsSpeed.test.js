import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WizKidsAttemptState from '../models/WizKidsAttemptState.js';
import {
  SPEED_MODE,
  elapsedSeconds,
  evaluateSpeedModeGate,
  findNextUnlockedQuestionId,
  recordedDurationSeconds,
  remainingQuestionSeconds,
  WizKidsSpeedError,
} from '../services/wizKidsSpeedService.js';

// WizKids Phase 8 — Speed Mode.
// Exercises the isolated schema and all I/O-free policy/timing rules.  The
// repository does not yet have a disposable Mongo test database, so this
// follows the schema-introspection/pure-service convention used by Phases 1-7.

describe('CRITICAL SECURITY TEST — only SPEED-mode WizKids exams can receive Speed state', () => {
  test('a STANDARD exam is rejected even when every other input is permissive', () => {
    const gate = evaluateSpeedModeGate({
      exam: { productModule: 'STANDARD' },
      config: { mode: SPEED_MODE },
      speedFeatureEnabled: true,
    });
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /only available for WizKids exams/i);
  });

  test('a WizKids TEST or PRACTICE exam cannot use the Speed route', () => {
    for (const mode of ['TEST', 'PRACTICE', 'OLYMPIAD']) {
      const gate = evaluateSpeedModeGate({
        exam: { productModule: 'WIZKIDS' },
        config: { mode },
        speedFeatureEnabled: true,
      });
      assert.equal(gate.allowed, false, `${mode} must not receive Speed state`);
    }
  });

  test('the WIZKIDS_SPEED_MODE capability remains a mandatory server-side gate', () => {
    assert.equal(
      evaluateSpeedModeGate({
        exam: { productModule: 'WIZKIDS' },
        config: { mode: SPEED_MODE },
        speedFeatureEnabled: false,
      }).allowed,
      false
    );
    assert.equal(
      evaluateSpeedModeGate({
        exam: { productModule: 'WIZKIDS' },
        config: { mode: SPEED_MODE },
        speedFeatureEnabled: true,
      }).allowed,
      true
    );
  });
});

describe('Speed timing is backend-authoritative', () => {
  test('calculates elapsed time from server-side start/end timestamps and never returns a negative value', () => {
    const startedAt = new Date('2026-08-17T10:00:00.000Z');
    assert.equal(elapsedSeconds(startedAt, new Date('2026-08-17T10:00:09.999Z')), 9);
    assert.equal(elapsedSeconds(startedAt, new Date('2026-08-17T09:59:59.000Z')), 0);
  });

  test('caps persisted time at the configured question timer when a late request arrives', () => {
    const startedAt = new Date('2026-08-17T10:00:00.000Z');
    assert.equal(
      recordedDurationSeconds({ startedAt, now: new Date('2026-08-17T10:03:00.000Z'), questionTimerSeconds: 30 }),
      30
    );
    assert.equal(
      remainingQuestionSeconds({ questionStartedAt: startedAt, now: new Date('2026-08-17T10:00:18.000Z'), questionTimerSeconds: 30 }),
      12
    );
    assert.equal(
      remainingQuestionSeconds({ questionStartedAt: startedAt, now: new Date('2026-08-17T10:00:31.000Z'), questionTimerSeconds: 30 }),
      0
    );
  });

  test('supports no per-question timer without inventing a zero-second deadline', () => {
    assert.equal(remainingQuestionSeconds({ questionStartedAt: new Date(), questionTimerSeconds: null }), null);
  });
});

describe('Speed navigation policy', () => {
  const questions = [
    { _id: 'q1', order: 1 },
    { _id: 'q2', order: 2 },
    { _id: 'q3', order: 3 },
  ];

  test('advances in question order and skips locked questions', () => {
    assert.equal(findNextUnlockedQuestionId({ questions, lockedQuestionIds: ['q1'], afterQuestionId: 'q1' }), 'q2');
    assert.equal(findNextUnlockedQuestionId({ questions, lockedQuestionIds: ['q1', 'q2'], afterQuestionId: 'q1' }), 'q3');
  });

  test('returns null when every question is locked, which is the only completion condition', () => {
    assert.equal(findNextUnlockedQuestionId({ questions, lockedQuestionIds: ['q1', 'q2', 'q3'], afterQuestionId: 'q3' }), null);
  });
});

describe('WizKidsAttemptState schema — isolated Speed runtime data', () => {
  test('keeps exactly one state document per core ExamAttempt and scopes operational reads by tenant', () => {
    const indexes = WizKidsAttemptState.schema.indexes();
    assert.ok(indexes.some(([key, options]) => key.attemptId === 1 && options.unique === true));
    assert.ok(indexes.some(([key]) => key.tenantId === 1 && key.attemptId === 1));
  });

  test('does not add Speed state to ExamAttempt or Answer; it owns timings and locks in an isolated collection', () => {
    for (const field of ['tenantId', 'attemptId', 'examId', 'currentQuestionId', 'questionStartedAt', 'questionTimings', 'lockedQuestionIds']) {
      assert.ok(WizKidsAttemptState.schema.path(field), `${field} must remain WizKids-owned state`);
    }
    assert.equal(WizKidsAttemptState.schema.path('mode').defaultValue, SPEED_MODE);
    assert.equal(WizKidsAttemptState.schema.path('autoAdvance').defaultValue, true);
    assert.equal(WizKidsAttemptState.schema.path('allowBackNavigation').defaultValue, false);
  });

  test('records each timed interaction with a duration and an explicit answer/timeout/skip outcome', () => {
    const timingPath = WizKidsAttemptState.schema.path('questionTimings');
    const outcomePath = timingPath.schema.path('outcome');
    assert.deepEqual([...outcomePath.enumValues].sort(), ['ANSWERED', 'SKIPPED', 'TIMED_OUT']);
    assert.equal(timingPath.schema.path('durationSeconds').options.min, 0);
  });
});

describe('WizKidsSpeedError', () => {
  test('carries the intended HTTP status for route-level conversion', () => {
    const error = new WizKidsSpeedError(409, 'This Speed Mode question is locked.');
    assert.equal(error.status, 409);
    assert.equal(error.name, 'WizKidsSpeedError');
    assert.ok(error instanceof Error);
  });
});
