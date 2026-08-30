import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolveMappingFromRoster,
  suggestFromRoster,
} from '../services/offlineEvaluation/candidateMatchingLogic.js';
import {
  resolveCandidateMapping,
  suggestCandidates,
  autoMapCandidate,
  assertNoDuplicateCandidateScript,
} from '../services/offlineEvaluation/candidateMappingService.js';

const roster = [
  { userId: 'u1', displayName: 'Rahul Sharma', normalizedName: 'rahul sharma', rollNumber: '17', normalizedRoll: '17', externalStudentId: '', enrollmentId: 'e1' },
  { userId: 'u4', displayName: 'Rahul Verma', normalizedName: 'rahul verma', rollNumber: '17', normalizedRoll: '17', externalStudentId: '', enrollmentId: 'e4' },
  { userId: 'u2', displayName: 'Rohan Sharma', normalizedName: 'rohan sharma', rollNumber: '19', normalizedRoll: '19', externalStudentId: '', enrollmentId: 'e2' },
  { userId: 'u3', displayName: 'Anaya Shah', normalizedName: 'anaya shah', rollNumber: '18', normalizedRoll: '18', externalStudentId: '', enrollmentId: 'e3' },
];

describe('candidateMatchingLogic — production matching rules', () => {
  test('roll exact match with compatible name auto-maps', () => {
    const result = resolveMappingFromRoster({
      roster,
      detectedRollNumber: '18',
      detectedCandidateName: 'Anaya Shah',
    });
    assert.equal(result.status, 'AUTO_MAP');
    assert.equal(result.candidateId, 'u3');
    assert.equal(result.method, 'ROLL_NUMBER');
  });

  test('conflicting roll numbers require manual mapping', () => {
    const result = resolveMappingFromRoster({
      roster,
      detectedRollNumber: '17',
      detectedCandidateName: 'Rahul Sharma',
    });
    assert.equal(result.status, 'NEEDS_MAPPING');
    assert.equal(result.conflict, 'ROLL_NOT_UNIQUE');
  });

  test('duplicate rahul names without roll require manual mapping', () => {
    const result = resolveMappingFromRoster({
      roster,
      detectedCandidateName: 'Rahul Sharma',
    });
    assert.equal(result.status, 'NEEDS_MAPPING');
    assert.ok(Array.isArray(result.suggestions));
  });

  test('file names never auto-map even when they contain a roster name', () => {
    const result = resolveMappingFromRoster({
      roster,
      originalFileName: 'Rahul Sharma.pdf',
    });
    assert.equal(result.status, 'NEEDS_MAPPING');
  });

  test('roll/name conflict against a different roster owner stays NEEDS_MAPPING', () => {
    const result = resolveMappingFromRoster({
      roster: [
        { userId: 'u2', displayName: 'Rohan Sharma', normalizedName: 'rohan sharma', rollNumber: '17', normalizedRoll: '17', externalStudentId: '', enrollmentId: 'e2' },
      ],
      detectedRollNumber: '17',
      detectedCandidateName: 'Rahul Sharma',
    });
    assert.equal(result.status, 'NEEDS_MAPPING');
    assert.equal(result.conflict, 'ROLL_NAME_MISMATCH');
  });

  test('optional mappingToken / QR is not required for auto-map', () => {
    const result = resolveMappingFromRoster({
      roster: [
        { userId: 'u9', displayName: 'Ravi', normalizedName: 'ravi', rollNumber: '21', normalizedRoll: '21', externalStudentId: 'AUS-3475', enrollmentId: null },
      ],
      detectedRollNumber: '21',
      detectedCandidateName: 'Ravi',
      mappingToken: '',
    });
    assert.equal(result.status, 'AUTO_MAP');
    assert.equal(result.candidateId, 'u9');
    assert.equal(result.method, 'ROLL_NUMBER');
  });

  test('exact external student ID wins before roll number', () => {
    const result = resolveMappingFromRoster({
      roster: [
        { userId: 'u1', displayName: 'Rahul Sharma', normalizedName: 'rahul sharma', rollNumber: '17', normalizedRoll: '17', externalStudentId: 'AUS-3475', enrollmentId: 'e1' },
        { userId: 'u2', displayName: 'Other Student', normalizedName: 'other student', rollNumber: '21', normalizedRoll: '21', externalStudentId: '', enrollmentId: 'e2' },
      ],
      detectedRollNumber: '21',
      detectedCandidateName: 'Other Student',
      detectedExternalStudentId: 'AUS-3475',
    });
    assert.equal(result.status, 'AUTO_MAP');
    assert.equal(result.candidateId, 'u1');
    assert.equal(result.method, 'CANDIDATE_ID');
  });

  test('two identical names with unreadable roll stay NEEDS_MAPPING', () => {
    const result = resolveMappingFromRoster({
      roster: [
        { userId: 'u1', displayName: 'Rahul Sharma', normalizedName: 'rahul sharma', rollNumber: '17', normalizedRoll: '17', externalStudentId: '', enrollmentId: 'e1' },
        { userId: 'u2', displayName: 'Rahul Sharma', normalizedName: 'rahul sharma', rollNumber: '22', normalizedRoll: '22', externalStudentId: '', enrollmentId: 'e2' },
      ],
      detectedCandidateName: 'Rahul Sharma',
      detectedRollNumber: '',
    });
    assert.equal(result.status, 'NEEDS_MAPPING');
    assert.equal(result.conflict, 'NAME_NOT_UNIQUE');
  });

  test('suggestFromRoster returns fuzzy suggestions ordered by score', () => {
    const suggestions = suggestFromRoster({ roster, detectedCandidateName: 'Anaya Shah' });
    assert.ok(suggestions.length >= 1);
    assert.equal(suggestions[0].userId, 'u3');
  });
});

describe('candidateMappingService — real module exports', () => {
  test('exports the production service functions', () => {
    assert.equal(typeof resolveCandidateMapping, 'function');
    assert.equal(typeof suggestCandidates, 'function');
    assert.equal(typeof autoMapCandidate, 'function');
    assert.equal(typeof assertNoDuplicateCandidateScript, 'function');
  });

  test('autoMapCandidate wraps resolveCandidateMapping', () => {
    assert.equal(autoMapCandidate.length, 1);
  });
});
