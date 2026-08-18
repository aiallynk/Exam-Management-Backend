import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cosineSimilarity, rankAndBalanceChunks } from '../services/contextRetrievalService.js';

describe('cosineSimilarity', () => {
  test('is 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });

  test('is 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  test('is 0 for mismatched-length or empty vectors (fails safe, never throws)', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
  });
});

describe('rankAndBalanceChunks — source-balanced retrieval', () => {
  const makeChunk = (sourceId, similarityHint) => ({
    _id: `${sourceId}-${similarityHint}`,
    sourceId,
    // A 2D embedding whose cosine similarity to [1, 0] is controlled by
    // similarityHint (0..1) so we can construct deterministic rankings
    // without needing real embeddings.
    embedding: [similarityHint, Math.sqrt(1 - similarityHint * similarityHint)],
  });

  test('does not let one large source dominate the top-K purely by chunk count', () => {
    // Source A has 20 chunks, all reasonably similar. Source B has only 2
    // chunks, less similar but still above the relevance floor.
    const chunksA = Array.from({ length: 20 }, (_, i) => makeChunk('source-a', 0.9 - i * 0.001));
    const chunksB = [makeChunk('source-b', 0.5), makeChunk('source-b', 0.45)];
    const balanced = rankAndBalanceChunks([...chunksA, ...chunksB], [1, 0], 6);

    const sourcesRepresented = new Set(balanced.map((chunk) => chunk.sourceId));
    assert.ok(sourcesRepresented.has('source-a'));
    assert.ok(sourcesRepresented.has('source-b'), 'expected the smaller source to still be represented in top-K');
  });

  test('filters out chunks below the minimum similarity threshold', () => {
    const chunks = [makeChunk('source-a', 0.99), makeChunk('source-a', 0.01)];
    const balanced = rankAndBalanceChunks(chunks, [1, 0], 10);
    assert.equal(balanced.length, 1);
    assert.equal(balanced[0].sourceId, 'source-a');
  });

  test('never returns more than topK results', () => {
    const chunks = Array.from({ length: 30 }, (_, i) => makeChunk('source-a', 0.9 - i * 0.001));
    const balanced = rankAndBalanceChunks(chunks, [1, 0], 5);
    assert.equal(balanced.length, 5);
  });

  test('within a source, higher-similarity chunks are preferred first', () => {
    const chunks = [makeChunk('source-a', 0.5), makeChunk('source-a', 0.95)];
    const balanced = rankAndBalanceChunks(chunks, [1, 0], 1);
    assert.equal(balanced[0]._id, 'source-a-0.95');
  });

  test('broad-retrieval fallback: falls back to the best-available chunks when EVERY chunk is below the similarity threshold, instead of returning empty', () => {
    // Root-cause regression test: a small/short document whose chunks all
    // score just under RETRIEVAL_MIN_SIMILARITY for a given Topic string
    // previously caused retrieval to return zero chunks, which cascaded
    // into a false "insufficient source material" error even though the
    // document had real, usable content.
    const chunks = [makeChunk('source-a', 0.05), makeChunk('source-a', 0.03)];
    const balanced = rankAndBalanceChunks(chunks, [1, 0], 10);
    assert.equal(balanced.length, 2, 'expected both below-threshold chunks to be included via the fallback');
    assert.equal(balanced[0]._id, 'source-a-0.05', 'still ranked best-first even in fallback mode');
  });

  test('broad-retrieval fallback does not activate when at least one chunk already cleared the threshold', () => {
    // Unchanged from the pre-fix behavior — this is what keeps the
    // existing "filters out chunks below the minimum similarity
    // threshold" test above passing unmodified.
    const chunks = [makeChunk('source-a', 0.99), makeChunk('source-a', 0.01)];
    const balanced = rankAndBalanceChunks(chunks, [1, 0], 10);
    assert.equal(balanced.length, 1);
  });

  test('an empty chunk list stays empty (no fallback to fabricate content)', () => {
    assert.deepEqual(rankAndBalanceChunks([], [1, 0], 10), []);
  });
});
