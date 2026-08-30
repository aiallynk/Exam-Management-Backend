import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCandidateAcademicProfile,
  hasCandidateAcademicProfile,
} from '../utils/candidateAcademicProfile.js';

describe('normalizeCandidateAcademicProfile', () => {
  test('maps current optional fields', () => {
    assert.deepEqual(
      normalizeCandidateAcademicProfile({
        rollNumber: ' 17 ',
        grade: '10',
        section: 'A',
        externalStudentId: 'STU-17',
      }),
      {
        rollNumber: '17',
        grade: '10',
        section: 'A',
        externalStudentId: 'STU-17',
        gradeLevel: 10,
      }
    );
  });

  test('accepts legacy junior class/division/gradeLevel without keeping those field names as required', () => {
    const normalized = normalizeCandidateAcademicProfile({
      gradeLevel: 5,
      className: '5',
      division: 'B',
      rollNumber: '08',
    });
    assert.equal(normalized.rollNumber, '08');
    assert.equal(normalized.grade, '5');
    assert.equal(normalized.section, 'B');
    assert.equal(normalized.gradeLevel, 5);
    assert.equal(normalized.className, undefined);
    assert.equal(normalized.division, undefined);
  });

  test('keeps non-numeric grades as free text', () => {
    const normalized = normalizeCandidateAcademicProfile({ grade: 'FYJC' });
    assert.equal(normalized.grade, 'FYJC');
    assert.equal(normalized.gradeLevel, undefined);
  });

  test('treats empty input as empty optional profile', () => {
    assert.equal(hasCandidateAcademicProfile(normalizeCandidateAcademicProfile({})), false);
    assert.equal(hasCandidateAcademicProfile(normalizeCandidateAcademicProfile({ gradeLevel: '' })), false);
  });
});
