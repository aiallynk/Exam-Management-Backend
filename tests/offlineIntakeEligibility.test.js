import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  evaluateOfflineIntakeEligibility,
  canChangeExamDeliveryMode,
  OFFLINE_INTAKE_BLOCKERS,
} from '../services/offlineEvaluation/offlineIntakeEligibilityService.js';
import { isStaffExamOwner } from '../utils/examOperationAccess.js';

describe('resolveOfflineIntakeEligibility predicates', () => {
  test('ONLINE assessments are visible as setup-required, not hidden', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { deliveryMode: 'ONLINE', isActive: true },
      authorized: true,
      questionPaperCount: 1,
      candidateCount: 30,
    });
    assert.equal(result.eligibleForOfflineIntake, false);
    assert.equal(result.blockers[0].code, OFFLINE_INTAKE_BLOCKERS.ONLINE_ONLY);
  });

  test('missing deliveryMode is treated as legacy ONLINE', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { isActive: true },
      authorized: true,
      questionPaperCount: 1,
      candidateCount: 1,
    });
    assert.equal(result.blockers.some((blocker) => blocker.code === OFFLINE_INTAKE_BLOCKERS.ONLINE_ONLY), true);
  });

  test('OFFLINE with paper and roster is ready', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { deliveryMode: 'OFFLINE', isActive: true },
      authorized: true,
      questionPaperCount: 1,
      candidateCount: 12,
    });
    assert.equal(result.eligibleForOfflineIntake, true);
    assert.deepEqual(result.blockers, []);
  });

  test('HYBRID is eligible the same as OFFLINE', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { deliveryMode: 'HYBRID', isActive: true },
      authorized: true,
      questionPaperCount: 2,
      candidateCount: 8,
    });
    assert.equal(result.eligibleForOfflineIntake, true);
  });

  test('OFFLINE without candidates reports assign-students blocker', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { deliveryMode: 'OFFLINE', isActive: true },
      authorized: true,
      questionPaperCount: 1,
      candidateCount: 0,
    });
    assert.equal(result.eligibleForOfflineIntake, false);
    assert.equal(result.blockers[0].code, OFFLINE_INTAKE_BLOCKERS.NO_CANDIDATES_ASSIGNED);
  });

  test('OFFLINE without a question paper reports the paper blocker', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { deliveryMode: 'OFFLINE', isActive: true },
      authorized: true,
      questionPaperCount: 0,
      candidateCount: 10,
    });
    assert.equal(result.blockers[0].code, OFFLINE_INTAKE_BLOCKERS.NO_QUESTION_PAPER);
  });

  test('inactive assessments are not silently omitted — they explain state', () => {
    const result = evaluateOfflineIntakeEligibility({
      exam: { deliveryMode: 'OFFLINE', isActive: false },
      authorized: true,
      questionPaperCount: 1,
      candidateCount: 4,
    });
    assert.equal(result.blockers[0].code, OFFLINE_INTAKE_BLOCKERS.INVALID_ASSESSMENT_STATE);
  });
});

describe('staff exam ownership for intake', () => {
  const tenantId = 'tenant-1';
  const exam = { _id: 'exam-1', tenantId, createdBy: 'creator-1' };

  test('Academic Admin who owns the assessment can operate it without EXAM_CREATOR', () => {
    assert.equal(isStaffExamOwner({
      _id: 'creator-1',
      tenantId,
      role: 'ACADEMIC_ADMIN',
      roles: ['ACADEMIC_ADMIN', 'TEACHER'],
    }, exam), true);
  });

  test('a different Academic Admin in the same tenant is not the owner', () => {
    assert.equal(isStaffExamOwner({
      _id: 'other-admin',
      tenantId,
      roles: ['ACADEMIC_ADMIN'],
    }, exam), false);
  });

  test('Exam Creator ownership remains valid', () => {
    assert.equal(isStaffExamOwner({
      _id: 'creator-1',
      tenantId,
      roles: ['EXAM_CREATOR'],
    }, exam), true);
  });
});

describe('delivery mode lifecycle safety', () => {
  test('released results cannot change delivery mode', () => {
    const result = canChangeExamDeliveryMode({
      exam: { deliveryMode: 'ONLINE', resultsReleasedAt: new Date() },
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, OFFLINE_INTAKE_BLOCKERS.RESULTS_ALREADY_RELEASED);
  });

  test('existing paper scripts cannot revert to ONLINE-only', () => {
    const result = canChangeExamDeliveryMode({
      exam: { deliveryMode: 'HYBRID' },
      answerScriptCount: 3,
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.restrictTo, ['OFFLINE', 'HYBRID']);
  });

  test('unreleased ONLINE assessment can enable paper intake', () => {
    const result = canChangeExamDeliveryMode({ exam: { deliveryMode: 'ONLINE' } });
    assert.equal(result.allowed, true);
    assert.ok(result.restrictTo.includes('HYBRID'));
  });
});
