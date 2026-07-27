import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canTenantUpdateFeature, resolveCapabilityEffectiveState } from '../services/tenantFeatureService.js';
import { isExamCreatorEligibleForEvaluator } from '../services/userRoleService.js';
import { getEligibleEvaluatorUserFilter, isEligibleEvaluatorAssignee } from '../services/evaluatorAssignmentService.js';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import ExamParticipant from '../models/ExamParticipant.js';

describe('tenant feature-control state resolution', () => {
  test('returns the six canonical effective states used by Controls', () => {
    assert.equal(resolveCapabilityEffectiveState({ planEntitled: true }), 'ENABLED');
    assert.equal(resolveCapabilityEffectiveState({ planEntitled: true, requestedEnabled: false }), 'DISABLED');
    assert.equal(resolveCapabilityEffectiveState({ planEntitled: false }), 'LOCKED_BY_PLAN');
    assert.equal(resolveCapabilityEffectiveState({ planEntitled: true, releaseStatus: 'BETA' }), 'BETA');
    assert.equal(resolveCapabilityEffectiveState({ planEntitled: true, releaseStatus: 'UNRELEASED', platformAvailable: false }), 'UNRELEASED');
    assert.equal(resolveCapabilityEffectiveState({ planEntitled: true, superAdminEnforced: true }), 'SUPER_ADMIN_ENFORCED');
  });

  test('backend authorization rejects tenant updates for unreleased, locked, and platform-enforced features', () => {
    assert.equal(canTenantUpdateFeature({ effectiveState: 'UNRELEASED' }, true).allowed, false);
    assert.equal(canTenantUpdateFeature({ effectiveState: 'LOCKED_BY_PLAN', planEntitled: false, platformAvailable: true }, true).allowed, false);
    assert.equal(canTenantUpdateFeature({ effectiveState: 'SUPER_ADMIN_ENFORCED', superAdminEnforced: true }, false).allowed, false);
  });

  test('a beta feature can be enabled only when it is plan-entitled', () => {
    assert.equal(canTenantUpdateFeature({ effectiveState: 'BETA', planEntitled: true, platformAvailable: true }, true).allowed, true);
    assert.equal(canTenantUpdateFeature({ effectiveState: 'LOCKED_BY_PLAN', planEntitled: false, platformAvailable: true }, true).allowed, false);
  });
});

describe('Exam Creator evaluator eligibility', () => {
  test('only an active Exam Creator can be granted evaluator access', () => {
    assert.equal(isExamCreatorEligibleForEvaluator({ status: 'ACTIVE', role: 'EXAM_CREATOR', roles: ['EXAM_CREATOR'] }), true);
    assert.equal(isExamCreatorEligibleForEvaluator({ status: 'ACTIVE', role: 'CANDIDATE', roles: ['CANDIDATE'] }), false);
    assert.equal(isExamCreatorEligibleForEvaluator({ status: 'ACTIVE', role: 'TENANT_ADMIN', roles: ['TENANT_ADMIN'] }), false);
    assert.equal(isExamCreatorEligibleForEvaluator({ status: 'INACTIVE', role: 'EXAM_CREATOR', roles: ['EXAM_CREATOR'] }), false);
  });

  test('direct assignment accepts active Evaluators and still rejects candidates and tenant admins', () => {
    assert.equal(isEligibleEvaluatorAssignee({ status: 'ACTIVE', role: 'EVALUATOR', roles: ['EVALUATOR'], evaluatorAccess: { enabled: true } }), true);
    assert.equal(isEligibleEvaluatorAssignee({ status: 'ACTIVE', roles: ['EXAM_CREATOR', 'EVALUATOR'], evaluatorAccess: { enabled: true } }), true);
    assert.equal(isEligibleEvaluatorAssignee({ status: 'ACTIVE', roles: ['CANDIDATE', 'EVALUATOR'], evaluatorAccess: { enabled: true } }), false);
    assert.equal(isEligibleEvaluatorAssignee({ status: 'ACTIVE', roles: ['TENANT_ADMIN', 'EVALUATOR'], evaluatorAccess: { enabled: true } }), false);
  });

  test('every evaluator picker uses the same active Evaluator filter', () => {
    const filter = getEligibleEvaluatorUserFilter({ tenantId: 'tenant-id', now: new Date('2026-07-27T00:00:00.000Z') });
    assert.equal(filter.tenantId, 'tenant-id');
    assert.equal(filter.status, 'ACTIVE');
    assert.equal(filter['evaluatorAccess.enabled'], true);
    assert.deepEqual(filter.$and[0], { $or: [{ role: 'EVALUATOR' }, { roles: 'EVALUATOR' }] });
    assert.deepEqual(filter.$and[1], { $nor: [{ role: { $in: ['CANDIDATE', 'TENANT_ADMIN'] } }, { roles: { $in: ['CANDIDATE', 'TENANT_ADMIN'] } }] });
  });

  test('database schemas allow a separate evaluator participant role and prevent duplicate active scopes', () => {
    const participantIndexes = ExamParticipant.schema.indexes();
    assert.ok(participantIndexes.some(([key, options]) =>
      key.examId === 1 && key.userId === 1 && key.examRole === 1 && options.unique === true
    ));
    assert.equal(participantIndexes.some(([key, options]) =>
      key.examId === 1 && key.userId === 1 && Object.keys(key).length === 2 && options.unique === true
    ), false);

    const assignmentIndexes = ExaminerAssignment.schema.indexes();
    assert.ok(assignmentIndexes.some(([key, options]) =>
      key.examId === 1 && key.examinerId === 1 && key.scopeType === 1 &&
      options.unique === true && options.partialFilterExpression?.status === 'ACTIVE'
    ));
  });
});
