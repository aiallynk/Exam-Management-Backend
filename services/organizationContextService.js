import User from '../models/User.js';
import { OrganizationUnit, CourseOffering } from '../models/academic/index.js';
import { hasRole } from '../utils/userRoles.js';

const id = (value) => (value == null ? '' : String(value));
const uniqueIds = (values = []) => [...new Set(values.filter(Boolean).map(id))];

export class OrganizationContextError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OrganizationContextError';
    this.status = status;
    this.statusCode = status;
  }
}

const loadCurrentUser = async (rawUser) => {
  if (!rawUser?._id) throw new OrganizationContextError(401, 'Authentication required.');
  return User.findById(rawUser._id)
    .select('_id tenantId role roles status primaryOrganizationUnitId organizationUnitAccess organizationPreferences academicAdminScope')
    .lean();
};

export const expandOrganizationUnits = async (tenantId, initialIds = []) => {
  const allowed = new Set(uniqueIds(initialIds));
  if (!allowed.size) return [];
  const units = await OrganizationUnit.find({ tenantId }).select('_id parentOrganizationUnitId').lean();
  let changed = true;
  while (changed) {
    changed = false;
    units.forEach((unit) => {
      if (unit.parentOrganizationUnitId && allowed.has(id(unit.parentOrganizationUnitId)) && !allowed.has(id(unit._id))) {
        allowed.add(id(unit._id));
        changed = true;
      }
    });
  }
  return [...allowed];
};

// Content scoped to an institution/root unit must remain readable to an
// eligible person working in one of its descendants. This is deliberately
// the inverse of expandOrganizationUnits(): it adds only ancestors of the
// user's already-authorized units and never grants access to a sibling or
// descendant merely because the user can see a parent in navigation.
export const expandOrganizationUnitAncestors = async (tenantId, initialIds = []) => {
  const allowed = new Set(uniqueIds(initialIds));
  if (!allowed.size) return [];
  const units = await OrganizationUnit.find({ tenantId }).select('_id parentOrganizationUnitId').lean();
  const parentById = new Map(units.map((unit) => [id(unit._id), id(unit.parentOrganizationUnitId)]));
  [...allowed].forEach((unitId) => {
    let cursor = parentById.get(unitId);
    while (cursor && !allowed.has(cursor)) {
      allowed.add(cursor);
      cursor = parentById.get(cursor);
    }
  });
  return [...allowed];
};

const loadActiveOrganizationUnits = async (tenantId, unitIds = []) => {
  if (!unitIds.length) return [];
  return OrganizationUnit.find({ tenantId, _id: { $in: unitIds }, status: 'ACTIVE' })
    .select('_id name code type parentOrganizationUnitId')
    .sort({ name: 1 })
    .lean();
};

const resolveRoleDerivedScope = async (user) => {
  const tenantId = user.tenantId;
  if (hasRole(user, 'TENANT_ADMIN')) {
    const units = await OrganizationUnit.find({ tenantId, status: 'ACTIVE' }).select('_id').lean();
    return { all: true, unitIds: units.map((unit) => id(unit._id)) };
  }
  if (hasRole(user, 'ACADEMIC_ADMIN')) {
    if (user.academicAdminScope?.wholeTenant === true) {
      const units = await OrganizationUnit.find({ tenantId, status: 'ACTIVE' }).select('_id').lean();
      return { all: true, unitIds: units.map((unit) => id(unit._id)) };
    }
    const unitIds = await expandOrganizationUnits(tenantId, user.academicAdminScope?.organizationUnitIds || []);
    return { all: false, unitIds };
  }
  if (hasRole(user, 'TEACHER') || hasRole(user, 'EXAM_CREATOR')) {
    const offeringScope = hasRole(user, 'TEACHER')
      ? { facultyUserId: user._id }
      : { assessmentCreatorUserIds: user._id };
    const offerings = await CourseOffering.find({ tenantId, ...offeringScope, status: 'ACTIVE' })
      .select('organizationUnitId')
      .lean();
    return { all: false, unitIds: uniqueIds(offerings.map((item) => item.organizationUnitId)) };
  }
  return { all: false, unitIds: [] };
};

const explicitOrganizationUnitIds = (user) => uniqueIds([
  user.primaryOrganizationUnitId,
  ...(Array.isArray(user.organizationUnitAccess) ? user.organizationUnitAccess.map((entry) => entry?.organizationUnitId) : []),
]);

/**
 * Resolve organization units a user may operate within for navigation and narrowing.
 * Authorization for mutations still goes through academicAccessService.
 */
