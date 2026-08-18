import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TENANT_CAPABILITIES, resolveCapabilityEffectiveState } from '../services/tenantFeatureService.js';
import { isPlanFeatureEnabled } from '../config/planLimits.js';

describe('AI_IMAGE_QUESTION_GENERATION — platform kill switch', () => {
  test('capability is defined as UNRELEASED by default (master prompt Rule 10: OFF until explicitly enabled)', () => {
    assert.equal(TENANT_CAPABILITIES.AI_IMAGE_QUESTION_GENERATION.releaseStatus, 'UNRELEASED');
  });

  test('UNRELEASED short-circuits to UNRELEASED regardless of plan entitlement or a per-tenant override', () => {
    // resolveCapabilityEffectiveState checks releaseStatus === 'UNRELEASED'
    // FIRST, before planEntitled/requestedEnabled/superAdminEnforced — this
    // is what makes it an unconditional platform-wide OFF, not merely a
    // default a tenant could opt out of.
    const state = resolveCapabilityEffectiveState({
      releaseStatus: 'UNRELEASED',
      platformAvailable: true,
      planEntitled: true, // even if the plan would otherwise allow it
      requestedEnabled: true, // even if a Tenant Admin explicitly requested it on
      superAdminEnforced: false,
    });
    assert.equal(state, 'UNRELEASED');
  });

  test('the imageQuestions plan-feature flag is real and readable via isPlanFeatureEnabled (was previously defined but never read anywhere)', () => {
    assert.equal(isPlanFeatureEnabled('free', 'imageQuestions'), true); // as configured today
    assert.equal(isPlanFeatureEnabled('free', 'imageQuestions', { imageQuestions: false }), false);
  });

  test('SOURCE_GROUNDED_GENERATION is RELEASED (rolled out after validation) but still gated by plan entitlement', () => {
    // Unlike the hard AI_IMAGE_QUESTION_GENERATION kill switch, this
    // capability was deliberately promoted from UNRELEASED once the
    // feature was validated — it now follows the normal
    // plan-entitlement/tenant-override resolution path instead of an
    // unconditional platform-wide block.
    assert.equal(TENANT_CAPABILITIES.SOURCE_GROUNDED_GENERATION.releaseStatus, 'RELEASED');
    assert.equal(TENANT_CAPABILITIES.SOURCE_GROUNDED_GENERATION.planFeature, 'sourceGroundedGeneration');
  });
});

describe('assertImageGenerationAllowed', () => {
  test('is exported as an async function composing the capability gate and the plan-feature gate', async () => {
    // Deliberately does not invoke it here: resolveTenantFeature() inside
    // it requires a live Tenant lookup, and this test suite (like every
    // other test in this repo) runs without a database connection. The
    // capability-gate guarantee itself is proven above via
    // resolveCapabilityEffectiveState directly; this only confirms the
    // guard function exists with the expected shape.
    const { assertImageGenerationAllowed } = await import('../services/tenantFeatureService.js');
    assert.equal(typeof assertImageGenerationAllowed, 'function');
    assert.equal(assertImageGenerationAllowed.constructor.name, 'AsyncFunction');
  });
});
