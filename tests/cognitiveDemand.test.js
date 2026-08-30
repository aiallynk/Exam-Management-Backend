import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COGNITIVE_DEMAND_DISTRIBUTION,
  DEFAULT_COGNITIVE_DEMAND_MAPPING,
  resolveCognitiveDemandMapping,
  resolveEffectiveCognitiveDemandDistribution,
  deriveCognitiveDemandFromBloom,
  validateCognitiveDemandDistribution,
  buildBloomTargetsFromCognitiveDistribution,
  computeCognitiveDemandDiagnostics,
} from '../utils/cognitiveDemand.js';

describe('resolveCognitiveDemandMapping', () => {
  test('falls back to the default when no framework mapping is supplied', () => {
    assert.deepEqual(resolveCognitiveDemandMapping({}), DEFAULT_COGNITIVE_DEMAND_MAPPING);
  });

  test('honors a valid framework override — some institutions classify ANALYZE as HOT', () => {
    const override = { LOT: ['REMEMBER', 'UNDERSTAND'], MOT: ['APPLY'], HOT: ['ANALYZE', 'EVALUATE', 'CREATE'] };
    assert.deepEqual(resolveCognitiveDemandMapping({ cognitiveDemandMapping: override }), override);
  });

  test('rejects a mapping missing a level and falls back to the default', () => {
    const broken = { LOT: ['REMEMBER'], MOT: ['APPLY'] };
    assert.deepEqual(resolveCognitiveDemandMapping({ cognitiveDemandMapping: broken }), DEFAULT_COGNITIVE_DEMAND_MAPPING);
  });

  test('rejects a mapping with a Bloom level assigned to two cognitive demands', () => {
    const broken = { LOT: ['REMEMBER', 'APPLY'], MOT: ['APPLY', 'ANALYZE'], HOT: ['EVALUATE', 'CREATE'] };
    assert.deepEqual(resolveCognitiveDemandMapping({ cognitiveDemandMapping: broken }), DEFAULT_COGNITIVE_DEMAND_MAPPING);
  });
});

describe('deriveCognitiveDemandFromBloom', () => {
  test('derives LOT/MOT/HOT from the default mapping', () => {
    assert.equal(deriveCognitiveDemandFromBloom('REMEMBER'), 'LOT');
    assert.equal(deriveCognitiveDemandFromBloom('APPLY'), 'MOT');
    assert.equal(deriveCognitiveDemandFromBloom('CREATE'), 'HOT');
  });

  test('a custom framework mapping changes the result for the same Bloom level', () => {
    const override = { LOT: ['REMEMBER', 'UNDERSTAND'], MOT: ['APPLY'], HOT: ['ANALYZE', 'EVALUATE', 'CREATE'] };
    assert.equal(deriveCognitiveDemandFromBloom('ANALYZE', DEFAULT_COGNITIVE_DEMAND_MAPPING), 'MOT');
    assert.equal(deriveCognitiveDemandFromBloom('ANALYZE', override), 'HOT');
  });

  test('returns null (never a guess) for a missing or unrecognized Bloom level', () => {
    assert.equal(deriveCognitiveDemandFromBloom(null), null);
    assert.equal(deriveCognitiveDemandFromBloom('NOT_A_REAL_LEVEL'), null);
  });
});

describe('validateCognitiveDemandDistribution', () => {
  test('accepts a distribution summing to exactly 100', () => {
    assert.equal(validateCognitiveDemandDistribution({ LOT: 30, MOT: 40, HOT: 30 }).valid, true);
  });

  test('rejects — never silently normalizes — a distribution not summing to 100', () => {
    const result = validateCognitiveDemandDistribution({ LOT: 50, MOT: 50, HOT: 50 });
    assert.equal(result.valid, false);
    assert.match(result.error, /100/);
  });

  test('rejects a negative or non-numeric value', () => {
    assert.equal(validateCognitiveDemandDistribution({ LOT: -10, MOT: 60, HOT: 50 }).valid, false);
    assert.equal(validateCognitiveDemandDistribution({ LOT: 'a lot', MOT: 40, HOT: 30 }).valid, false);
  });
});