export async function resolveAuthorizedOrganizationUnits(rawUser) {
  const user = await loadCurrentUser(rawUser);
  if (!user || user.status !== 'ACTIVE') throw new OrganizationContextError(403, 'Account is not active.');
  if (!user.tenantId) throw new OrganizationContextError(403, 'A tenant workspace is required.');

  const roleDerived = await resolveRoleDerivedScope(user);
  const explicitIds = explicitOrganizationUnitIds(user);
  let unitIds = [];
  let all = roleDerived.all;

  if (explicitIds.length) {
    if (roleDerived.all) {
      unitIds = explicitIds.length ? explicitIds : roleDerived.unitIds;
    } else if (roleDerived.unitIds.length) {
      // Explicit grants narrow role-derived scope when both exist.
      const roleSet = new Set(roleDerived.unitIds);
      const narrowed = explicitIds.filter((unitId) => roleSet.has(unitId));
      unitIds = narrowed.length ? narrowed : roleDerived.unitIds;
      all = false;
    } else {
      unitIds = explicitIds;
      all = false;
    }
  } else {
    unitIds = roleDerived.unitIds;
    all = roleDerived.all;
  }

  if (!unitIds.length && all) {
    const units = await loadActiveOrganizationUnits(user.tenantId, roleDerived.unitIds);
    return { tenantId: user.tenantId, user, all: true, units, unitIds: units.map((unit) => id(unit._id)) };
  }

  const units = await loadActiveOrganizationUnits(user.tenantId, unitIds);
  return {
    tenantId: user.tenantId,
    user,
    all: all && units.length > 1,
    units,
    unitIds: units.map((unit) => id(unit._id)),
  };
}

const isUnitAuthorized = (authorized, unitId) => {
  if (!unitId) return false;
  if (authorized.all && hasRole(authorized.user, 'TENANT_ADMIN')) return true;
  return authorized.unitIds.includes(id(unitId));
};

/**
 * Resolve the effective organization navigation context for the signed-in user.
 */
export async function resolveOrganizationContext(rawUser, { requestedUnitId = null, persist = false } = {}) {
  const authorized = await resolveAuthorizedOrganizationUnits(rawUser);
  const { user, units, unitIds } = authorized;

  if (requestedUnitId && !isUnitAuthorized(authorized, requestedUnitId)) {
    throw new OrganizationContextError(403, 'You do not have access to that organization unit.');
  }

  const preferenceId = user.organizationPreferences?.activeOrganizationUnitId;
  const primaryId = user.primaryOrganizationUnitId;

  let currentOrganizationUnitId = null;
  if (requestedUnitId) {
    currentOrganizationUnitId = id(requestedUnitId);
    if (persist) {
      await User.updateOne(
        { _id: user._id },
        { $set: { 'organizationPreferences.activeOrganizationUnitId': requestedUnitId } },
      );
    }
  } else if (preferenceId && isUnitAuthorized(authorized, preferenceId)) {
    currentOrganizationUnitId = id(preferenceId);
  } else if (primaryId && isUnitAuthorized(authorized, primaryId)) {
    currentOrganizationUnitId = id(primaryId);
  } else if (unitIds.length === 1) {
    currentOrganizationUnitId = unitIds[0];
  } else if (unitIds.length > 1) {
    currentOrganizationUnitId = unitIds[0];
  }

  const currentOrganizationUnit = currentOrganizationUnitId
    ? units.find((unit) => id(unit._id) === currentOrganizationUnitId)
      || await OrganizationUnit.findOne({ _id: currentOrganizationUnitId, tenantId: user.tenantId, status: 'ACTIVE' })
        .select('_id name code type parentOrganizationUnitId')
        .lean()
    : null;

  return {
    tenantId: authorized.tenantId,
    authorizedUnits: units,
    currentOrganizationUnitId,
    currentOrganizationUnit,
    primaryOrganizationUnitId: primaryId ? id(primaryId) : null,
    showSwitcher: units.length > 1,
    autoSelected: units.length <= 1 && Boolean(currentOrganizationUnitId),
    allOrganizations: authorized.all,
  };
}

export async function assertOrganizationUnitAccess(rawUser, organizationUnitId) {
  if (!organizationUnitId) return true;
  const authorized = await resolveAuthorizedOrganizationUnits(rawUser);
  if (isUnitAuthorized(authorized, organizationUnitId)) return true;
  throw new OrganizationContextError(403, 'Organization unit is outside your authorized scope.');
}

export async function selectOrganizationContext(rawUser, organizationUnitId) {
  return resolveOrganizationContext(rawUser, { requestedUnitId: organizationUnitId, persist: true });
}

const ORG_SCOPED_RESOURCES = new Set([
  'organization-units',
  'programs',
  'course-offerings',
]);

export function narrowAcademicFilterByOrganization(filter = {}, resourcePath, organizationUnitId) {
  if (!organizationUnitId || !ORG_SCOPED_RESOURCES.has(resourcePath)) return filter;
  if (resourcePath === 'organization-units') {
    return { ...filter, _id: organizationUnitId };
  }
  return { ...filter, organizationUnitId };
}
