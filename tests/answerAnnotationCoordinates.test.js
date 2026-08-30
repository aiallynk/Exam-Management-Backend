import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCanonicalAnnotations, hasReliableRegion, normalizeRegion } from '../services/offlineEvaluation/answerAnnotationService.js';

describe('annotation coordinate validation', () => {
  test('rejects incomplete or out-of-range regions', () => {
    assert.equal(normalizeRegion({ x: 0.1, y: 0.2, width: 0, height: 0.1 }), null);
    assert.equal(normalizeRegion({ x: 1.2, y: 0.2, width: 0.1, height: 0.1 }), null);
    assert.equal(hasReliableRegion(null), false);
    assert.equal(hasReliableRegion({ x: 0.2, y: 0.3, width: 0.4, height: 0.1 }), true);
  });

  test('does not invent page coordinates when no answer region exists', () => {
    const items = buildCanonicalAnnotations({
      segment: { boundingRegion: null, lineBoxes: [] },
      result: { pointsEarned: 4, maxScore: 5, isCorrect: false, confidence: 0.8 },
      pageId: 'page-1',
    });
    assert.equal(items.length, 0);
  });

  test('places score marks only on a reliable answer region', () => {
    const items = buildCanonicalAnnotations({
      segment: { boundingRegion: { x: 0.1, y: 0.4, width: 0.8, height: 0.3 }, lineBoxes: [] },
      result: { pointsEarned: 4, maxScore: 5, isCorrect: false, confidence: 0.8 },
      pageId: 'page-1',
    });
    assert.ok(items.length >= 2);
    assert.ok(items.every((item) => hasReliableRegion(item.region)));
    assert.ok(items.some((item) => item.type === 'SCORE'));
  });
});
