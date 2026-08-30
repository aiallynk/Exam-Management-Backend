/**
 * SubTenant — LEGACY_COMPATIBILITY (commercial partition, NOT location boundary)
 *
 * Classification: B — COMMERCIAL / WHITE-LABEL PARTITION (plan-gated `multiTenant` feature).
 *
 * SubTenant is a tenant-internal commercial subdivision for backup scope, optional
 * user/exam tagging, and legacy multi-tenant plan customers. It is NOT a branch,
 * campus, school location, or academic boundary. OrganizationUnit owns those.
 *
 * Canonical V2 authorization uses: tenantId + OrganizationUnit + academic scope +
 * persona assignment. SubTenant must NOT participate in location/academic authorization.
 *
 * Sunset path:
 * - Existing SubTenant records and User.subTenantId / Exam.subTenantId fields remain readable.
 * - New V2 operational workflows must not create or depend on SubTenant for scope.
 * - Backup/restore SUB_TENANT scope remains for legacy compatibility only.
 * - Future migration may map SubTenant → OrganizationUnit only after explicit product decision.
 */
export const SUBTENANT_LEGACY_PURPOSE = 'LEGACY_COMPATIBILITY';

export const isSubTenantLegacyFeatureEnabled = (planFeatures = {}) =>
  Boolean(planFeatures?.multiTenant);

/** Returns true when a request attempts to set subTenantId on a V2 workflow that must not use it. */
export const shouldRejectSubTenantOnV2Workflow = ({ subTenantId, workflow = 'unknown' } = {}) => {
  const normalized = String(subTenantId || '').trim();
  if (!normalized) return false;
  const v2Workflows = new Set([
    'academic_assessment',
    'course_offering',
    'enrollment',
    'answer_script',
    'library_resource',
    'question_bank',
  ]);
  return v2Workflows.has(workflow);
};
