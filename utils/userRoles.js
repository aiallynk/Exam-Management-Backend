/**
 * Pure, dependency-free multi-role helpers shared by authorization
 * middleware and the user-role service. Kept separate from
 * services/userRoleService.js (which needs the User model for writes) so
 * middleware/roles.js can import just these functions without pulling in
 * Mongoose.
 *
 * Every helper accepts either a full Mongoose user document, a lean object,
 * or the trimmed `req.user` shape attached by middleware/auth.js — anything
 * with `role` and/or `roles`.
 */

export const ALL_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'ACADEMIC_ADMIN',
  'TEACHER',
  'EXAM_CREATOR',
  'CANDIDATE',
  'EVALUATOR',
]);

/**
 * The authoritative role list for a user. Falls back to `[role]` for any
 * user/token predating the `roles` field, so this is safe to call on every
 * user shape the app has ever produced.
 */
export const normalizeRoles = (user) => {
  if (!user) return [];
  if (Array.isArray(user.roles) && user.roles.length) {
    return user.roles.filter(Boolean);
  }
  return user.role ? [user.role] : [];
};

export const hasRole = (user, role) => normalizeRoles(user).includes(role);

export const hasAnyRole = (user, roles = []) => {
  const userRoles = normalizeRoles(user);
  return roles.some((role) => userRoles.includes(role));
};

export const hasAllRoles = (user, roles = []) => {
  const userRoles = normalizeRoles(user);
  return roles.every((role) => userRoles.includes(role));
};