describe('resolveEffectiveCognitiveDemandDistribution', () => {
  test('automatically targets Academic Assessment at 30/40/30 when the framework has no target', () => {
    assert.deepEqual(
      resolveEffectiveCognitiveDemandDistribution({ creationMode: 'ACADEMIC' }),
      DEFAULT_COGNITIVE_DEMAND_DISTRIBUTION,
    );
  });

  test('keeps an explicit academic framework target authoritative', () => {
    const frameworkDistribution = { LOT: 20, MOT: 50, HOT: 30 };
    assert.deepEqual(
      resolveEffectiveCognitiveDemandDistribution({
        creationMode: 'ACADEMIC',
        frameworkDistribution,
      }),
      frameworkDistribution,
    );
  });

  test('treats an empty persisted academic target as unconfigured', () => {
    assert.deepEqual(
      resolveEffectiveCognitiveDemandDistribution({
        creationMode: 'ACADEMIC',
        frameworkDistribution: {},
      }),
      DEFAULT_COGNITIVE_DEMAND_DISTRIBUTION,
    );
  });

  test('preserves Quick optional and legacy no-target behavior', () => {
    assert.equal(resolveEffectiveCognitiveDemandDistribution({ creationMode: 'QUICK' }), null);
    assert.equal(resolveEffectiveCognitiveDemandDistribution({}), null);
  });
});

describe('buildBloomTargetsFromCognitiveDistribution', () => {
  test('splits a 10-question paper across the exact worked example (30/40/30)', () => {
    const targets = buildBloomTargetsFromCognitiveDistribution({ distribution: { LOT: 30, MOT: 40, HOT: 30 }, count: 10 });
    const total = targets.reduce((sum, t) => sum + t.count, 0);
    assert.equal(total, 10);
    const byLevel = targets.reduce((acc, t) => { acc[t.cognitiveDemand] = (acc[t.cognitiveDemand] || 0) + t.count; return acc; }, {});
    assert.equal(byLevel.LOT, 3);
    assert.equal(byLevel.MOT, 4);
    assert.equal(byLevel.HOT, 3);
  });

  test('every target uses a real, mapped Bloom level', () => {
    const targets = buildBloomTargetsFromCognitiveDistribution({ distribution: { LOT: 30, MOT: 40, HOT: 30 }, count: 10 });
    targets.forEach((t) => assert.ok(DEFAULT_COGNITIVE_DEMAND_MAPPING[t.cognitiveDemand].includes(t.bloomLevel)));
  });

  test('zero count returns no targets', () => {
    assert.deepEqual(buildBloomTargetsFromCognitiveDistribution({ distribution: { LOT: 30, MOT: 40, HOT: 30 }, count: 0 }), []);
  });
});

describe('computeCognitiveDemandDiagnostics', () => {
  test('matches when actual percentages fall within tolerance of the target', () => {
    const questions = [
      { bloomLevel: 'REMEMBER' }, { bloomLevel: 'UNDERSTAND' }, { bloomLevel: 'REMEMBER' },
      { bloomLevel: 'APPLY' }, { bloomLevel: 'ANALYZE' }, { bloomLevel: 'APPLY' }, { bloomLevel: 'ANALYZE' },
      { bloomLevel: 'EVALUATE' }, { bloomLevel: 'CREATE' }, { bloomLevel: 'EVALUATE' },
    ];
    const result = computeCognitiveDemandDiagnostics({ targetDistribution: { LOT: 30, MOT: 40, HOT: 30 }, questions });
    assert.equal(result.generatedCounts.LOT, 3);
    assert.equal(result.generatedCounts.MOT, 4);
    assert.equal(result.generatedCounts.HOT, 3);
    assert.equal(result.validationStatus, 'valid');
    assert.equal(result.unclassifiedCount, 0);
  });

  test('flags a real mismatch rather than reporting false valid', () => {
    const questions = Array.from({ length: 10 }, () => ({ bloomLevel: 'REMEMBER' }));
    const result = computeCognitiveDemandDiagnostics({ targetDistribution: { LOT: 30, MOT: 40, HOT: 30 }, questions });
    assert.equal(result.validationStatus, 'mismatch');
  });

  test('a question with no bloomLevel is excluded from generated counts, never guessed into a bucket', () => {
    const questions = [{ bloomLevel: 'REMEMBER' }, {}, { bloomLevel: null }];
    const result = computeCognitiveDemandDiagnostics({ targetDistribution: { LOT: 100, MOT: 0, HOT: 0 }, questions });
    assert.equal(result.classifiedCount, 1);
    assert.equal(result.unclassifiedCount, 2);
    assert.equal(result.totalQuestions, 3);
  });

  test('a pre-set cognitiveDemand on the question is trusted directly (manual/import override), not re-derived', () => {
    const questions = [{ cognitiveDemand: 'HOT', bloomLevel: 'REMEMBER' }];
    const result = computeCognitiveDemandDiagnostics({ targetDistribution: null, questions });
    assert.equal(result.generatedCounts.HOT, 1);
    assert.equal(result.generatedCounts.LOT, 0);
  });

  test('no target distribution reports unspecified rather than a fabricated pass/fail', () => {
    const result = computeCognitiveDemandDiagnostics({ targetDistribution: null, questions: [{ bloomLevel: 'REMEMBER' }] });
    assert.equal(result.validationStatus, 'unspecified');
  });
});
