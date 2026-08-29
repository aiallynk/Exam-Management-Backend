import config from '../config/env.js';
import { runEngineEmbedding, isEmbeddingEngineConfigured } from './aiEngine/aiEngineClient.js';
import { getModelForOperation } from './aiEngine/aiConfigService.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import QuestionEmbedding from '../models/QuestionEmbedding.js';
import { logError } from '../utils/logger.js';

// Tenant-scoped semantic question similarity — Part G of the V2 Master
// Phase 2 brief. This module is the single provider/adapter boundary: it
// prefers MongoDB Atlas Vector Search (config.questionVectorSearchIndex)
// when an operator has provisioned an index, and otherwise falls back to an
// in-application cosine comparison over QuestionEmbedding documents. Callers
// never need to know which path ran — governed generation and the question
// memory endpoint must keep working identically either way.

const EMBEDDING_MODEL = () => getModelForOperation(AI_OPERATIONS.EMBEDDING);
const MIN_SEMANTIC_SCORE = 0.82;
const FALLBACK_SCAN_LIMIT = 500;

export const isQuestionEmbeddingConfigured = () => isEmbeddingEngineConfigured();

const embedOne = async (text, { tenantId, userId, feature }) => {
  if (!isEmbeddingEngineConfigured()) return null;
  return runEngineEmbedding({
    texts: String(text || '').slice(0, 8000),
    tenantId,
    userId,
    feature,
  });
};

// Best-effort, shared by both subject types below. Never throws — an
// embedding failure must not block question/version creation, and the
// memory-check endpoint already degrades gracefully when no embedding
// exists yet for a subject.
const recordSubjectEmbedding = async ({ tenantId, subjectField, subjectId, questionText, questionType, difficulty, userId }) => {
  if (!isQuestionEmbeddingConfigured() || !String(questionText || '').trim()) return;
  try {
    const embedding = await embedOne(questionText, { tenantId, userId, feature: 'question_bank_semantic_embedding' });
    if (!embedding || !embedding.length) return;
    await QuestionEmbedding.findOneAndUpdate(
      { tenantId, [subjectField]: subjectId },
      { $set: { embedding, embeddingModel: EMBEDDING_MODEL(), questionType: questionType || null, difficulty: difficulty || null, computedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    logError(error, { context: `questionEmbeddingService.record.${subjectField}`, tenantId, subjectId });
  }
};

// Called after a question is persisted (manual or AI-generated path both
// funnel through routes/questions.js#createQuestionWithManagedImage).
export const recordQuestionEmbedding = ({ tenantId, questionId, questionText, questionType, difficulty, userId }) =>
  recordSubjectEmbedding({ tenantId, subjectField: 'questionId', subjectId: questionId, questionText, questionType, difficulty, userId });

// Called after a canonical QuestionVersion is created (routes/questionBank.js).
export const recordQuestionVersionEmbedding = ({ tenantId, questionVersionId, questionText, questionType, difficulty, userId }) =>
  recordSubjectEmbedding({ tenantId, subjectField: 'questionVersionId', subjectId: questionVersionId, questionText, questionType, difficulty, userId });

export const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0; let normA = 0; let normB = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Atlas Vector Search path. Only attempted when an operator has configured
// QUESTION_VECTOR_SEARCH_INDEX; any failure (index missing, cluster tier
// without vector search, transient error) falls through to the in-app scan
// below rather than breaking the caller.
const atlasVectorSearch = async ({ tenantId, queryEmbedding, limit }) => {
  if (!config.questionVectorSearchIndex) return null;
  try {
    const results = await QuestionEmbedding.aggregate([
      {
        $vectorSearch: {
          index: config.questionVectorSearchIndex,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: Math.max(100, limit * 10),
          limit,
          filter: { tenantId },
        },
      },
      { $project: { questionId: 1, questionVersionId: 1, questionType: 1, difficulty: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);
    return results;
  } catch (error) {
    logError(error, { context: 'questionEmbeddingService.atlasVectorSearch', tenantId, indexName: config.questionVectorSearchIndex });
    return null;
  }
};

// Tenant filtering happens in the Mongo query itself in both the Atlas path
// (filter: { tenantId }) and here — results are never pooled across tenants
// and then filtered after the fact.
const inAppCosineFallback = async ({ tenantId, queryEmbedding, limit }) => {
  const rows = await QuestionEmbedding.find({ tenantId }).sort({ computedAt: -1 }).limit(FALLBACK_SCAN_LIMIT).lean();
  return rows
    .map((row) => ({ questionId: row.questionId, questionVersionId: row.questionVersionId, questionType: row.questionType, difficulty: row.difficulty, score: cosineSimilarity(queryEmbedding, row.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

export const findSemanticQuestionMatches = async ({ tenantId, queryText, limit = 10, userId = null }) => {
  if (!isQuestionEmbeddingConfigured()) {
    return { matches: [], available: false, method: 'UNAVAILABLE_NO_EMBEDDING_PROVIDER', embeddingModel: null };
  }
  let queryEmbedding = null;
  try {
    queryEmbedding = await embedOne(queryText, { tenantId, userId, feature: 'question_bank_semantic_query' });
  } catch (error) {
    logError(error, { context: 'questionEmbeddingService.findSemanticQuestionMatches.embedQuery', tenantId });
  }
  if (!queryEmbedding || !queryEmbedding.length) {
    return { matches: [], available: false, method: 'UNAVAILABLE_EMBEDDING_FAILED', embeddingModel: EMBEDDING_MODEL };
  }

  const atlasResults = await atlasVectorSearch({ tenantId, queryEmbedding, limit });
  const rows = atlasResults !== null ? atlasResults : await inAppCosineFallback({ tenantId, queryEmbedding, limit });
  const method = atlasResults !== null ? 'ATLAS_VECTOR_SEARCH' : 'IN_APP_COSINE_FALLBACK';
  const matches = rows
    .filter((row) => row.score >= MIN_SEMANTIC_SCORE)
    .map((row) => ({ questionId: row.questionId || null, questionVersionId: row.questionVersionId || null, questionType: row.questionType, difficulty: row.difficulty, score: Number(row.score.toFixed(4)) }));
  return { matches, available: true, method, embeddingModel: EMBEDDING_MODEL };
};

// Part 6's explicit ask: "Do not silently claim production semantic memory
// while only using a bounded in-process scan." Reports whether the
// configured Atlas Vector Search index is actually reachable (a real probe
// query, not just "is the env var set") — FALLBACK covers both "not
// configured" and "configured but the probe failed" so a caller never sees
// ACTIVE without a working index behind it.
export const getVectorSearchDiagnostic = async () => {
  if (!config.questionVectorSearchIndex) {
    return { status: 'FALLBACK', reason: 'QUESTION_VECTOR_SEARCH_INDEX is not configured.', indexName: null };
  }
  try {
    await QuestionEmbedding.aggregate([
      {
        $vectorSearch: {
          index: config.questionVectorSearchIndex,
          path: 'embedding',
          queryVector: new Array(1536).fill(0),
          numCandidates: 1,
          limit: 1,
        },
      },
      { $limit: 1 },
    ]);
    return { status: 'ACTIVE', indexName: config.questionVectorSearchIndex };
  } catch (error) {
    return { status: 'FALLBACK', reason: error.message, indexName: config.questionVectorSearchIndex };
  }
};
