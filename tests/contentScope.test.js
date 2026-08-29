import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_SCOPE_FIELDS, contentScopeValues, isGlobalContentScope, isContentScopeReadable } from '../utils/contentScope.js';

describe('contentScopeValues', () => {
  test('normalizes a single id, an array of ids, and empty input', () => {
    assert.deepEqual(contentScopeValues('a'), ['a']);
    assert.deepEqual(contentScopeValues(['a', 'b', null, undefined]), ['a', 'b']);
    assert.deepEqual(contentScopeValues(null), []);
    assert.deepEqual(contentScopeValues(undefined), []);
  });
});

describe('isGlobalContentScope', () => {
  test('true for an empty scope', () => {
    assert.equal(isGlobalContentScope({}), true);
    assert.equal(isGlobalContentScope(), true);
  });

  test('false once any covered field has a value', () => {
    assert.equal(isGlobalContentScope({ courseId: 'course-1' }), false);
    assert.equal(isGlobalContentScope({ cohortId: 'cohort-1' }), false);
  });

  test('a field outside CONTENT_SCOPE_FIELDS does not count', () => {
    assert.equal(isGlobalContentScope({ someUnrelatedField: 'x' }), true);
  });
});

describe('isContentScopeReadable', () => {
  test('visibility.all always reads regardless of scope', () => {
    assert.equal(isContentScopeReadable({ all: true }, { courseId: 'course-1' }), true);
  });

  test('an empty/global scope is readable by anyone', () => {
    assert.equal(isContentScopeReadable({ all: false, ids: {} }, {}), true);
  });

  test('a bounded user sees a scope only when every non-empty field is within their visible ids', () => {
    const visibility = { all: false, ids: { courses: ['course-1'], programs: ['program-1'] } };
    assert.equal(isContentScopeReadable(visibility, { courseId: 'course-1' }), true);
    assert.equal(isContentScopeReadable(visibility, { courseId: 'course-2' }), false);
    assert.equal(isContentScopeReadable(visibility, { courseId: 'course-1', programId: 'program-9' }), false);
  });

  test('every CONTENT_SCOPE_FIELDS key maps to a visibility.ids resource the resolver actually returns', () => {
    const knownResources = new Set([
      'organization-units', 'academic-sessions', 'programs', 'specializations',
      'curriculum-versions', 'academic-periods', 'courses', 'course-offerings',
      'cohorts', 'academic-sections',
    ]);
    Object.values(CONTENT_SCOPE_FIELDS).forEach((resource) => assert.ok(knownResources.has(resource), `unexpected resource key: ${resource}`));
  });

  test('an unrelated teacher (no matching ids at all) cannot read a scoped course source', () => {
    const unrelatedTeacherVisibility = { all: false, ids: { courses: ['grade-10-math'], programs: ['grade-10'] } };
    const gradeSevenScienceScope = { programId: 'grade-7', courseId: 'science' };
    assert.equal(isContentScopeReadable(unrelatedTeacherVisibility, gradeSevenScienceScope), false);
  });
});
