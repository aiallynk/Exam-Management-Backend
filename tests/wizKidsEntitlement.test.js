import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  TENANT_CAPABILITIES,
  CONTROL_CATEGORY_DEFINITIONS,
  WIZKIDS_CAPABILITY_KEYS,
  WIZKIDS_PLAN_FEATURE_KEYS,
  resolveCapabilityEffectiveState,
  canTenantUpdateFeature,
} from '../services/tenantFeatureService.js';
import { isPlanFeatureEnabled, SUBSCRIPTION_PLAN_TYPES } from '../config/planLimits.js';

// WizKids Phase 1 — Entitlement Foundation.
// Covers: DOCS/XAMIGO_WIZKIDS_MASTER_DEVELOPMENT_PROMPT.md §54 Phase 1 acceptance
// conditions, and the automated feature-control matrix in §56.

const WIZKIDS_CHILD_KEYS = [
  'WIZKIDS_MENTAL_MATHS',
  'WIZKIDS_VEDIC_MATHS',
  'WIZKIDS_SUPER_MATHS',
  'WIZKIDS_LOGIC',
  'WIZKIDS_OLYMPIAD',
  'WIZKIDS_PRACTICE',
  'WIZKIDS_SPEED_MODE',
  'WIZKIDS_GENERATED_QUESTIONS',
  'WIZKIDS_VISUAL_QUESTIONS',
];

describe('WizKids capability catalogue shape', () => {
  test('WIZKIDS parent capability is registered with a plan-gated, default-off entitlement', () => {
    const parent = TENANT_CAPABILITIES.WIZKIDS;
    assert.ok(parent, 'WIZKIDS must be registered in TENANT_CAPABILITIES');
    assert.equal(parent.planFeature, 'wizKids');
    assert.equal(parent.releaseStatus, 'RELEASED');
    assert.equal(parent.dependsOn, undefined, 'the parent capability must not depend on anything');
  });

  test('every WizKids child capability depends on the WIZKIDS parent and has its own planFeature', () => {
    for (const key of WIZKIDS_CHILD_KEYS) {
      const child = TENANT_CAPABILITIES[key];
      assert.ok(child, `${key} must be registered in TENANT_CAPABILITIES`);
      assert.deepEqual(child.dependsOn, ['WIZKIDS'], `${key} must depend on WIZKIDS`);
      assert.equal(typeof child.planFeature, 'string');
      assert.ok(child.planFeature.startsWith('wizKids'), `${key}.planFeature should be a wizKids* plan-feature key`);
      assert.equal(child.group, 'WizKids');
    }
  });

  test('WizKids has its own Controls UI category grouping the parent and all children', () => {
    const category = CONTROL_CATEGORY_DEFINITIONS.find((entry) => entry.id === 'wizkids');
    assert.ok(category, 'a "wizkids" control category must exist');
    assert.deepEqual(category.groups, ['WizKids']);
  });

  test('the full tenant activation package is derived from the complete WizKids catalogue', () => {
    assert.deepEqual(WIZKIDS_CAPABILITY_KEYS, ['WIZKIDS', ...WIZKIDS_CHILD_KEYS]);
    assert.deepEqual(
      WIZKIDS_PLAN_FEATURE_KEYS,
      WIZKIDS_CAPABILITY_KEYS.map((key) => TENANT_CAPABILITIES[key].planFeature)
    );
  });
});

describe('WizKids plan-feature defaults are OFF for every plan (backward compatibility)', () => {
  test('wizKids and every child plan-feature key defaults to false with no per-tenant override, on every plan tier', () => {
    const wizKidsFeatureKeys = ['WIZKIDS', ...WIZKIDS_CHILD_KEYS].map((key) => TENANT_CAPABILITIES[key].planFeature);
    for (const planType of Object.values(SUBSCRIPTION_PLAN_TYPES)) {
      for (const featureKey of wizKidsFeatureKeys) {
        assert.equal(
          isPlanFeatureEnabled(planType, featureKey, null),
          false,
          `${featureKey} must default to false on plan "${planType}" with no tenant override`
        );
      }
    }
  });
});

describe('customFeatures per-tenant override now reaches plan-entitlement resolution (Phase 1 bug fix)', () => {
  test('a tenant-specific customFeatures.wizKids=true override grants entitlement even though the plan default is false', () => {
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.FREE, 'wizKids', { wizKids: true }), true);
  });

  test('an explicit customFeatures.wizKids=false override keeps entitlement denied', () => {
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.FREE, 'wizKids', { wizKids: false }), false);
  });

  test('a per-tenant override for one WizKids child (Olympiad) does not affect sibling children or the parent', () => {
    const overrides = { wizKids: true, wizKidsOlympiad: false, wizKidsMentalMaths: true };
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.PRO, 'wizKids', overrides), true);
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.PRO, 'wizKidsOlympiad', overrides), false);
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.PRO, 'wizKidsMentalMaths', overrides), true);
    // A sibling with no explicit override falls back to the plan default (false).
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.PRO, 'wizKidsLogic', overrides), false);
  });

  test('the customFeatures pass-through fix does not change behaviour for existing (non-WizKids) capabilities when no override is set', () => {
    // Regression guard: existing capabilities (e.g. examinerReview / EVALUATOR_REVIEW) must
    // still resolve purely from the plan default when a tenant has no matching override key.
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.PRO, 'examinerReview', { wizKids: true }), true);
    assert.equal(isPlanFeatureEnabled(SUBSCRIPTION_PLAN_TYPES.FREE, 'examinerReview', { wizKids: true }), false);
  });
});

