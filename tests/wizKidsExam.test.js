import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Exam from '../models/Exam.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import {
  SUPPORTED_EXAM_MODES,
  UNSUPPORTED_EXAM_MODES,
  WizKidsExamError,
  escapeRegExp,
} from '../services/wizKidsExamService.js';

// WizKids Phase 4 — Exam Integration.
// Covers: DOCS/XAMIGO_WIZKIDS_MASTER_DEVELOPMENT_PROMPT.md §17/§18/§29/§54
// Phase 4. Follows the same schema-introspection + pure-function test
// convention established in Phases 1-3 (see tests/wizKidsBatch.test.js for
// the rationale — this repo has no live-database test infrastructure).

describe('Exam.productModule — backward-compatible core discriminator', () => {
  test('defaults to STANDARD, so every pre-existing exam continues to behave exactly as before', () => {
    const path = Exam.schema.path('productModule');
    assert.equal(path.defaultValue, 'STANDARD');
  });

  test('only STANDARD and WIZKIDS are valid — no WizKids-specific values leak into the core enum', () => {
    const path = Exam.schema.path('productModule');
    assert.deepEqual(path.enumValues.sort(), ['STANDARD', 'WIZKIDS']);
  });

  test('is a distinct field from examType — delivery mechanism and product module are independent concerns (master prompt §17)', () => {
    const examTypePath = Exam.schema.path('examType');
    assert.deepEqual(examTypePath.enumValues.sort(), ['OMR', 'ONLINE']);
    // productModule values never appear in examType's enum and vice versa.
    const productModulePath = Exam.schema.path('productModule');
    assert.equal(examTypePath.enumValues.some((value) => productModulePath.enumValues.includes(value)), false);
  });

  test('a tenant-scoped {tenantId, productModule} index exists for efficient WizKids-exam listing', () => {
    const indexes = Exam.schema.indexes();
    assert.ok(indexes.some(([key]) => key.tenantId === 1 && key.productModule === 1));
  });
});

describe('WizKidsExamConfig schema — isolation from core Exam (master prompt §18)', () => {
  test('exactly one config per exam is enforced by a unique index on examId', () => {
    const indexes = WizKidsExamConfig.schema.indexes();
    assert.ok(indexes.some(([key, options]) => key.examId === 1 && options.unique === true));
  });

  test('mode supports all six conceptual modes from the master prompt, not just the four released in Phase 4', () => {
    const path = WizKidsExamConfig.schema.path('mode');
    assert.deepEqual(
      path.enumValues.sort(),
      ['COMPETITION', 'OLYMPIAD', 'PRACTICE', 'SPEED', 'TEST', 'WORKSHEET']
    );
  });

  test('gradeLevel matches WizKidsBatch — a plain 1-7 integer, no curriculum taxonomy (master prompt §20)', () => {
    const path = WizKidsExamConfig.schema.path('gradeLevel');
    assert.equal(path.options.min, 1);
    assert.equal(path.options.max, 7);
  });

  test('domains only allows the five defined WizKids content domains', () => {
    const path = WizKidsExamConfig.schema.path('domains');
    assert.deepEqual(
      [...path.caster.enumValues].sort(),
      ['LOGIC', 'MENTAL_MATHS', 'OLYMPIAD', 'SUPER_MATHS', 'VEDIC_MATHS']
    );
  });

  test('runtime fields stay inert by default; Speed-specific values are explicitly set only for SPEED configs', () => {
    assert.equal(WizKidsExamConfig.schema.path('instantFeedback').defaultValue, false);
    assert.equal(WizKidsExamConfig.schema.path('autoAdvance').defaultValue, false);
    assert.equal(WizKidsExamConfig.schema.path('questionTimerSeconds').defaultValue, null);
    assert.equal(WizKidsExamConfig.schema.path('allowBackNavigation').defaultValue, true);
  });
});

describe('Exam mode gating — only attempt-engine-ready modes are creatable', () => {
  test('TEST, WORKSHEET, COMPETITION, OLYMPIAD, PRACTICE, and (since Phase 8) SPEED are supported', () => {
    assert.deepEqual(
      [...SUPPORTED_EXAM_MODES].sort(),
      ['COMPETITION', 'OLYMPIAD', 'PRACTICE', 'SPEED', 'TEST', 'WORKSHEET']
    );
  });

  test('no schema mode is silently left unsupported after Phase 8', () => {
    assert.deepEqual([...UNSUPPORTED_EXAM_MODES], []);
  });

  test('supported + unsupported modes together cover every mode value the schema itself allows — no mode is forgotten by either list', () => {
    const schemaModes = [...WizKidsExamConfig.schema.path('mode').enumValues].sort();
    const coveredModes = [...SUPPORTED_EXAM_MODES, ...UNSUPPORTED_EXAM_MODES].sort();
    assert.deepEqual(coveredModes, schemaModes);
  });

  test('supported and unsupported mode lists never overlap', () => {
    const overlap = SUPPORTED_EXAM_MODES.filter((mode) => UNSUPPORTED_EXAM_MODES.includes(mode));
    assert.deepEqual(overlap, []);
  });
});

describe('WizKidsExamError', () => {
  test('carries an HTTP status and message, matching the established WizKidsBatchError/UserRoleError convention', () => {
    const error = new WizKidsExamError(403, 'The WIZKIDS_OLYMPIAD capability is not enabled for this tenant.');
    assert.equal(error.status, 403);
    assert.equal(error.name, 'WizKidsExamError');
    assert.ok(error instanceof Error);
  });
});

describe('Duplicate-title check regex safety', () => {
  test('special regex characters in a title are escaped, not interpreted as regex syntax', () => {
    // A title like "Grade 5 (Advanced)" must match only itself, not act as a
    // regex group/wildcard against unrelated exam titles.
    const escaped = escapeRegExp('Grade 5 (Advanced) Test.');
    const regex = new RegExp(`^${escaped}$`, 'i');
    assert.equal(regex.test('Grade 5 (Advanced) Test.'), true);
    assert.equal(regex.test('Grade 5 XAdvancedX Testx'), false);
  });

  test('handles missing/non-string input without throwing', () => {
    assert.equal(escapeRegExp(''), '');
    assert.equal(escapeRegExp(null), '');
    assert.equal(escapeRegExp(undefined), '');
  });
});
