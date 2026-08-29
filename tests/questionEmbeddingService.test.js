import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// cosineSimilarity is a pure function — no DB/network needed for these
// assertions. The DB-backed atlasVectorSearch/inAppCosineFallback paths and
// the embedding-provider calls are exercised by the tenant-scoped
// memory-check route in an authenticated environment, not here.
const { cosineSimilarity } = await import('../services/questionEmbeddingService.js');

describe('cosineSimilarity', () => {
  test('is 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });

  test('is 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  test('is between -1 and 1 for arbitrary vectors', () => {
    const score = cosineSimilarity([0.2, 0.9, -0.1], [0.1, 0.8, 0.05]);
    assert.ok(score > 0 && score <= 1);
  });

  test('returns 0 for mismatched lengths rather than throwing', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  test('returns 0 for empty/non-array input rather than throwing', () => {
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
    assert.equal(cosineSimilarity(undefined, undefined), 0);
  });

  test('returns 0 when either vector is all zeros (no direction to compare)', () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });
});
