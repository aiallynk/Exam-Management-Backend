import config from '../config/env.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import { getOpenAIClient } from './aiService.js';
import { createTrackedEmbedding } from './aiTokenUsageService.js';
import { parseQuestionImportFile } from './questionImportImageService.js';
import { fetchUrlSourceSafely, SecureUrlFetchError } from './secureUrlFetchService.js';
import { isGoogleDriveUrl } from './googleDriveSourceProvider.js';
import ContextSet from '../models/ContextSet.js';
import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';

// Source-Grounded AI Question Generation — file/URL ingestion, run
// synchronously inside the upload request/response (no job queue: Redis/
// BullMQ is only wired for backups today and REDIS_URL is unset in this
// environment — see plan Key Architecture Decision #3). File parsing
// reuses services/questionImportImageService.js's parseQuestionImportFile
// verbatim rather than reimplementing PDF/DOCX/XLSX/CSV/OCR extraction.

const EMBEDDING_MODEL = config.openaiEmbeddingModel;

class ContextIngestionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ContextIngestionError';
    this.code = code || 'INGESTION_FAILED';
  }
}

// Splits text into overlapping, word-boundary-respecting chunks. Pure
// function — unit-testable without touching the DB or OpenAI.
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
      // Prefer breaking on the last whitespace before the hard cutoff so
      // words are not split mid-token.
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

const getClientOrThrow = () => {
  const client = getOpenAIClient();
  if (!client) {
    throw new ContextIngestionError(
      'AI embeddings are not configured on this deployment (missing OPENAI_API_KEY).',
      'EMBEDDINGS_NOT_CONFIGURED'
    );
  }
  return client;
};

// Embeds a batch of texts with bounded concurrency, each call individually
// tracked in the shared AITokenUsage accounting collection (via
// createTrackedEmbedding) so this feature never opens a separate/parallel
// usage-accounting path.
export const embedTexts = async (texts, { tenantId, userId }) => {
  const client = getClientOrThrow();
  const results = new Array(texts.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < texts.length) {
      const index = cursor;
      cursor += 1;
      const response = await createTrackedEmbedding({
        client,
        request: { model: EMBEDDING_MODEL, input: texts[index] },
        feature: 'source_grounded_context_embedding',
        tenantId,
        userId,
      });
      results[index] = response?.data?.[0]?.embedding || [];
    }
  };

  const workerCount = Math.min(
    sourceGroundedConfig.MAX_PARALLEL_EMBEDDING_REQUESTS,
    Math.max(1, texts.length)
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
};

// Embeds a single piece of text (e.g. a generation query built from
// topic+instructions) — exported for reuse by groundedGenerationService.
export const embedSingleText = async (text, { tenantId, userId }) => {
  const [embedding] = await embedTexts([text], { tenantId, userId });
  return embedding;
};

export const persistChunks = async ({ tenantId, contextSetId, sourceId, texts, embeddings }) => {
  const docs = texts.map((text, index) => ({
    tenantId,
    contextSetId,
    sourceId,
    chunkIndex: index,
    text,
    charCount: text.length,
    embedding: embeddings[index],
    embeddingModel: EMBEDDING_MODEL,
  }));
  if (docs.length) await ContextChunk.insertMany(docs, { ordered: false });
  return docs.length;
};

export const finalizeSourceSuccess = async (source, { extractedCharCount, chunkCount }) => {
  source.status = 'READY';
  source.extractedCharCount = extractedCharCount;
  source.chunkCount = chunkCount;
  source.processedAt = new Date();
  source.failureReason = '';
  await source.save();
  await ContextSet.updateOne({ _id: source.contextSetId }, { $inc: { sourceCount: 1 } });
  return source;
};

export const finalizeSourceFailure = async (source, failureReason, errorCode = '') => {
  source.status = 'FAILED';
  source.failureReason = String(failureReason || 'Processing failed.').slice(0, 500);
  source.errorCode = errorCode || '';
  await source.save();
  return source;
};

// A Content Library upload (contextSetId null — see ContextSource.js) is
// not part of any one generation session, so the per-session 10-source cap
// does not apply to it; it is still bounded by the existing tenant-wide
// monthly enforceContextSourceLimit middleware, same as every other ingest.
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

// Content Library uploads (Part E) accept a broader file allowlist than the
// existing per-generation upload — an unsupported-for-extraction type is
// still stored (see finalizeSourceUnsupported below), never rejected.
const UNSUPPORTED_FILE_TYPE_MESSAGE_PREFIX = 'Unsupported file type.';

export const finalizeSourceUnsupported = async (source, message, errorCode = 'UNSUPPORTED_FOR_AI') => {
  source.status = 'UNSUPPORTED_FOR_AI';
  source.failureReason = String(message || 'AI indexing is not available for this file type.').slice(0, 500);
  source.errorCode = errorCode;
  await source.save();
  return source;
};

