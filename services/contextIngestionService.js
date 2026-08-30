import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import ingestionConfig from '../config/ingestionConfig.js';
import { runEngineEmbedding, isEmbeddingEngineConfigured } from './aiEngine/aiEngineClient.js';
import { getModelForOperation } from './aiEngine/aiConfigService.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import {
  extractContentLibraryDocument,
  semanticChunkText,
  computeChunkContentHash,
} from './contentExtractionService.js';
import { fetchUrlSourceSafely, SecureUrlFetchError } from './secureUrlFetchService.js';
import { isGoogleDriveUrl } from './googleDriveSourceProvider.js';
import { logError } from '../utils/logger.js';
import ContextSet from '../models/ContextSet.js';
import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';

const EMBEDDING_MODEL = () => getModelForOperation(AI_OPERATIONS.EMBEDDING);

class ContextIngestionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ContextIngestionError';
    this.code = code || 'INGESTION_FAILED';
  }
}

export class EmbeddingFailedError extends ContextIngestionError {
  constructor(message, diagnostics = {}) {
    super(message, diagnostics.code || 'EMBEDDING_FAILED');
    this.diagnostics = diagnostics;
  }
}

// Legacy char-based chunking — kept for backward-compatible unit tests.
export const chunkText = (
  text,
  chunkSizeChars = sourceGroundedConfig.CONTEXT_CHUNK_SIZE_CHARS,
  overlapChars = sourceGroundedConfig.CONTEXT_CHUNK_OVERLAP_CHARS
) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSizeChars, normalized.length);
    if (end < normalized.length) {
      const lastSpace = normalized.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
};

const ensureEmbeddingEngineOrThrow = () => {
  if (!isEmbeddingEngineConfigured()) {
    throw new ContextIngestionError(
      'AI embeddings are not configured on this deployment (missing OPENAI_API_KEY).',
      'EMBEDDINGS_NOT_CONFIGURED'
    );
  }
};

const estimateTokens = (texts) => {
  const chars = texts.reduce((sum, t) => sum + String(t || '').length, 0);
  return Math.ceil(chars / ingestionConfig.CHARS_PER_TOKEN_ESTIMATE);
};

export const packEmbeddingBatches = (texts) => {
  const batches = [];
  let current = { texts: [], indices: [], estimatedTokens: 0 };

  texts.forEach((text, index) => {
    const piece = String(text || '');
    const pieceTokens = Math.ceil(piece.length / ingestionConfig.CHARS_PER_TOKEN_ESTIMATE);
    const wouldExceed =
      current.texts.length >= ingestionConfig.MAX_EMBEDDING_INPUTS_PER_BATCH
      || current.estimatedTokens + pieceTokens > ingestionConfig.MAX_EMBEDDING_ESTIMATED_TOKENS_PER_BATCH;

    if (current.texts.length && wouldExceed) {
      batches.push(current);
      current = { texts: [], indices: [], estimatedTokens: 0 };
    }
    current.texts.push(piece);
    current.indices.push(index);
    current.estimatedTokens += pieceTokens;
  });

  if (current.texts.length) batches.push(current);
  return batches;
};

const normalizeProviderError = (error) => ({
  code: error?.code || error?.error?.code || error?.type || 'EMBEDDING_PROVIDER_ERROR',
  status: error?.status || error?.response?.status || null,
  message: String(error?.message || 'Embedding request failed').slice(0, 500),
});

export const embedTexts = async (texts, {
  tenantId,
  userId,
  feature = 'source_grounded_context_embedding',
  jobId = null,
  sourceId = null,
  resourceId = null,
} = {}) => {
  ensureEmbeddingEngineOrThrow();
  if (!texts?.length) return [];

  const results = new Array(texts.length);
  const batches = packEmbeddingBatches(texts);
  const model = EMBEDDING_MODEL();

  for (const batch of batches) {
    try {
      const embeddings = await runEngineEmbedding({
        texts: batch.texts,
        tenantId,
        userId,
        feature,
      });
      if (!Array.isArray(embeddings) || embeddings.length !== batch.texts.length) {
        throw new EmbeddingFailedError('Embedding provider returned an unexpected response shape.', {
          operation: AI_OPERATIONS.EMBEDDING,
          provider: 'openai',
          model,
          tenantId,
          resourceId,
          sourceId,
          jobId,
          inputCount: batch.texts.length,
          estimatedTokens: batch.estimatedTokens,
          code: 'EMBEDDING_SHAPE_MISMATCH',
        });
      }
      batch.indices.forEach((index, i) => {
        results[index] = embeddings[i] || [];
      });
    } catch (error) {
      const diagnostics = {
        operation: AI_OPERATIONS.EMBEDDING,
        provider: 'openai',
        model,
        tenantId: tenantId ? String(tenantId) : null,
        resourceId: resourceId ? String(resourceId) : null,
        sourceId: sourceId ? String(sourceId) : null,
        jobId,
        inputCount: batch.texts.length,
        estimatedTokens: batch.estimatedTokens,
        ...normalizeProviderError(error),
      };
      logError(error, { context: 'contextIngestionService.embedTexts', ...diagnostics });
      throw error instanceof EmbeddingFailedError ? error : new EmbeddingFailedError(diagnostics.message, diagnostics);
    }
  }

  return results;
};

