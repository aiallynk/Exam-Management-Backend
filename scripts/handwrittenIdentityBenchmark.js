#!/usr/bin/env node
/**
 * Controlled handwritten identity/matching benchmark.
 *
 * Default: DRY RUN against the local matching rules + fixture ground truth.
 * Does NOT call Gemini, does NOT connect to shared MongoDB.
 *
 * Live Gemini pages remain explicitly opt-in:
 *   LIVE_GEMINI_BENCHMARK=1 NODE_ENV=test TEST_MONGODB_URI=mongodb://127.0.0.1:27017/xamigo_phase5_e2e_hw \
 *     node scripts/handwrittenIdentityBenchmark.js
 */
import { resolveMappingFromRoster } from '../services/offlineEvaluation/candidateMatchingLogic.js';

const roster = [
  { userId: 'rahul-17', displayName: 'Rahul Sharma', normalizedName: 'rahul sharma', rollNumber: '17', normalizedRoll: '17', externalStudentId: 'DVL-17', enrollmentId: 'e17' },
  { userId: 'anaya-18', displayName: 'Anaya Shah', normalizedName: 'anaya shah', rollNumber: '18', normalizedRoll: '18', externalStudentId: 'DVL-18', enrollmentId: 'e18' },
  { userId: 'rohan-19', displayName: 'Rohan Patil', normalizedName: 'rohan patil', rollNumber: '19', normalizedRoll: '19', externalStudentId: 'DVL-19', enrollmentId: 'e19' },
  { userId: 'rahul-22', displayName: 'Rahul Sharma', normalizedName: 'rahul sharma', rollNumber: '22', normalizedRoll: '22', externalStudentId: 'DVL-22', enrollmentId: 'e22' },
];

const fixtures = [
  { id: 'clear-print-anaya', extracted: { candidateName: 'Anaya Shah', rollNumber: '18' }, expect: { status: 'AUTO_MAP', candidateId: 'anaya-18' } },
  { id: 'clear-print-rohan', extracted: { candidateName: 'Rohan Patil', rollNumber: '19' }, expect: { status: 'AUTO_MAP', candidateId: 'rohan-19' } },
  { id: 'cursive-rahul-17', extracted: { candidateName: 'Rahul Sharma', rollNumber: '17' }, expect: { status: 'AUTO_MAP', candidateId: 'rahul-17' } },
  { id: 'filename-only-rahul', extracted: { originalFileName: 'Rahul.pdf' }, expect: { status: 'NEEDS_MAPPING' } },
  { id: 'duplicate-name-no-roll', extracted: { candidateName: 'Rahul Sharma' }, expect: { status: 'NEEDS_MAPPING' } },
  { id: 'roll-name-conflict', extracted: { candidateName: 'Rahul Sharma', rollNumber: '19' }, expect: { status: 'NEEDS_MAPPING' } },
  { id: 'roll-only-unique', extracted: { rollNumber: '18' }, expect: { status: 'AUTO_MAP', candidateId: 'anaya-18' } },
  { id: 'mumbai-same-roll-not-in-roster', extracted: { candidateName: 'Rahul Sharma', rollNumber: '17', foreignLocationHint: 'Mumbai' }, expect: { status: 'AUTO_MAP', candidateId: 'rahul-17' } },
];

const liveRequested = process.env.LIVE_GEMINI_BENCHMARK === '1';
let falseAutoMaps = 0;
let passed = 0;

for (const fixture of fixtures) {
  const result = resolveMappingFromRoster({
    roster,
    detectedCandidateName: fixture.extracted.candidateName,
    detectedRollNumber: fixture.extracted.rollNumber,
    originalFileName: fixture.extracted.originalFileName || `${fixture.id}.pdf`,
  });
  const ok = result.status === fixture.expect.status
    && (!fixture.expect.candidateId || result.candidateId === fixture.expect.candidateId);
  if (result.status === 'AUTO_MAP' && fixture.expect.status === 'NEEDS_MAPPING') falseAutoMaps += 1;
  if (ok) passed += 1;
  else console.error(`[benchmark] FAIL ${fixture.id}`, { result, expect: fixture.expect });
}

console.log(JSON.stringify({
  mode: liveRequested ? 'LIVE_GEMINI_REQUESTED_BUT_FIXTURE_MATCHING_ONLY' : 'DRY_RUN_MATCHING',
  fixtures: fixtures.length,
  passed,
  falseAutoMaps,
  handwritingExtraction: 'UNVERIFIED',
  note: liveRequested
    ? 'Live Gemini was requested, but this runner still evaluates matching against human-reviewed extracted fields. Page-image Gemini scoring requires disposable fixtures and is not executed against shared Mongo.'
    : 'Matching-rule benchmark only. Real handwritten Gemini accuracy remains UNVERIFIED until disposable image fixtures are run.',
}, null, 2));

if (falseAutoMaps > 0 || passed !== fixtures.length) process.exit(1);
