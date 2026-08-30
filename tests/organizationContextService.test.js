import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import User from '../models/User.js';
import {
  narrowAcademicFilterByOrganization,
  OrganizationContextError,
} from '../services/organizationContextService.js';

describe('organizationContextService', () => {
  test('User schema includes organization membership fields', () => {
    assert.ok(User.schema.path('primaryOrganizationUnitId'));
    assert.ok(User.schema.path('organizationUnitAccess'));
    assert.ok(User.schema.path('organizationPreferences.activeOrganizationUnitId'));
  });

  test('narrowAcademicFilterByOrganization scopes programs and offerings', () => {
    const unitId = '507f1f77bcf86cd799439011';
    assert.deepEqual(
      narrowAcademicFilterByOrganization({ tenantId: 't1' }, 'programs', unitId),
      { tenantId: 't1', organizationUnitId: unitId },
    );
    assert.deepEqual(
      narrowAcademicFilterByOrganization({ tenantId: 't1', _id: { $in: ['a'] } }, 'course-offerings', unitId),
      { tenantId: 't1', _id: { $in: ['a'] }, organizationUnitId: unitId },
    );
    assert.deepEqual(
      narrowAcademicFilterByOrganization({ tenantId: 't1' }, 'academic-sessions', unitId),
      { tenantId: 't1' },
    );
  });

  test('OrganizationContextError carries HTTP status', () => {
    const error = new OrganizationContextError(403, 'denied');
    assert.equal(error.status, 403);
    assert.equal(error.statusCode, 403);
  });
});