export const embedSingleText = async (text, context = {}) => {
  const [embedding] = await embedTexts([text], context);
  return embedding;
};

export const persistChunks = async ({
  tenantId,
  contextSetId,
  sourceId,
  texts,
  embeddings,
  contentHashes = [],
  sectionTitles = [],
}) => {
  const docs = texts.map((text, index) => ({
    tenantId,
    contextSetId: contextSetId || null,
    sourceId,
    chunkIndex: index,
    text,
    charCount: text.length,
    contentHash: contentHashes[index] || computeChunkContentHash(text),
    sectionTitle: sectionTitles[index] || '',
    sectionLevel: 'CHUNK',
    embedding: embeddings[index],
    embeddingModel: EMBEDDING_MODEL(),
  }));
  if (docs.length) await ContextChunk.insertMany(docs, { ordered: false });
  return docs.length;
};

export const finalizeSourceSuccess = async (source, { extractedCharCount, chunkCount, processingStage = 'AI_READY' } = {}) => {
  source.status = 'READY';
  source.processingStage = processingStage;
  source.extractedCharCount = extractedCharCount;
  source.chunkCount = chunkCount;
  source.processedChunks = chunkCount;
  source.totalChunks = chunkCount;
  source.processedAt = new Date();
  source.lastHeartbeatAt = new Date();
  source.failureReason = '';
  source.errorCode = '';
  await source.save();
  if (source.contextSetId) {
    await ContextSet.updateOne({ _id: source.contextSetId }, { $inc: { sourceCount: 1 } });
  }
  return source;
};

export const finalizeSourceFailure = async (source, failureReason, errorCode = '', { retryable = true } = {}) => {
  source.status = 'FAILED';
  source.processingStage = 'FAILED';
  source.failureReason = String(failureReason || 'Processing failed.').slice(0, 500);
  source.errorCode = errorCode || '';
  source.retryable = retryable;
  source.lastHeartbeatAt = new Date();
  await source.save();
  return source;
};

export const updateSourceStage = async (source, stage, extra = {}) => {
  source.processingStage = stage;
  source.status = ['AI_READY'].includes(stage) ? 'READY' : 'PROCESSING';
  source.stageStartedAt = new Date();
  source.lastHeartbeatAt = new Date();
  Object.assign(source, extra);
  await source.save();
  return source;
};

const ensureUnderSourceCap = async ({ tenantId, contextSetId }) => {
  if (!contextSetId) return;
  const existingCount = await ContextSource.countDocuments({ tenantId, contextSetId });
  if (existingCount >= sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET) {
    throw new ContextIngestionError(
      `A generation session may include at most ${sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET} sources.`,
      'SOURCE_CAP_EXCEEDED'
    );
  }
};

const UNSUPPORTED_FILE_TYPE_MESSAGE_PREFIX = 'Unsupported file type.';

export const finalizeSourceUnsupported = async (source, message, errorCode = 'UNSUPPORTED_FOR_AI') => {
  source.status = errorCode === 'AI_GENERATION_NOT_ENABLED' ? 'STORED_ONLY' : 'UNSUPPORTED_FOR_AI';
  source.processingStage = errorCode === 'AI_GENERATION_NOT_ENABLED' ? 'STORED_ONLY' : 'UNSUPPORTED_FOR_AI';
  source.failureReason = String(message || 'AI indexing is not available for this file type.').slice(0, 500);
  source.errorCode = errorCode;
  source.lastHeartbeatAt = new Date();
  await source.save();
  return source;
};

const extractDocumentText = async ({ file, tenantId, userId }) =>
  extractContentLibraryDocument(file, { tenantId, userId });

