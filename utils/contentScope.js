// Content Library scope-readability check — mirrors utils/governanceScope.js's
// pattern exactly, but over the fuller academic-scope field set a content
// source can carry (Blueprint section 7A / Part G), keyed against the same
// `visibility.ids` shape services/academicAccessService.js#resolveAcademicVisibility
// already returns. Kept as its own small module rather than widening
// governanceScope.js's GOVERNANCE_SCOPE_FIELDS, since that file's 5-field set
// is a distinct, already-relied-upon contract for framework/rubric scope.
export const CONTENT_SCOPE_FIELDS = Object.freeze({
  organizationUnitId: 'organization-units',
  academicSessionId: 'academic-sessions',
  programId: 'programs',
  specializationId: 'specializations',
  curriculumVersionId: 'curriculum-versions',
  academicPeriodId: 'academic-periods',
  courseId: 'courses',
  courseOfferingId: 'course-offerings',
  cohortId: 'cohorts',
  academicSectionId: 'academic-sections',
});

export const contentScopeValues = (value) =>
  Array.isArray(value) ? value.filter(Boolean).map(String) : value ? [String(value)] : [];

export const isGlobalContentScope = (scope = {}) =>
  !Object.keys(CONTENT_SCOPE_FIELDS).some((field) => contentScopeValues(scope?.[field]).length);

// True when every non-empty field on `scope` is within `visibility`'s
// resolved ids (or visibility.all). An empty scope is globally readable —
// callers that need "PRIVATE means owner-only regardless of scope" must
// check ownership themselves before calling this; this function only
// answers "does this scope fall within this user's academic reach."
export const isContentScopeReadable = (visibility, scope = {}) => {
  if (visibility?.all || isGlobalContentScope(scope)) return true;
  return Object.entries(CONTENT_SCOPE_FIELDS).every(([field, resource]) => {
    const requested = contentScopeValues(scope?.[field]);
    return !requested.length || requested.some((item) => (visibility.ids?.[resource] || []).includes(item));
  });
};
