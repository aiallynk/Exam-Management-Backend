import config from '../config/env.js';
import ContextChunk from '../models/ContextChunk.js';
import ContextSource from '../models/ContextSource.js';
import { rankAndBalanceChunks, cosineSimilarity } from './contextRetrievalService.js';
import { logError } from '../utils/logger.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';

const FALLBACK_SCAN_LIMIT = 2000;

const atlasVectorSearch = async ({ tenantId, sourceIds, queryEmbedding, topK }) => {
  if (!config.contentVectorSearchIndex) return null;
  try {
    const results = await ContextChunk.aggregate([
      {
        $vectorSearch: {
          index: config.contentVectorSearchIndex,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: Math.max(100, topK * 10),
          limit: topK,
          filter: { tenantId, sourceId: { $in: sourceIds } },
        },
      },
      { $project: { text: 1, sourceId: 1, chunkIndex: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);
    const sourceMeta = await ContextSource.find({ tenantId, _id: { $in: sourceIds } })
      .select('libraryResourceId')
      .lean();
    const libraryBySource = new Map(sourceMeta.map((s) => [String(s._id), s.libraryResourceId]));
    return results.map((row) => ({
      text: row.text,
      sourceId: row.sourceId,
      chunkIndex: row.chunkIndex,
      libraryResourceId: libraryBySource.get(String(row.sourceId)) || null,
      similarity: row.score,
    }));
  } catch (error) {
    logError(error, { context: 'contextVectorSearchService.atlasVectorSearch', tenantId, indexName: config.contentVectorSearchIndex });
    return null;
  }
};

const inAppFallback = async ({ tenantId, sourceIds, queryEmbedding, topK }) => {
  const chunks = await ContextChunk.find({ tenantId, sourceId: { $in: sourceIds } })
    .select('text sourceId chunkIndex embedding')
    .limit(FALLBACK_SCAN_LIMIT)
    .lean();
  const ranked = rankAndBalanceChunks(chunks, queryEmbedding, topK);
  const sourceMeta = await ContextSource.find({ tenantId, _id: { $in: sourceIds } })
    .select('libraryResourceId')
    .lean();
  const libraryBySource = new Map(sourceMeta.map((s) => [String(s._id), s.libraryResourceId]));
  return ranked.map((chunk) => ({
    ...chunk,
    libraryResourceId: libraryBySource.get(String(chunk.sourceId)) || null,
  }));
};

export const vectorSearchContextChunks = async ({ tenantId, sourceIds, queryEmbedding, topK = sourceGroundedConfig.RETRIEVAL_TOP_K }) => {
  if (!tenantId || !Array.isArray(sourceIds) || !sourceIds.length || !queryEmbedding?.length) return [];
  const atlasResults = await atlasVectorSearch({ tenantId, sourceIds, queryEmbedding, topK });
  if (atlasResults !== null) return atlasResults;
  return inAppFallback({ tenantId, sourceIds, queryEmbedding, topK });
};

export const getContentVectorSearchDiagnostic = async () => {
  if (!config.contentVectorSearchIndex) {
    return { status: 'FALLBACK', reason: 'CONTENT_VECTOR_SEARCH_INDEX is not configured.', indexName: null };
  }
  try {
    await ContextChunk.aggregate([
      {
        $vectorSearch: {
          index: config.contentVectorSearchIndex,
          path: 'embedding',
          queryVector: new Array(1536).fill(0),
          numCandidates: 1,
          limit: 1,
        },
      },
      { $limit: 1 },
    ]);
    return { status: 'ACTIVE', indexName: config.contentVectorSearchIndex };
  } catch (error) {
    return { status: 'FALLBACK', reason: error.message, indexName: config.contentVectorSearchIndex };
  }
};

export { cosineSimilarity };
