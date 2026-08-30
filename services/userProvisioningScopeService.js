// Canonical operational-scope + location-inheritance rule for creating
// tenant users (XAMIGO_HIERARCHY.md §6-8, DOCS/XAMIGO_HIERARCHY_...).
//
// Single source of truth so this rule is not reimplemented per route:
//   TENANT_ADMIN      -> may select any ACTIVE location in their tenant.
//   ACADEMIC_ADMIN     -> target location is ALWAYS the actor's own home
//                        location (primaryOrganizationUnitId). Client input
//                        is never trusted for this role.
//   TEACHER            -> target location is derived from the specific
//                        CourseOffering the teacher is authorized for
//                        (facultyUserId ownership), not from client input.
//
// Actor location always wins over client-supplied location for any
// non-tenant-wide role — see resolveTargetLocationForUserCreation below.
import { hasRole } from '../utils/userRoles.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { OrganizationUnit, CourseOffering } from '../models/academic/index.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';

export class UserProvisioningScopeError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'UserProvisioningScopeError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

const id = (value) => (value == null ? null : String(value));

/**
 * resolveUserOperationalScope(actor) -> {
 *   tenantId, tenantWide, homeLocationId, allowedLocationIds, academicScope
 * }
 *
 * Composes the existing role-derived visibility (academicAccessService) into
 * the single shape callers reason about for provisioning decisions. This
 * does not replace resolveAcademicVisibility's existing call sites (which
 * already work correctly for academic-entity scoping) — it is the canonical
 * entry point for NEW user-provisioning logic, and is written so those older
 * call sites can converge onto it incrementally without a risky rewrite.
 */
export async function resolveUserOperationalScope(actor) {
  const visibility = await resolveAcademicVisibility(actor);
  const tenantWide = Boolean(visibility.all) && hasRole(actor, 'TENANT_ADMIN');
  return {
    tenantId: visibility.tenantId,
    tenantWide,
    homeLocationId: id(actor.primaryOrganizationUnitId),
    allowedLocationIds: visibility.all ? null : (visibility.ids?.['organization-units'] || []),
    academicScope: visibility,
  };
}

/**
 * resolveTargetLocationForUserCreation({ actor, requestedLocationId, courseOfferingId })
 * -> { locationId, method }
 *
 * Throws UserProvisioningScopeError (never silently widens/guesses) when the
 * actor's authority cannot be established. `requestedLocationId` is honored
 * ONLY for TENANT_ADMIN; for every other role it is ignored in favor of the
 * actor's own authorized location, so a tampered client payload can never
 * move a created user outside the actor's own scope.
 */
export async function resolveTargetLocationForUserCreation({ actor, requestedLocationId, courseOfferingId }) {
  if (hasRole(actor, 'TENANT_ADMIN')) {
    if (!requestedLocationId) {
      throw new UserProvisioningScopeError(400, 'A location is required to create this user.', 'LOCATION_REQUIRED');
    }
    const unit = await OrganizationUnit.findOne({ _id: requestedLocationId, tenantId: actor.tenantId, status: 'ACTIVE' })
      .select('_id').lean();
    if (!unit) {
      throw new UserProvisioningScopeError(400, 'The selected location is not a valid, active location for this tenant.', 'LOCATION_INVALID');
    }
    return { locationId: id(unit._id), method: 'TENANT_ADMIN_SELECTED_LOCATION' };
  }

  if (hasRole(actor, 'ACADEMIC_ADMIN')) {
    const homeLocationId = id(actor.primaryOrganizationUnitId);
    if (!homeLocationId) {
      throw new UserProvisioningScopeError(
        409,
        'Your account has no home location assigned yet. Ask your Tenant Admin to assign one before creating location-based users.',
        'ORGANIZATION_ASSIGNMENT_REQUIRED',
      );
    }
    // Client-supplied location is deliberately ignored here, not merely
    // overridden after a mismatch check — an Academic Admin can never
    // create a user outside their own home location, tampered payload or not.
    return { locationId: homeLocationId, method: 'ACADEMIC_ADMIN_INHERITED_LOCATION' };
  }

  if (hasRole(actor, 'TEACHER')) {
    if (!courseOfferingId) {
      throw new UserProvisioningScopeError(400, 'A class/course offering is required to add a student.', 'COURSE_OFFERING_REQUIRED');
    }
    const offering = await CourseOffering.findOne({
      _id: courseOfferingId, tenantId: actor.tenantId, facultyUserId: actor._id, status: 'ACTIVE',
    }).select('organizationUnitId').lean();
    if (!offering) {
      throw new UserProvisioningScopeError(403, 'You are not authorized to add students to this class.', 'COURSE_OFFERING_NOT_AUTHORIZED');
    }
    if (!offering.organizationUnitId) {
      throw new UserProvisioningScopeError(409, 'This class has no location assigned yet.', 'ORGANIZATION_ASSIGNMENT_REQUIRED');
    }
    return { locationId: id(offering.organizationUnitId), method: 'TEACHER_INHERITED_LOCATION' };
  }

  throw new UserProvisioningScopeError(403, 'This role is not authorized to create users.', 'ROLE_NOT_AUTHORIZED');
}

/** Single audit call site for every user-creation path so the event shape never drifts. */
export async function logUserProvisioningAudit({ req, actor, createdUser, createdRole, resolvedLocationId, scopeResolutionMethod }) {
  await logAuditEvent(AUDIT_ACTIONS.USER_CREATED, {
    userId: actor?._id || null,
    userRole: actor?.role || null,
    tenantId: actor?.tenantId || null,
    resourceType: 'User',
    resourceId: createdUser?._id,
    ip: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      createdBy: id(actor?._id),
      createdRole,
      resolvedLocationId,
      scopeResolutionMethod,
    },
  });
}
