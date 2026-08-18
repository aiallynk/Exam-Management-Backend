import ContextChunk from '../models/ContextChunk.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';

// Source-Grounded AI Question Generation — in-app retrieval (no Atlas
// Vector Search index): a generation call only ever ranks chunks
// belonging to the tenant's <=10 selected sources, never a global corpus,
// so brute-force cosine similarity over a bounded, indexed fetch is
// simpler and infra-free at this scale (see plan Key Architecture
// Decision #2).

// Pure query-object builder — the tenant-isolation / IDOR guard used both
// by the retrieval query below and by routes/ai.js's contextSourceIds
// ownership check before generation is allowed to proceed. Extracted as
// its own function (rather than an inline object literal at each call
// site) specifically so it is independently unit-testable: tenantId must
// always come from the function argument (the authenticated request's
// own tenant), never merged in from a mutable/external source, and a
// caller-supplied tenantId belonging to a different tenant can never
// smuggle another tenant's sources into the $in match set.
export const buildTenantOwnedSourceFilter = ({ tenantId, sourceIds, status }) => {
  if (!tenantId || !Array.isArray(sourceIds)) {
    throw new Error('buildTenantOwnedSourceFilter requires tenantId and an array of sourceIds.');
  }
  const filter = { tenantId, _id: { $in: sourceIds } };
  if (status) filter.status = status;
  return filter;
};

export const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Pure function — ranks candidate chunks against a query embedding, then
// round-robins across sourceId groups (by descending similarity within
// each group) so one large source's sheer chunk count can't dominate the
// top-K purely by volume (master prompt §15: "do not accidentally allow
// the largest document to completely dominate retrieval").
export const rankAndBalanceChunks = (chunks, queryEmbedding, topK = sourceGroundedConfig.RETRIEVAL_TOP_K) => {
  const ranked = chunks
    .map((chunk) => ({ chunk, similarity: cosineSimilarity(chunk.embedding, queryEmbedding) }))
    .sort((a, b) => b.similarity - a.similarity);

  let scored = ranked.filter((entry) => entry.similarity >= sourceGroundedConfig.RETRIEVAL_MIN_SIMILARITY);

  // Broad-retrieval fallback: if the similarity threshold would exclude
  // EVERY chunk — e.g. a short/generic Topic string that doesn't
  // lexically/semantically echo a small document's specific wording — do
  // not return empty and force a false "insufficient source material"
  // outcome (this was the second half of the reported bug: a
  // genuinely-usable uploaded file still failed because its chunks
  // scored just under the threshold for the given topic). Only triggers
  // when strict filtering finds literally nothing; if at least one chunk
  // already cleared the bar, behavior is unchanged. Grounding validation
  // downstream (groundingValidatorService.js) remains the real safety
  // net against ungrounded questions — this only widens what candidate
  // context generation gets to see.
  if (scored.length === 0 && ranked.length > 0) {
    scored = ranked.slice(0, topK);
  }

  const bySource = new Map();
  for (const entry of scored) {
    const key = String(entry.chunk.sourceId);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(entry);
  }

  const sourceQueues = [...bySource.values()];
  const balanced = [];
  let exhausted = false;
  while (!exhausted && balanced.length < topK) {
    exhausted = true;
    for (const queue of sourceQueues) {
      if (queue.length === 0) continue;
      exhausted = false;
      balanced.push(queue.shift());
      if (balanced.length >= topK) break;
    }
  }

  return balanced.map((entry) => ({ ...entry.chunk, similarity: entry.similarity }));
};

// DB-querying wrapper. tenantId is baked directly into the filter literal
// (never merged in later) and sourceIds must already be verified as
// belonging to this tenant by the caller (see routes/ai.js's ownership
// check) — this function does not re-verify ownership, only scopes the
// query, matching the "tenantId baked into every query" convention used
// throughout this feature.
export const retrieveGroundingChunks = async ({ tenantId, sourceIds, queryEmbedding, topK }) => {
  if (!tenantId || !Array.isArray(sourceIds) || sourceIds.length === 0) return [];
  const chunks = await ContextChunk.find({ tenantId, sourceId: { $in: sourceIds } })
    .select('text sourceId chunkIndex embedding')
    .lean();
  return rankAndBalanceChunks(chunks, queryEmbedding, topK);
};
