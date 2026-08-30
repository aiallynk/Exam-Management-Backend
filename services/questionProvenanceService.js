import crypto from 'crypto';
import mongoose from 'mongoose';
import ContextChunk from '../models/ContextChunk.js';
import ContextSource from '../models/ContextSource.js';
import LibraryResource from '../models/LibraryResource.js';

// Source-Verified Question Intelligence — question-level provenance
// (spec Parts 1, 2, 4, 10). Xamigo assigns every educator-facing value
// (resource title / chapter / topic / page) from persisted metadata. The AI
// provider NEVER contributes a resource id, title, author, chapter, page,
// topic or source id — it may only select which Xamigo-issued evidence keys
// it used. Anything else it returns for these fields is ignored.

const EVIDENCE_SNAPSHOT_MAX = 600;
const CREATOR_INSTRUCTION_MAX = 2000;

// Fields the model is structurally forbidden from supplying — stripped from
// any raw model output before it can reach provenance. Kept exported so a
// test can assert the contract.
export const MODEL_FORBIDDEN_PROVENANCE_KEYS = Object.freeze([
  'libraryResourceId', 'contextSourceId', 'sourceId', 'resourceId',
  'resourceTitle', 'bookTitle', 'author', 'chapter', 'chapterName',
  'unit', 'topic', 'page', 'pageNumber', 'pageStart', 'pageEnd', 'resourceName',
]);