/**
 * Ingests one uploaded file: parse -> chunk -> embed -> persist. Runs
 * fully synchronously; the caller's HTTP response IS the completion
 * signal (no polling endpoint in v1).
 */
export const ingestFileSource = async ({ tenantId, userId, contextSetId = null, file, libraryFields = null, skipEmbedding = false }) => {
  await ensureUnderSourceCap({ tenantId, contextSetId });

  const source = await ContextSource.create({
    tenantId,
    contextSetId,
    createdBy: userId,
    sourceType: 'FILE',
    originalFilename: file.originalname,
    fileExtension: (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase(),
    fileSizeBytes: file.size || file.buffer?.length || 0,
    status: 'PROCESSING',
    ...(libraryFields || {}),
  });

  try {
    const parsed = await parseQuestionImportFile(file, { tenantId });
    const text = String(parsed?.text || '').trim();
    if (!text) {
      await finalizeSourceFailure(source, 'No extractable text was found in this file.', 'SOURCE_EMPTY');
      return source;
    }

    const chunks = chunkText(text);
    if (!chunks.length) {
      await finalizeSourceFailure(source, 'No extractable text was found in this file.', 'SOURCE_EMPTY');
      return source;
    }

    // Content Library storage is decoupled from AI generation (Part P): a
    // tenant without SOURCE_GROUNDED_GENERATION can still store/organize
    // this file — the original is already safely in S3 by this point
    // (see contentLibraryService.js#uploadContentLibraryFile) — it is just
    // never embedded/indexed for AI retrieval.
    if (skipEmbedding) {
      source.extractionMethod = parsed?.extractionMethod || 'text';
      source.extractedCharCount = text.length;
      return finalizeSourceUnsupported(
        source,
        'AI indexing is not enabled for this tenant. This file is stored for reference only.',
        'AI_GENERATION_NOT_ENABLED'
      );
    }

    const embeddings = await embedTexts(chunks, { tenantId, userId });
    await persistChunks({ tenantId, contextSetId, sourceId: source._id, texts: chunks, embeddings });
    source.extractionMethod = parsed?.extractionMethod || 'text';
    return finalizeSourceSuccess(source, { extractedCharCount: text.length, chunkCount: chunks.length });
  } catch (error) {
    if (libraryFields && String(error?.message || '').startsWith(UNSUPPORTED_FILE_TYPE_MESSAGE_PREFIX)) {
      return finalizeSourceUnsupported(source, error.message);
    }
    await finalizeSourceFailure(source, error?.message || 'Failed to process this file.', 'SOURCE_EXTRACTION_FAILED');
    return source;
  }
};

/**
 * Ingests one URL: SSRF-safe fetch -> sanitize -> chunk -> embed ->
 * persist. The returned text IS the immutable snapshot generation will
 * ever read from (master prompt §9 — generation never re-fetches live).
 */
export const ingestUrlSource = async ({ tenantId, userId, contextSetId = null, url, libraryFields = null, skipEmbedding = false }) => {
  await ensureUnderSourceCap({ tenantId, contextSetId });

  const source = await ContextSource.create({
    tenantId,
    contextSetId,
    createdBy: userId,
    sourceType: 'URL',
    sourceUrl: url,
    status: 'PROCESSING',
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
      // Drive frequently mislabels a FILE download's Content-Type as
      // application/octet-stream regardless of the real format — route
      // the raw bytes through the exact same extraction pipeline used
      // for directly-uploaded files (dispatches correctly by the real
      // filename/extension Drive reported via Content-Disposition)
      // instead of guessing from an untrustworthy Content-Type.
      source.originalFilename = fetched.filename;
      source.extractionMethod = 'file-pipeline';
      extractionAttempted = true;
      const parsed = await parseQuestionImportFile(
        {
          originalname: fetched.filename,
          buffer: fetched.buffer,
          size: fetched.buffer.length,
        },
        { tenantId }
      );
      text = String(parsed?.text || '').trim();
    } else {
      source.snapshotHash = fetched.snapshotHash;
      source.extractionMethod = fetched.contentType === 'application/pdf' ? 'pdf' : 'text';
      text = String(fetched.text || '').trim();
    }

    if (!text) {
      await finalizeSourceFailure(source, 'No extractable text was found at this URL.', 'SOURCE_EMPTY');
      return source;
    }

    const chunks = chunkText(text);
    if (!chunks.length) {
      await finalizeSourceFailure(source, 'No extractable text was found at this URL.', 'SOURCE_EMPTY');
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

    const embeddings = await embedTexts(chunks, { tenantId, userId });
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
