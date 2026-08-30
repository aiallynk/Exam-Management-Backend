import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import User from '../models/User.js';
import CourseOffering from '../models/academic/CourseOffering.js';
import { requireRole } from '../middleware/roles.js';
import { ALL_ROLES, normalizeRoles } from '../utils/userRoles.js';
import { isGovernanceScopeReadable } from '../utils/governanceScope.js';

const runGuard = (guard, user) => new Promise((resolve) => {
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ passed: false, status: this.statusCode, payload }); },
  };
  guard({ user }, response, () => resolve({ passed: true, status: 200 }));
});

describe('canonical persona authorization', () => {
  test('the stored role enum and shared role catalogue contain all seven canonical roles', () => {
    const expected = ['SUPER_ADMIN', 'TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR', 'EVALUATOR', 'CANDIDATE'];
    expected.forEach((role) => {
      assert.ok(User.schema.path('role').enumValues.includes(role));
      assert.ok(ALL_ROLES.includes(role));
    });
  });

  test('multi-role guards inspect roles[] and preserve the primary role', async () => {
    const user = { role: 'TEACHER', roles: ['TEACHER', 'EXAM_CREATOR'] };
    assert.deepEqual(normalizeRoles(user), ['TEACHER', 'EXAM_CREATOR']);
    assert.equal((await runGuard(requireRole('EXAM_CREATOR'), user)).passed, true);
    assert.equal(user.role, 'TEACHER');
  });

  test('Super Admin has no implicit operational bypass', async () => {
    const result = await runGuard(requireRole('EXAM_CREATOR'), { role: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'] });
    assert.equal(result.passed, false);
    assert.equal(result.status, 403);
  });

  test('Tenant Admin cannot pass an intake-only guard without another operational role', async () => {
    assert.equal((await runGuard(requireRole('ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'), { role: 'TENANT_ADMIN', roles: ['TENANT_ADMIN'] })).status, 403);
    assert.equal((await runGuard(requireRole('ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'), { role: 'TENANT_ADMIN', roles: ['TENANT_ADMIN', 'TEACHER'] })).passed, true);
  });

  test('CourseOffering stores explicit teacher and assessment-creator assignment anchors', () => {
    assert.ok(CourseOffering.schema.path('facultyUserId'));
    assert.ok(CourseOffering.schema.path('assessmentCreatorUserIds'));
  });

  test('Academic Admin governance scope rejects a different department/program', () => {
    const visibility = {
      all: false,
      ids: {
        'organization-units': ['unit-a'], programs: ['program-a'],
        'curriculum-versions': [], 'academic-periods': [], courses: ['course-a'],
      },
    };
    assert.equal(isGovernanceScopeReadable(visibility, { organizationUnitId: ['unit-a'], courseId: ['course-a'] }), true);
    assert.equal(isGovernanceScopeReadable(visibility, { organizationUnitId: ['unit-b'] }), false);
    assert.equal(isGovernanceScopeReadable(visibility, { programId: ['program-b'] }), false);
  });
});