const trim = (v, max) => {
  const s = v == null ? '' : String(v).trim();
  return max ? s.slice(0, max) : s;
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Evidence-key issuance (Part 10). Xamigo mints stable evidence_1..N keys
// for the chunks it retrieved BEFORE calling the model; the model returns
// only the keys it used; Xamigo resolves them back to real metadata.

export const buildEvidenceKeyMap = (chunks = []) => {
  const map = new Map();
  (Array.isArray(chunks) ? chunks : []).forEach((chunk, i) => {
    const id = chunk && (chunk._id || chunk.id);
    if (id) map.set(`evidence_${i + 1}`, String(id));
  });
  return map;
};

// A model reply may name keys we never issued (hallucinated) — keep only the
// real ones, in issue order, de-duplicated.
export const sanitizeEvidenceKeys = (rawKeys, evidenceKeyMap) => {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(rawKeys) ? rawKeys : []) {
    const key = String(k || '').trim();
    if (evidenceKeyMap.has(key) && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Freeze educator-facing source references from persisted metadata only.
// `chunkUsage` : Map<chunkId, Set<usage>> derived from which model field
// (evidenceReferenceKeys vs answerSupportKeys) named each key.

export const buildFrozenSourceReferences = async ({
  tenantId,
  chunkIds = [],
  chunkUsage = null,
  relevanceByChunkId = null,
}) => {
  const ids = [...new Set((chunkIds || []).map(String).filter((s) => /^[a-f0-9]{24}$/i.test(s)))];
  if (!tenantId || ids.length === 0) return [];

  // tenantId baked into the filter literal — never fetch-then-check (Part 29).
  const chunks = await ContextChunk.find({ tenantId, _id: { $in: ids } })
    .select('_id sourceId text sectionTitle pageStart pageEnd chunkIndex')
    .lean();
  if (!chunks.length) return [];

  const sourceIds = [...new Set(chunks.map((c) => String(c.sourceId)))];
  const sources = await ContextSource.find({ tenantId, _id: { $in: sourceIds } })
    .select('_id originalFilename sourceUrl sourceType libraryResourceId contentType')
    .lean();
  const sourceById = new Map(sources.map((s) => [String(s._id), s]));

  const libIds = [...new Set(sources.map((s) => s.libraryResourceId).filter(Boolean).map(String))];
  const libs = libIds.length
    ? await LibraryResource.find({ tenantId, _id: { $in: libIds } })
        .select('_id title resourceType chapter unit topic')
        .lean()
    : [];
  const libById = new Map(libs.map((l) => [String(l._id), l]));

  // Group chunks by their ContextSource → one frozen reference per source.
  const bySource = new Map();
  for (const chunk of chunks) {
    const sid = String(chunk.sourceId);
    if (!bySource.has(sid)) bySource.set(sid, []);
    bySource.get(sid).push(chunk);
  }

  const refs = [];
  for (const [sid, group] of bySource) {
    const src = sourceById.get(sid) || {};
    const lib = src.libraryResourceId ? libById.get(String(src.libraryResourceId)) : null;
    group.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));

    const pages = group.map((c) => [c.pageStart, c.pageEnd]).flat().filter((n) => Number.isFinite(n));
    const sectionTitles = [...new Set(group.map((c) => trim(c.sectionTitle)).filter(Boolean))];
    const joinedText = group.map((c) => c.text || '').join('\n\n');
    const usageSet = new Set();
    if (chunkUsage) group.forEach((c) => (chunkUsage.get(String(c._id)) || []).forEach((u) => usageSet.add(u)));
    if (!usageSet.size) usageSet.add('QUESTION_CONCEPT');
    const rel = relevanceByChunkId
      ? group.map((c) => relevanceByChunkId.get(String(c._id))).filter((n) => Number.isFinite(n))
      : [];

    refs.push({
      libraryResourceId: lib ? lib._id : undefined,
      contextSourceId: src._id || new mongoose.Types.ObjectId(sid),
      resourceTitleSnapshot: lib ? trim(lib.title) : undefined,
      resourceTypeSnapshot: lib ? trim(lib.resourceType) : trim(src.contentType) || undefined,
      fileTitleSnapshot: trim(src.originalFilename) || trim(src.sourceUrl) || undefined,
      chapterSnapshot: lib ? trim(lib.chapter) || undefined : undefined,
      unitSnapshot: lib ? trim(lib.unit) || undefined : undefined,
      topicSnapshot: lib ? trim(lib.topic) || undefined : undefined,
      sectionTitleSnapshot: sectionTitles[0] || undefined,
      pageStart: pages.length ? Math.min(...pages) : undefined,
      pageEnd: pages.length ? Math.max(...pages) : undefined,
      evidenceChunkIdsInternal: group.map((c) => c._id),
      evidenceHash: sha256(joinedText),
      evidenceTextSnapshot: trim(joinedText, EVIDENCE_SNAPSHOT_MAX) || undefined,
      relevanceScoreInternal: rel.length ? Number((rel.reduce((a, b) => a + b, 0) / rel.length).toFixed(4)) : undefined,
      usage: [...usageSet],
    });
  }
  return refs;
};

// ---------------------------------------------------------------------------
// Assemble the full provenance object stored on Question / QuestionVersion.

export const buildQuestionProvenance = ({
  generationMode,
  sourcePolicy = 'NONE',
  creatorInstruction = '',
  generationRunId = null,
  generationOperationId = '',
  groundingVerdict = null,
  sourceReferences = [],
  noveltySignatures = null,
  generatedAt = new Date(),
}) => {
  const refs = Array.isArray(sourceReferences) ? sourceReferences : [];
  const flatChunkIds = [...new Set(refs.flatMap((r) => (r.evidenceChunkIdsInternal || []).map(String)))];
  const flatSourceIds = [...new Set(refs.map((r) => r.contextSourceId).filter(Boolean).map(String))];
  return {
    generationMode: generationMode || 'STANDARD',
    sourcePolicy: sourcePolicy || 'NONE',
    creatorInstructionSnapshot: trim(creatorInstruction, CREATOR_INSTRUCTION_MAX) || undefined,
    generationRunId: generationRunId || undefined,
    generationOperationId: trim(generationOperationId) || undefined,
    groundingVerdict: groundingVerdict || (refs.length ? 'SUPPORTED' : 'NOT_APPLICABLE'),
    revalidationState: 'CURRENT',
    generatedAt,
    sourceReferences: refs.length ? refs : undefined,
    // Compat view kept in sync so old readers keep working.
    sourceIds: flatSourceIds.length ? flatSourceIds : undefined,
    chunkIds: flatChunkIds.length ? flatChunkIds : undefined,
    evidenceSnippet: refs[0]?.evidenceTextSnapshot,
    noveltySignatures: noveltySignatures || undefined,
  };
};

// ---------------------------------------------------------------------------
// DTO redaction (Part 2/3/31). Never expose chunk ids / hashes / raw scores /
// HMAC signatures to an educator. Produces the compact popover model.

const REDACT_REF_KEYS = ['evidenceChunkIdsInternal', 'evidenceHash', 'relevanceScoreInternal'];

const USAGE_LABEL = {
  QUESTION_CONCEPT: 'Question concept',
  ANSWER_SUPPORT: 'Answer support',
  SCENARIO_CONTEXT: 'Scenario context',
  IMAGE_CONTEXT: 'Image context',
};

const GROUNDING_LABEL = {
  SUPPORTED: 'Verified',
  PARTIALLY_SUPPORTED: 'Partially verified',
  UNSUPPORTED: 'Not verified',
  NOT_APPLICABLE: 'Not source-grounded',
};

export const toProvenanceView = (provenance) => {
  if (!provenance || typeof provenance !== 'object') return null;
  const p = provenance.toObject ? provenance.toObject() : provenance;
  const mode = p.generationMode
    || (p.questionBankItemId ? 'QUESTION_BANK_REUSE' : (p.sourceReferences?.length || p.sourceIds?.length ? 'SOURCE_GROUNDED' : 'STANDARD'));

  const refs = (Array.isArray(p.sourceReferences) ? p.sourceReferences : []).map((r) => {
    const clean = {};
    for (const [k, v] of Object.entries(r)) if (!REDACT_REF_KEYS.includes(k)) clean[k] = v;
    const hasMetadata = Boolean(r.resourceTitleSnapshot || r.fileTitleSnapshot);
    return {
      ...clean,
      basedOn: r.resourceTitleSnapshot || r.fileTitleSnapshot || 'Source metadata unavailable',
      pagesLabel:
        Number.isFinite(r.pageStart) && Number.isFinite(r.pageEnd)
          ? (r.pageStart === r.pageEnd ? `${r.pageStart}` : `${r.pageStart}–${r.pageEnd}`)
          : 'Referenced pages: unavailable',
      usageLabel: (r.usage || []).map((u) => USAGE_LABEL[u] || u).join(' · ') || null,
      metadataAvailable: hasMetadata,
    };
  });

  let sourceLabel;
  if (mode === 'MANUAL') sourceLabel = 'Manual authoring';
  else if (mode === 'QUESTION_BANK_REUSE') sourceLabel = 'Question Bank';
  else if (mode === 'IMPORTED') sourceLabel = 'Imported question';
  else if (refs.length) sourceLabel = refs[0].basedOn;
  else sourceLabel = 'Generated from creator instructions';

  return {
    generationMode: mode,
    sourcePolicy: p.sourcePolicy || (refs.length ? 'SELECTED_CONTEXT' : 'NONE'),
    sourceLabel,
    grounding: GROUNDING_LABEL[p.groundingVerdict] || (refs.length ? 'Verified' : 'Not source-grounded'),
    needsRevalidation: p.revalidationState === 'SOURCE_REFERENCE_NEEDS_REVALIDATION',
    creatorInstructionSnapshot: p.creatorInstructionSnapshot || null,
    generatedAt: p.generatedAt || null,
    referenceCount: refs.length,
    references: refs,
  };
};

// Strip any provenance-metadata keys the model tried to supply (defence in
// depth — the pipeline never reads them, but this guarantees it).
export const stripModelSuppliedProvenance = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of MODEL_FORBIDDEN_PROVENANCE_KEYS) delete out[k];
  return out;
};

export const _internals = { sha256, EVIDENCE_SNAPSHOT_MAX };
