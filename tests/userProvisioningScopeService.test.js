import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolveTargetLocationForUserCreation,
  UserProvisioningScopeError,
} from '../services/userProvisioningScopeService.js';

// The Academic Admin branch is pure logic (reads only actor.primaryOrganizationUnitId,
// never queries the database), so it is fully unit-testable without a live/disposable
// Mongo connection. This is the exact scenario XAMIGO_HIERARCHY.md's acceptance test
// describes: "Academic Admin Devlali creates Teacher... Attempt API payload: location
// = Mumbai... Expected: 403 / validation rejection." The TENANT_ADMIN and TEACHER
// branches additionally query OrganizationUnit/CourseOffering and are documented as
// UNVERIFIED — DISPOSABLE DATABASE REQUIRED in
// DOCS/XAMIGO_HIERARCHY_DATA_MIGRATION_PLAN.md rather than faked here.

describe('resolveTargetLocationForUserCreation — Academic Admin anti-tampering', () => {
  const devlaliId = '507f1f77bcf86cd799439011';
  const mumbaiId = '507f1f77bcf86cd799439099';

  test('a tampered requestedLocationId is ignored — the actor\'s own home location always wins', async () => {
    const actor = { _id: 'admin1', tenantId: 't1', role: 'ACADEMIC_ADMIN', roles: ['ACADEMIC_ADMIN'], primaryOrganizationUnitId: devlaliId };
    const result = await resolveTargetLocationForUserCreation({ actor, requestedLocationId: mumbaiId });
    assert.equal(result.locationId, devlaliId, 'must resolve to the actor\'s own location, never the client-supplied one');
    assert.notEqual(result.locationId, mumbaiId);
    assert.equal(result.method, 'ACADEMIC_ADMIN_INHERITED_LOCATION');
  });

  test('with no requestedLocationId at all, still resolves to the actor\'s own home location', async () => {
    const actor = { _id: 'admin1', tenantId: 't1', role: 'ACADEMIC_ADMIN', roles: ['ACADEMIC_ADMIN'], primaryOrganizationUnitId: devlaliId };
    const result = await resolveTargetLocationForUserCreation({ actor, requestedLocationId: null });
    assert.equal(result.locationId, devlaliId);
    assert.equal(result.method, 'ACADEMIC_ADMIN_INHERITED_LOCATION');
  });

  test('an Academic Admin with no home location assigned is rejected, not silently widened to every location', async () => {
    const actor = { _id: 'admin2', tenantId: 't1', role: 'ACADEMIC_ADMIN', roles: ['ACADEMIC_ADMIN'], primaryOrganizationUnitId: null };
    await assert.rejects(
      () => resolveTargetLocationForUserCreation({ actor, requestedLocationId: mumbaiId }),
      (error) => {
        assert.ok(error instanceof UserProvisioningScopeError);
        assert.equal(error.code, 'ORGANIZATION_ASSIGNMENT_REQUIRED');
        assert.equal(error.status, 409);
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
  });

  test('a role with no user-creation authority is rejected outright', async () => {
    const actor = { _id: 'cand1', tenantId: 't1', role: 'CANDIDATE', roles: ['CANDIDATE'] };
    await assert.rejects(
      () => resolveTargetLocationForUserCreation({ actor, requestedLocationId: devlaliId }),
      (error) => {
        assert.ok(error instanceof UserProvisioningScopeError);
        assert.equal(error.code, 'ROLE_NOT_AUTHORIZED');
        assert.equal(error.status, 403);
        return true;
      },
    );
  });

  test('a Teacher creating a candidate requires an explicit courseOfferingId (location is never actor-declared)', async () => {
    const actor = { _id: 'teach1', tenantId: 't1', role: 'TEACHER', roles: ['TEACHER'], primaryOrganizationUnitId: devlaliId };
    await assert.rejects(
      () => resolveTargetLocationForUserCreation({ actor, courseOfferingId: null }),
      (error) => {
        assert.ok(error instanceof UserProvisioningScopeError);
        assert.equal(error.code, 'COURSE_OFFERING_REQUIRED');
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});

describe('UserProvisioningScopeError', () => {
  test('carries both .status and .statusCode so the shared error middleware formats it correctly', () => {
    const error = new UserProvisioningScopeError(403, 'denied', 'ROLE_NOT_AUTHORIZED');
    assert.equal(error.status, 403);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'ROLE_NOT_AUTHORIZED');
  });
});
