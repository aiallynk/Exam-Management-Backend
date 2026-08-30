import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SUBTENANT_LEGACY_PURPOSE, shouldRejectSubTenantOnV2Workflow } from '../utils/subTenantLegacy.js';
import { mapFrameworkMemoryPolicy, REPEAT_POLICIES } from '../services/questionMemoryService.js';
import { isGovernanceScopeReadable, isGlobalGovernanceScope } from '../utils/governanceScope.js';
import { canMonitorTenantOperations } from '../services/academicAccessService.js';

describe('SubTenant legacy classification', () => {
  test('SubTenant is marked LEGACY_COMPATIBILITY not location boundary', () => {
    assert.equal(SUBTENANT_LEGACY_PURPOSE, 'LEGACY_COMPATIBILITY');
  });

  test('V2 workflows reject subTenantId assignment', () => {
    assert.equal(shouldRejectSubTenantOnV2Workflow({ subTenantId: 'abc', workflow: 'academic_assessment' }), true);
    assert.equal(shouldRejectSubTenantOnV2Workflow({ workflow: 'academic_assessment' }), false);
  });
});

describe('Question memory policy separation', () => {
  test('mapFrameworkMemoryPolicy exposes conceptPattern separately from recentUsage', () => {
    const policy = mapFrameworkMemoryPolicy({ action: 'WARN' });
    assert.equal(policy.recentUsage, REPEAT_POLICIES.WARN);
    assert.equal(policy.conceptPattern, REPEAT_POLICIES.WARN);
    assert.equal(policy.exact, REPEAT_POLICIES.WARN);
  });
});

describe('Governance scope guards', () => {
  test('bounded visibility rejects tenant-global governance scope', () => {
    assert.equal(isGlobalGovernanceScope({}), true);
    assert.equal(isGovernanceScopeReadable({ all: true }, {}), true);
    const bounded = { all: false, ids: { 'organization-units': ['unit-a'], programs: [], 'curriculum-versions': [], 'academic-periods': [], courses: [] } };
    assert.equal(isGovernanceScopeReadable(bounded, { organizationUnitId: ['unit-a'] }), true);
    assert.equal(isGovernanceScopeReadable(bounded, { organizationUnitId: ['unit-b'] }), false);
  });
});

describe('Persona capability anchors', () => {
  test('Tenant Admin can monitor tenant operations', () => {
    assert.equal(canMonitorTenantOperations({ role: 'TENANT_ADMIN', roles: ['TENANT_ADMIN'] }), true);
    assert.equal(canMonitorTenantOperations({ role: 'TEACHER', roles: ['TEACHER'] }), false);
  });
});