export const buildChunksWithIncrementalEmbeddings = async ({
  tenantId,
  userId,
  sourceId,
  texts,
  existingHashes = new Map(),
  embedContext = {},
}) => {
  const embeddings = new Array(texts.length);
  const contentHashes = texts.map((text) => computeChunkContentHash(text));
  const toEmbed = [];
  const toEmbedIndices = [];

  texts.forEach((text, index) => {
    const hash = contentHashes[index];
    const reused = existingHashes.get(hash);
    if (reused?.embedding?.length) {
      embeddings[index] = reused.embedding;
    } else {
      toEmbed.push(text);
      toEmbedIndices.push(index);
    }
  });

  if (toEmbed.length) {
    const fresh = await embedTexts(toEmbed, { tenantId, userId, sourceId, ...embedContext });
    toEmbedIndices.forEach((index, i) => {
      embeddings[index] = fresh[i] || [];
    });
  }

  return { embeddings, contentHashes };
};

/**
 * Core indexing pipeline for a stored file source.
 */
export const processStoredFileSource = async ({
  source,
  file,
  tenantId,
  userId,
  skipEmbedding = false,
  forLibrary = true,
  onProgress = async () => {},
  embedContext = {},
}) => {
  await updateSourceStage(source, 'EXTRACTING');
  await onProgress(20, 'Extracting content');

  const parsed = await extractDocumentText({ file, tenantId, userId, forLibrary });
  const text = String(parsed?.text || '').trim();

  source.extractionMethod = parsed?.extractionMethod || 'text';
  source.extractionConfidence = parsed?.confidence ?? null;
  source.needsReview = Boolean(parsed?.needsReview);
  source.pageClass = parsed?.pageClass || '';
  source.ocrPageCount = parsed?.ocrPages || 0;
  source.nativePageCount = parsed?.nativePages || 0;
  source.totalPages = parsed?.nativePages || parsed?.ocrPages || 0;
  await source.save();

  if (!text) {
    return finalizeSourceFailure(source, 'No extractable text was found in this file.', 'SOURCE_EMPTY', { retryable: false });
  }

  await updateSourceStage(source, 'CHUNKING');
  await onProgress(40, 'Chunking content');
  const chunks = semanticChunkText(text);
  if (!chunks.length) {
    return finalizeSourceFailure(source, 'No extractable text was found in this file.', 'SOURCE_EMPTY', { retryable: false });
  }

  source.totalChunks = chunks.length;
  await source.save();

  if (skipEmbedding) {
    source.extractedCharCount = text.length;
    return finalizeSourceUnsupported(
      source,
      'AI indexing is not enabled for this tenant. This file is stored for reference only.',
      'AI_GENERATION_NOT_ENABLED'
    );
  }

  const existingChunks = await ContextChunk.find({ tenantId, sourceId: source._id }).lean();
  const existingHashes = new Map(existingChunks.map((c) => [c.contentHash, c]));

  await updateSourceStage(source, 'EMBEDDING', { processedChunks: 0 });
  await onProgress(60, 'Embedding chunks');

  const { embeddings, contentHashes } = await buildChunksWithIncrementalEmbeddings({
    tenantId,
    userId,
    sourceId: source._id,
    texts: chunks,
    existingHashes,
    embedContext,
  });

  await ContextChunk.deleteMany({ tenantId, sourceId: source._id });
  await persistChunks({
    tenantId,
    contextSetId: source.contextSetId,
    sourceId: source._id,
    texts: chunks,
    embeddings,
    contentHashes,
  });

  await updateSourceStage(source, 'INDEXING');
  await onProgress(90, 'Finalizing index');
  return finalizeSourceSuccess(source, { extractedCharCount: text.length, chunkCount: chunks.length });
};

