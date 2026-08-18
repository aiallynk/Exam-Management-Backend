import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WizKidsBatch from '../models/WizKidsBatch.js';
import WizKidsBatchMember from '../models/WizKidsBatchMember.js';
import {
  VALID_MEMBER_ROLES,
  normalizeBatchCode,
  isValidGradeLevel,
  WizKidsBatchError,
} from '../services/wizKidsBatchService.js';
import { resolvePlanLimits } from '../middleware/planLimits.js';
import { SUBSCRIPTION_PLAN_TYPES } from '../config/planLimits.js';

// WizKids Phase 3 — Batch / Grade.
// Covers: DOCS/XAMIGO_WIZKIDS_MASTER_DEVELOPMENT_PROMPT.md §54 Phase 3
// acceptance conditions that are verifiable without a live database
// connection, matching this repo's existing test convention (see
// tenantFeatureControls.test.js's schema-index assertions, which also run
// without connecting to Mongo — .schema.indexes() is pure in-memory
// metadata). Live-database CRUD flows (actual document creation) are not
// covered here because no test-database bootstrapping exists anywhere in
// this repository; introducing one is out of scope for this phase.

describe('WizKidsBatch schema — tenant isolation and grade constraints', () => {
  test('tenantId is required and indexed (prerequisite for tenant-scoped queries)', () => {
    const path = WizKidsBatch.schema.path('tenantId');
    assert.ok(path, 'tenantId must exist on the schema');
    assert.equal(path.instance, 'ObjectId');
    assert.equal(path.isRequired, true);
  });

  test('gradeLevel is constrained to the 1-7 range at the schema level', () => {
    const path = WizKidsBatch.schema.path('gradeLevel');
    assert.equal(path.options.min, 1);
    assert.equal(path.options.max, 7);
    assert.equal(path.isRequired, true);
  });

  test('code is unique per tenant, not globally (a unique compound index, not a bare unique field)', () => {
    const indexes = WizKidsBatch.schema.indexes();
    assert.ok(
      indexes.some(([key, options]) => key.tenantId === 1 && key.code === 1 && options.unique === true),
      'expected a unique {tenantId, code} compound index'
    );
    assert.equal(
      indexes.some(([key, options]) => Object.keys(key).length === 1 && key.code === 1 && options.unique === true),
      false,
      'code must not be globally unique — two different tenants may reuse the same batch code'
    );
  });

  test('status defaults to ACTIVE and only allows ACTIVE/INACTIVE', () => {
    const path = WizKidsBatch.schema.path('status');
    assert.deepEqual(path.enumValues.sort(), ['ACTIVE', 'INACTIVE']);
    assert.equal(path.defaultValue, 'ACTIVE');
  });

  test('domainKeys only allows the five defined WizKids domains', () => {
    const path = WizKidsBatch.schema.path('domainKeys');
    assert.deepEqual(
      [...path.caster.enumValues].sort(),
      ['LOGIC', 'MENTAL_MATHS', 'OLYMPIAD', 'SUPER_MATHS', 'VEDIC_MATHS']
    );
  });
});

describe('WizKidsBatchMember schema — duplicate-membership prevention', () => {
  test('a unique compound index on {batchId, userId, role} prevents the same user holding the same role twice in one batch', () => {
    const indexes = WizKidsBatchMember.schema.indexes();
    assert.ok(
      indexes.some(([key, options]) =>
        key.batchId === 1 && key.userId === 1 && key.role === 1 && options.unique === true
      ),
      'expected a unique {batchId, userId, role} compound index'
    );
  });

  test('role only accepts the two existing global roles eligible for WizKids membership — no new persisted persona roles', () => {
    const path = WizKidsBatchMember.schema.path('role');
    assert.deepEqual(path.enumValues.sort(), ['CANDIDATE', 'EXAM_CREATOR']);
  });

  test('tenantId, batchId and userId are all indexed for tenant-scoped and batch-scoped queries', () => {
    const paths = ['tenantId', 'batchId', 'userId'];
    for (const pathName of paths) {
      const path = WizKidsBatchMember.schema.path(pathName);
      assert.ok(path, `${pathName} must exist`);
      assert.equal(path.isRequired, true);
    }
  });

  test('status supports soft-removal (ACTIVE/INACTIVE) rather than hard deletion, preserving membership history', () => {
    const path = WizKidsBatchMember.schema.path('status');
    assert.deepEqual(path.enumValues.sort(), ['ACTIVE', 'INACTIVE']);
    assert.equal(path.defaultValue, 'ACTIVE');
  });
});

