import ContextChunk from '../models/ContextChunk.js';
import ContextSource from '../models/ContextSource.js';
import LibraryResource from '../models/LibraryResource.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import { cosineSimilarity } from './contextRetrievalService.js';
import { embedSingleText } from './contextIngestionService.js';
import { buildQueryText } from './groundedGenerationService.js';

// Source discovery (spec Parts 5, 6, 23, 24). BEFORE generation, search
// every selected source, rank its relevant sections, and decide which
// sources actually contain the requested topic — so a book that produced
// none of the first few high vector scores is not silently sent to the
// model, and an unrelated selected book never appears in provenance.
//
// This does NOT re-read whole books: it scores the already-indexed chunks
// per source (that is exactly what the index is for) and produces a plain,
// explainable GenerationEvidencePlan.

const C = sourceGroundedConfig;

const bucketCoverage = (share, bestSimilarity) => {
  if (bestSimilarity >= C.DISCOVERY_STRONG_SINGLE_HIT_SIMILARITY && share > 0) {
    return share >= C.DISCOVERY_COVERAGE_MEDIUM ? 'HIGH' : 'MEDIUM';
  }
  if (share >= C.DISCOVERY_COVERAGE_HIGH) return 'HIGH';
  if (share >= C.DISCOVERY_COVERAGE_MEDIUM) return 'MEDIUM';
  if (share >= C.DISCOVERY_COVERAGE_LOW) return 'LOW';
  return 'NONE';
};

const COVERAGE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };

/**
 * @param {string} tenantId
 * @param {string[]} contextSourceIds  already tenant/READY/scope-verified by the route
 * @param {{ topic, instructions, questionTypes }} blueprint
 * @param {number[]} [queryEmbedding]  optional precomputed embedding
 * @returns {Promise<GenerationEvidencePlan>}
 */
export const buildGenerationEvidencePlan = async ({
  tenantId,
  contextSourceIds = [],
  topic = '',
  instructions = '',
  questionTypes = [],
  queryEmbedding = null,
}) => {
  const ids = [...new Set((contextSourceIds || []).map(String))];
  const plan = {
    requestedTopic: String(topic || '').trim(),
    requestedTypes: [...questionTypes],
    resources: [],
    selectedContextSourceIds: [],
    droppedContextSourceIds: [],
    conceptAnchors: [],
  };
  if (!tenantId || ids.length === 0) return plan;

  const embedding =
    queryEmbedding ||
    (await embedSingleText(buildQueryText({ topic, instructions, questionTypes }), { tenantId }));

  const sources = await ContextSource.find({ tenantId, _id: { $in: ids } })
    .select('_id originalFilename sourceUrl libraryResourceId contentType')
    .lean();
  const libIds = [...new Set(sources.map((s) => s.libraryResourceId).filter(Boolean).map(String))];
  const libs = libIds.length
    ? await LibraryResource.find({ tenantId, _id: { $in: libIds } })
        .select('_id title resourceType chapter unit topic')
        .lean()
    : [];
  const libById = new Map(libs.map((l) => [String(l._id), l]));

  for (const src of sources) {
    const chunks = await ContextChunk.find({ tenantId, sourceId: src._id })
      .select('_id text sectionTitle pageStart pageEnd chunkIndex embedding')
      .limit(C.DISCOVERY_MAX_CHUNKS_SCANNED_PER_SOURCE)
      .lean();

    const scored = chunks
      .map((c) => ({ chunk: c, similarity: cosineSimilarity(c.embedding, embedding) }))
      .sort((a, b) => b.similarity - a.similarity);

    const relevant = scored.filter((e) => e.similarity >= C.RETRIEVAL_MIN_SIMILARITY);
    const share = chunks.length ? relevant.length / chunks.length : 0;
    const bestSimilarity = scored[0]?.similarity || 0;
    const coverage = chunks.length ? bucketCoverage(share, bestSimilarity) : 'NONE';
    const top = scored.slice(0, C.DISCOVERY_TOP_CHUNKS_PER_SOURCE);
    const lib = src.libraryResourceId ? libById.get(String(src.libraryResourceId)) : null;
    const matchedSectionTitles = [
      ...new Set(top.map((e) => String(e.chunk.sectionTitle || '').trim()).filter(Boolean)),
    ].slice(0, 4);
    const pages = top
      .flatMap((e) => [e.chunk.pageStart, e.chunk.pageEnd])
      .filter((n) => Number.isFinite(n));

    plan.resources.push({
      contextSourceId: String(src._id),
      libraryResourceId: lib ? String(lib._id) : null,
      resourceTitle: lib ? lib.title : (src.originalFilename || src.sourceUrl || 'Source'),
      resourceType: lib ? lib.resourceType : (src.contentType || ''),
      chapter: lib ? lib.chapter || '' : '',
      unit: lib ? lib.unit || '' : '',
      topic: lib ? lib.topic || '' : '',
      matchedSectionTitles,
      pageHint: pages.length ? { start: Math.min(...pages), end: Math.max(...pages) } : null,
      coverage,
      relevanceScore: Number(bestSimilarity.toFixed(4)),
      relevantChunkShare: Number(share.toFixed(4)),
      topChunkIds: top.map((e) => String(e.chunk._id)),
      // Kept transient for the orchestrator; not returned to clients.
      _topScored: top.map((e) => ({ ...e.chunk, similarity: e.similarity })),
    });
  }

  plan.resources.sort((a, b) => COVERAGE_RANK[b.coverage] - COVERAGE_RANK[a.coverage] || b.relevanceScore - a.relevanceScore);
  for (const r of plan.resources) {
    if (COVERAGE_RANK[r.coverage] >= COVERAGE_RANK.LOW) plan.selectedContextSourceIds.push(r.contextSourceId);
    else plan.droppedContextSourceIds.push(r.contextSourceId);
  }

  // Deterministic concept anchors from the SELECTED evidence only — section
  // titles plus salient capitalised / repeated noun phrases. Used to spread
  // a batch's questions across genuinely-present concepts (Part 17); never
  // fabricated to force variety.
  plan.conceptAnchors = extractConceptAnchors(
    plan.resources.filter((r) => plan.selectedContextSourceIds.includes(r.contextSourceId))
  );

  return plan;
};

