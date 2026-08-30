export const GOVERNANCE_SCOPE_FIELDS = Object.freeze({
  organizationUnitId: 'organization-units',
  programId: 'programs',
  curriculumVersionId: 'curriculum-versions',
  academicPeriodId: 'academic-periods',
  courseId: 'courses',
});

export const governanceScopeValues = (value) =>
  Array.isArray(value) ? value.filter(Boolean).map(String) : value ? [String(value)] : [];

export const isGlobalGovernanceScope = (scope = {}) =>
  !Object.keys(GOVERNANCE_SCOPE_FIELDS).some((field) => governanceScopeValues(scope?.[field]).length);

export const isGovernanceScopeReadable = (visibility, scope = {}) => {
  if (visibility.all || isGlobalGovernanceScope(scope)) return true;
  return Object.entries(GOVERNANCE_SCOPE_FIELDS).every(([field, resource]) => {
    const requested = governanceScopeValues(scope?.[field]);
    return !requested.length || requested.some((item) => (visibility.ids?.[resource] || []).includes(item));
  });
};