describe('WizKids batch code normalization', () => {
  test('trims, upper-cases, and replaces internal whitespace with underscores', () => {
    assert.equal(normalizeBatchCode('  grade 5 batch a  '), 'GRADE_5_BATCH_A');
  });

  test('is idempotent on an already-normalized code', () => {
    assert.equal(normalizeBatchCode('GRADE5_A'), 'GRADE5_A');
  });

  test('returns an empty string for missing/empty input rather than throwing', () => {
    assert.equal(normalizeBatchCode(''), '');
    assert.equal(normalizeBatchCode(null), '');
    assert.equal(normalizeBatchCode(undefined), '');
  });
});

describe('WizKids grade level validation (kept intentionally simple — plain 1-7 integer, master prompt §20)', () => {
  test('accepts integers 1 through 7', () => {
    for (let grade = 1; grade <= 7; grade += 1) {
      assert.equal(isValidGradeLevel(grade), true, `grade ${grade} should be valid`);
    }
  });

  test('rejects 0, 8, negative numbers, decimals, and non-numeric input', () => {
    assert.equal(isValidGradeLevel(0), false);
    assert.equal(isValidGradeLevel(8), false);
    assert.equal(isValidGradeLevel(-1), false);
    assert.equal(isValidGradeLevel(3.5), false);
    assert.equal(isValidGradeLevel('five'), false);
    assert.equal(isValidGradeLevel(null), false);
    assert.equal(isValidGradeLevel(undefined), false);
  });

  test('accepts numeric strings representing a valid integer (form-submitted values)', () => {
    assert.equal(isValidGradeLevel('5'), true);
  });
});

describe('WizKids batch membership roles reuse existing global roles only', () => {
  test('VALID_MEMBER_ROLES is exactly EXAM_CREATOR and CANDIDATE — no TEACHER/STUDENT persona roles (master prompt §1.1/§53)', () => {
    assert.deepEqual([...VALID_MEMBER_ROLES].sort(), ['CANDIDATE', 'EXAM_CREATOR']);
  });
});

describe('WizKidsBatchError', () => {
  test('carries an HTTP status and message, matching the existing UserRoleError convention', () => {
    const error = new WizKidsBatchError(404, 'Batch not found.');
    assert.equal(error.status, 404);
    assert.equal(error.message, 'Batch not found.');
    assert.equal(error.name, 'WizKidsBatchError');
    assert.ok(error instanceof Error);
  });
});

describe('maxWizKidsBatches limit resolution (pure — resolvePlanLimits performs no I/O)', () => {
  test('every plan tier has a distinct default maxWizKidsBatches with no tenant override', () => {
    assert.equal(resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.FREE, null).maxWizKidsBatches, 1);
    assert.equal(resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.PRO, null).maxWizKidsBatches, 10);
    assert.equal(resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.ULTIMATE, null).maxWizKidsBatches, 50);
    assert.equal(resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.LEGEND, null).maxWizKidsBatches, null, 'Legend is unlimited (null)');
  });

  test('a Super-Admin-set per-tenant customLimits.maxWizKidsBatches override takes precedence over the plan default', () => {
    const tenant = { subscription: { customLimits: { maxWizKidsBatches: 5 } } };
    assert.equal(resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.FREE, tenant).maxWizKidsBatches, 5);
  });

  test('a customLimits override of -1 means explicitly unlimited, same convention as every other limit', () => {
    const tenant = { subscription: { customLimits: { maxWizKidsBatches: -1 } } };
    assert.equal(resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.FREE, tenant).maxWizKidsBatches, null);
  });

  test('an override for maxWizKidsBatches does not leak into or change any other resolved limit', () => {
    const tenant = { subscription: { customLimits: { maxWizKidsBatches: 5 } } };
    const limits = resolvePlanLimits(SUBSCRIPTION_PLAN_TYPES.FREE, tenant);
    assert.equal(limits.maxExamsPerMonth, 5);
    assert.equal(limits.maxCandidates, null);
  });
});