export const ingestFileSource = async ({
  tenantId,
  userId,
  contextSetId = null,
  file,
  libraryFields = null,
  skipEmbedding = false,
  deferProcessing = false,
}) => {
  await ensureUnderSourceCap({ tenantId, contextSetId });

  const source = await ContextSource.create({
    tenantId,
    contextSetId,
    createdBy: userId,
    sourceType: 'FILE',
    originalFilename: file.originalname,
    fileExtension: (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase(),
    fileSizeBytes: file.size || file.buffer?.length || 0,
    status: deferProcessing ? 'PENDING' : 'PROCESSING',
    processingStage: deferProcessing ? 'QUEUED' : 'EXTRACTING',
    ...(libraryFields || {}),
  });

  if (deferProcessing) {
    return source;
  }

  try {
    return await processStoredFileSource({
      source,
      file,
      tenantId,
      userId,
      skipEmbedding,
      forLibrary: Boolean(libraryFields),
    });
  } catch (error) {
    if (libraryFields && String(error?.message || '').startsWith(UNSUPPORTED_FILE_TYPE_MESSAGE_PREFIX)) {
      return finalizeSourceUnsupported(source, error.message);
    }
    await finalizeSourceFailure(source, error?.message || 'Failed to process this file.', 'SOURCE_EXTRACTION_FAILED');
    return source;
  }
};

export const ingestUrlSource = async ({ tenantId, userId, contextSetId = null, url, libraryFields = null, skipEmbedding = false }) => {
  await ensureUnderSourceCap({ tenantId, contextSetId });

  const source = await ContextSource.create({
    tenantId,
    contextSetId,
    createdBy: userId,
    sourceType: 'URL',
    sourceUrl: url,
    status: 'PROCESSING',
    processingStage: 'EXTRACTING',
    ...(libraryFields || {}),
  });

  let extractionAttempted = false;

  try {
    const fetched = await fetchUrlSourceSafely({ url });
    source.resolvedIp = fetched.resolvedIp;
    source.fetchedAt = new Date();
    source.httpStatus = fetched.httpStatus;
    source.httpContentType = fetched.contentType;
    source.sourceProvider = fetched.sourceProvider || 'WEB';

    let text;
    if (fetched.isBinary) {
      source.originalFilename = fetched.filename;
      source.extractionMethod = 'file-pipeline';
      extractionAttempted = true;
      const parsed = await extractContentLibraryDocument(
        { originalname: fetched.filename, buffer: fetched.buffer, size: fetched.buffer.length },
        { tenantId, userId }
      );
      text = String(parsed?.text || '').trim();
    } else {
      source.snapshotHash = fetched.snapshotHash;
      source.extractionMethod = fetched.contentType === 'application/pdf' ? 'pdf' : 'text';
      text = String(fetched.text || '').trim();
    }

    if (!text) {
      await finalizeSourceFailure(source, 'No extractable text was found at this URL.', 'SOURCE_EMPTY', { retryable: false });
      return source;
    }

    const chunks = libraryFields ? semanticChunkText(text) : chunkText(text);
    if (!chunks.length) {
      await finalizeSourceFailure(source, 'No extractable text was found at this URL.', 'SOURCE_EMPTY', { retryable: false });
      return source;
    }

    if (skipEmbedding) {
      source.extractedCharCount = text.length;
      return finalizeSourceUnsupported(
        source,
        'AI indexing is not enabled for this tenant. This link is stored for reference only.',
        'AI_GENERATION_NOT_ENABLED'
      );
    }

    const embeddings = await embedTexts(chunks, { tenantId, userId, sourceId: source._id });
    await persistChunks({ tenantId, contextSetId, sourceId: source._id, texts: chunks, embeddings });
    return finalizeSourceSuccess(source, { extractedCharCount: text.length, chunkCount: chunks.length });
  } catch (error) {
    if (libraryFields && !(error instanceof SecureUrlFetchError) && String(error?.message || '').startsWith(UNSUPPORTED_FILE_TYPE_MESSAGE_PREFIX)) {
      return finalizeSourceUnsupported(source, error.message);
    }
    const message =
      error instanceof SecureUrlFetchError
        ? error.message
        : error?.message || (extractionAttempted ? 'Failed to extract content from this file.' : 'Failed to fetch this URL.');
    const errorCode = error instanceof SecureUrlFetchError
      ? error.code
      : extractionAttempted
        ? 'SOURCE_EXTRACTION_FAILED'
        : 'SOURCE_FETCH_FAILED';
    source.sourceProvider = source.sourceProvider || (isGoogleDriveUrl(url) ? 'GOOGLE_DRIVE' : 'WEB');
    await finalizeSourceFailure(source, message, errorCode);
    return source;
  }
};

export const getOrCreateContextSet = async ({ tenantId, userId, contextSetId, examId = null }) => {
  if (contextSetId) {
    const existing = await ContextSet.findOne({ _id: contextSetId, tenantId });
    if (existing) return existing;
  }
  return ContextSet.create({ tenantId, createdBy: userId, examId, status: 'DRAFT' });
};

export { ContextIngestionError };
