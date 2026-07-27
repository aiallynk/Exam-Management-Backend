import User from '../models/User.js';
import { ALL_ROLES, normalizeRoles, hasRole, hasAnyRole, hasAllRoles } from '../utils/userRoles.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { generateSecurePassword } from '../utils/passwordValidator.js';

/**
 * Single source of truth for creating tenant users and adding/removing
 * roles. Both the normal tenant-admin user-creation flow
 * (routes/tenantAdmin.js) and the evaluator-management convenience API
 * (routes/tenantEvaluators.js) must call this — the bug being corrected here
 * is precisely that a second, inconsistent creation path silently produced
 * role='CANDIDATE' for what should have been role='EVALUATOR'. There must be
 * exactly one place a user document is assembled.
 */

export class UserRoleError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UserRoleError';
    this.status = status;
  }
}

export { ALL_ROLES, normalizeRoles, hasRole, hasAnyRole, hasAllRoles };

// Evaluator access is an additional capability for the people who create
// exams.  It is intentionally not a conversion of candidates or tenant
// administrators into evaluators: their primary workspace and permissions
// remain untouched, while an Exam Creator gains EVALUATOR in roles[].
export const isExamCreatorEligibleForEvaluator = (user) =>
  user?.status === 'ACTIVE' && hasRole(user, 'EXAM_CREATOR');

/**
 * Whether a tenant may currently have EVALUATOR users at all (platform +
 * plan + tenant-toggle + dependency, via the existing capability resolver).
 * Every code path that persists role/roles = EVALUATOR must call this first
 * and reject rather than silently downgrading the role.
 */
export async function assertEvaluatorRoleAllowed(tenantId) {
  const feature = await resolveTenantFeature(tenantId, 'EVALUATOR_REVIEW');
  if (!feature?.effectiveEnabled) {
    throw new UserRoleError(403, 'Evaluator Review is not enabled for this tenant. Enable it under Features & Controls before creating or assigning evaluators.');
  }
  return feature;
}

/**
 * Create a new tenant user with a single, real primary role. Never silently
 * rewrites an unsupported/locked role to CANDIDATE — callers get a typed
 * UserRoleError (403/422) instead.
 */
export async function createTenantUser({
  name,
  email,
  password,
  role,
  tenantId,
  mobile,
  subTenantId,
  status,
  actorId,
  evaluatorAccess,
}) {
  if (!ALL_ROLES.includes(role)) {
    throw new UserRoleError(422, `Unsupported role: ${role}`);
  }
  if (role === 'SUPER_ADMIN') {
    throw new UserRoleError(422, 'SUPER_ADMIN accounts cannot be created through tenant user management.');
  }

  const existing = await User.findOne({ email: String(email || '').toLowerCase().trim() });
  if (existing) {
    throw new UserRoleError(409, 'Email is already registered.');
  }

  if (role === 'EVALUATOR') {
    await assertEvaluatorRoleAllowed(tenantId);
  }

  const user = new User({
    name,
    email,
    password: password || generateSecurePassword(),
    role,
    roles: [role],
    tenantId,
    mobile,
    subTenantId: subTenantId || null,
    status: status || 'ACTIVE',
  });

  if (role === 'EVALUATOR') {
    user.evaluatorAccess = {
      enabled: true,
      accessExpiresAt: evaluatorAccess?.accessExpiresAt || null,
      assignedAt: new Date(),
      assignedBy: actorId || null,
      removedAt: null,
      removedBy: null,
    };
  }

  await user.save();
  return user;
}

/**
 * Add a role to an existing user without touching their primary role or any
 * other role they hold. Returns { user, changed }.
 */
export async function addRole(user, role, { actorId, tenantId, accessExpiresAt } = {}) {
  if (!ALL_ROLES.includes(role)) {
    throw new UserRoleError(422, `Unsupported role: ${role}`);
  }
  if (role === 'EVALUATOR') {
    await assertEvaluatorRoleAllowed(tenantId ?? user.tenantId);
  }

  const current = new Set(normalizeRoles(user));
  const alreadyHasRole = current.has(role);
  const wasEnabled = user.evaluatorAccess?.enabled === true;
  current.add(role);
  user.roles = Array.from(current);

  if (role === 'EVALUATOR') {
    user.evaluatorAccess = {
      enabled: true,
      accessExpiresAt: accessExpiresAt !== undefined ? accessExpiresAt : (user.evaluatorAccess?.accessExpiresAt || null),
      assignedAt: user.evaluatorAccess?.assignedAt || new Date(),
      assignedBy: actorId || user.evaluatorAccess?.assignedBy || null,
      removedAt: null,
      removedBy: null,
    };
  }

  await user.save();
  return { user, changed: !alreadyHasRole, wasAlreadyEnabled: wasEnabled };
}

/**
 * Remove a role from an existing user, preserving every other role. Refuses
 * to strip a user's only/primary role (that would leave them unable to log
 * into any workspace) — the caller should disable evaluatorAccess instead in
 * that case, which is what routes/tenantEvaluators.js's DELETE handler does.
 */
export async function removeRole(user, role, { actorId } = {}) {
  const current = new Set(normalizeRoles(user));
  if (!current.has(role)) {
    return { user, changed: false, blocked: false };
  }

  // Refuse to remove a user's only role, and refuse to remove their current
  // primary role while it's the only thing keeping them logged into
  // anything — the model's own pre-save hook would silently re-add `role`
  // to `roles` anyway, so this check just makes that refusal explicit and
  // reported back to the caller instead of a silent no-op.
  const isOnlyRole = current.size <= 1;
  if (isOnlyRole || user.role === role) {
    return { user, changed: false, blocked: true };
  }

  current.delete(role);
  user.roles = Array.from(current);

  if (role === 'EVALUATOR') {
    user.evaluatorAccess = {
      ...(user.evaluatorAccess?.toObject?.() || user.evaluatorAccess || {}),
      enabled: false,
      removedAt: new Date(),
      removedBy: actorId || null,
    };
  }

  await user.save();
  return { user, changed: true, blocked: false };
}