describe('WizKids automated feature-control matrix (master prompt §56)', () => {
  // Each row simulates exactly the inputs resolveTenantCapabilities() would compute
  // for the WIZKIDS parent and one child, given a Super Admin grant (planEntitled)
  // and a Tenant Admin preference (requestedEnabled), without requiring a live DB.
  const resolveParent = ({ superGranted, tenantEnabled }) =>
    resolveCapabilityEffectiveState({
      releaseStatus: 'RELEASED',
      platformAvailable: true,
      planEntitled: superGranted,
      requestedEnabled: tenantEnabled,
      dependencyOk: true,
      superAdminEnforced: false,
    });

  const resolveChild = ({ childSuperGranted, childTenantEnabled, parentEffectiveEnabled }) =>
    resolveCapabilityEffectiveState({
      releaseStatus: 'RELEASED',
      platformAvailable: true,
      planEntitled: childSuperGranted,
      requestedEnabled: childTenantEnabled,
      dependencyOk: parentEffectiveEnabled,
      superAdminEnforced: false,
    });

  test('No grant / No tenant-enable -> BLOCK', () => {
    assert.equal(resolveParent({ superGranted: false, tenantEnabled: false }), 'LOCKED_BY_PLAN');
  });

  test('No grant / Yes tenant-enable -> BLOCK (tenant preference cannot override a missing grant)', () => {
    assert.equal(resolveParent({ superGranted: false, tenantEnabled: true }), 'LOCKED_BY_PLAN');
  });

  test('Yes grant / No tenant-enable -> BLOCK (tenant has not turned it on yet)', () => {
    assert.equal(resolveParent({ superGranted: true, tenantEnabled: false }), 'DISABLED');
  });

  test('Yes grant / Yes tenant-enable -> parent ENABLED', () => {
    assert.equal(resolveParent({ superGranted: true, tenantEnabled: true }), 'ENABLED');
  });

  test('Parent ON, child preference OFF -> CHILD BLOCK', () => {
    const parentState = resolveParent({ superGranted: true, tenantEnabled: true });
    const parentEffectiveEnabled = parentState === 'ENABLED';
    assert.equal(
      resolveChild({ childSuperGranted: true, childTenantEnabled: false, parentEffectiveEnabled }),
      'DISABLED'
    );
  });

  test('Parent ON, child not granted by Super Admin -> CHILD BLOCK (LOCKED_BY_PLAN) even if tenant wants it on', () => {
    const parentState = resolveParent({ superGranted: true, tenantEnabled: true });
    const parentEffectiveEnabled = parentState === 'ENABLED';
    assert.equal(
      resolveChild({ childSuperGranted: false, childTenantEnabled: true, parentEffectiveEnabled }),
      'LOCKED_BY_PLAN'
    );
  });

  test('Parent ON, child granted and enabled -> ALLOW', () => {
    const parentState = resolveParent({ superGranted: true, tenantEnabled: true });
    const parentEffectiveEnabled = parentState === 'ENABLED';
    assert.equal(
      resolveChild({ childSuperGranted: true, childTenantEnabled: true, parentEffectiveEnabled }),
      'ENABLED'
    );
  });

  test('Parent OFF (no grant) forces every child unavailable regardless of the child\'s own grant/preference', () => {
    const parentState = resolveParent({ superGranted: false, tenantEnabled: true });
    const parentEffectiveEnabled = parentState === 'ENABLED';
    assert.equal(parentEffectiveEnabled, false);
    const childState = resolveChild({ childSuperGranted: true, childTenantEnabled: true, parentEffectiveEnabled });
    assert.notEqual(childState, 'ENABLED');
  });
});

describe('Tenant Admin cannot self-grant WizKids entitlement (only Super Admin can)', () => {
  test('canTenantUpdateFeature blocks enabling WIZKIDS when Super Admin has not granted plan entitlement', () => {
    const notEntitled = { effectiveState: 'LOCKED_BY_PLAN', planEntitled: false, platformAvailable: true, superAdminEnforced: false };
    assert.equal(canTenantUpdateFeature(notEntitled, true).allowed, false);
  });

  test('canTenantUpdateFeature allows a Tenant Admin to toggle WIZKIDS once Super Admin has granted it', () => {
    const entitled = { effectiveState: 'DISABLED', planEntitled: true, platformAvailable: true, superAdminEnforced: false };
    assert.equal(canTenantUpdateFeature(entitled, true).allowed, true);
  });
});