const STOPWORDS = new Set(
  'the a an of and or to in on for with without from into is are was were be been being this that these those it its their which what how why when where who whom as at by than then so such not no nor only both each other more most some any all'.split(
    ' '
  )
);

export const extractConceptAnchors = (selectedResources = []) => {
  const anchors = new Map(); // lower -> {label, weight}
  const add = (raw, weight) => {
    const label = String(raw || '').trim().replace(/\s+/g, ' ');
    if (label.length < 4 || label.length > 60) return;
    const key = label.toLowerCase();
    if (STOPWORDS.has(key)) return;
    anchors.set(key, { label, weight: (anchors.get(key)?.weight || 0) + weight });
  };
  for (const r of selectedResources) {
    (r.matchedSectionTitles || []).forEach((t) => add(t, 3));
    for (const c of r._topScored || []) {
      const text = String(c.text || '');
      // Capitalised multi-word phrases (crude proper-noun / heading detector).
      for (const m of text.match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3})\b/g) || []) add(m, 1);
      // Repeated lowercase bigrams that carry meaning.
      const words = (text.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
      for (let i = 0; i < words.length - 1; i += 1) add(`${words[i]} ${words[i + 1]}`, 0.25);
    }
  }
  return [...anchors.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map((a) => a.label);
};

export const summarizeEvidencePlan = (plan) => ({
  requestedTopic: plan.requestedTopic,
  requestedTypes: plan.requestedTypes,
  sourcesSelected: plan.resources.length,
  sourcesRelevant: plan.selectedContextSourceIds.length,
  sourcesDropped: plan.droppedContextSourceIds.length,
  chaptersUsed: [
    ...new Set(
      plan.resources
        .filter((r) => plan.selectedContextSourceIds.includes(r.contextSourceId))
        .map((r) => r.chapter)
        .filter(Boolean)
    ),
  ].length,
  resources: plan.resources.map((r) => ({
    resourceTitle: r.resourceTitle,
    chapter: r.chapter || null,
    coverage: r.coverage,
  })),
});
