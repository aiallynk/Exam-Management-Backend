import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import LibraryResource from '../models/LibraryResource.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { resolveContentLibraryVisibility } from './contentLibraryAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { CONTENT_SCOPE_FIELDS, isContentScopeReadable, isGlobalContentScope } from '../utils/contentScope.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import {
  ingestUrlSource,
  finalizeSourceSuccess,
  finalizeSourceFailure,
  finalizeSourceUnsupported,
  processStoredFileSource,
  updateSourceStage,
} from './contextIngestionService.js';
import { computeFileContentHash } from './contentExtractionService.js';
import {
  cloneEmbeddingsFromDuplicateSource,
  enqueueContentIndexing,
  findReusableSourceByHash,
  refreshBatchCounters,
} from './ingestionBatchService.js';
import { isS3Configured, putPrivateObject, getPrivateObjectBuffer, deletePrivateObject, getPrivateSignedUrl } from './storage/imageStorage.js';
import ingestionConfig from '../config/ingestionConfig.js';

export class ContentLibraryError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ContentLibraryError';
    this.status = status;
    this.statusCode = status;
    this.code = code || 'CONTENT_LIBRARY_ERROR';
  }
}

const CONTENT_TYPES = ['TEXTBOOK', 'CHAPTER', 'SYLLABUS', 'NOTES', 'WORKSHEET', 'PAST_PAPER', 'QUESTION_MATERIAL', 'REFERENCE_MATERIAL', 'OTHER'];
const VISIBILITIES = ['PRIVATE', 'COURSE', 'SHARED'];

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeAcademicScope = (raw = {}) => {
  const scope = {};
  Object.keys(CONTENT_SCOPE_FIELDS).forEach((field) => {
    if (raw && raw[field]) scope[field] = String(raw[field]);
  });
  return scope;
};

const assertLibraryUploadAllowed = (user) => {
  if (!hasRole(user, 'TEACHER') && !hasRole(user, 'ACADEMIC_ADMIN') && !hasRole(user, 'TENANT_ADMIN')) {
    throw new ContentLibraryError(403, 'Only a Teacher, Academic Admin, or Tenant Admin can add Content Library material.', 'UPLOAD_NOT_ALLOWED');
  }
};

const resolveUploadMetadata = async (user, { contentType, visibility, academicScope, chapter, unit, topic } = {}) => {
  assertLibraryUploadAllowed(user);
  const normalizedContentType = CONTENT_TYPES.includes(contentType) ? contentType : 'OTHER';
  const normalizedVisibility = VISIBILITIES.includes(visibility) ? visibility : 'PRIVATE';
  if (normalizedVisibility === 'SHARED' && !hasRole(user, 'ACADEMIC_ADMIN') && !hasRole(user, 'TENANT_ADMIN')) {
    throw new ContentLibraryError(403, 'Only Academic Admin or Tenant Admin may publish Shared academic content.', 'SHARED_NOT_ALLOWED');
  }
  const scope = normalizeAcademicScope(academicScope);
  if (normalizedVisibility === 'COURSE' && isGlobalContentScope(scope)) {
    throw new ContentLibraryError(400, 'Course-visibility content needs at least one academic scope field selected.', 'SCOPE_REQUIRED');
  }
  const visibilityRecord = await resolveAcademicVisibility(user);
  if (!visibilityRecord.all && !isContentScopeReadable(visibilityRecord, scope)) {
    throw new ContentLibraryError(403, 'The selected academic scope is outside your delegated academic scope.', 'SCOPE_NOT_AUTHORIZED');
  }
  return {
    tenantId: visibilityRecord.tenantId,
    isLibraryItem: true,
    contentType: normalizedContentType,
    visibility: normalizedVisibility,
    academicScope: scope,
    chapter: String(chapter || '').trim().slice(0, 200),
    unit: String(unit || '').trim().slice(0, 200),
    topic: String(topic || '').trim().slice(0, 200),
  };
};

const isAiIndexingEnabled = async (tenantId) => {
  const feature = await resolveTenantFeature(tenantId, 'AI_CONTENT_INDEXING');
  return feature?.effectiveEnabled === true;
};

export const uploadContentLibraryFile = async (user, {
  file,
  contentType,
  visibility,
  academicScope,
  chapter,
  unit,
  topic,
  libraryResourceId,
  batchId = null,
}) => {
  const libraryFields = await resolveUploadMetadata(user, { contentType, visibility, academicScope, chapter, unit, topic });
  if (!isS3Configured()) {
    throw new ContentLibraryError(503, 'Content Library file storage is not configured on this deployment.', 'STORAGE_NOT_CONFIGURED');
  }

  const fileContentHash = computeFileContentHash(file.buffer);
  const extension = ((file.originalname || '').match(/\.[^.]+$/)?.[0] || '').replace('.', '') || 'bin';
  const stored = await putPrivateObject({
    tenantId: libraryFields.tenantId,
    category: 'content-library',
    subpath: [String(user._id)],
    fileStem: 'source',
    extension,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
  const originalObject = stored ? { key: stored.key, sizeBytes: file.size || file.buffer?.length || 0, mimeType: file.mimetype || '' } : null;
  const skipEmbedding = !(await isAiIndexingEnabled(libraryFields.tenantId));

  const prior = await findReusableSourceByHash({ tenantId: libraryFields.tenantId, fileContentHash });

  const source = await ContextSource.create({
    tenantId: libraryFields.tenantId,
    contextSetId: null,
    createdBy: user._id,
    sourceType: 'FILE',
    originalFilename: file.originalname,
    fileExtension: (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase(),
    fileSizeBytes: file.size || file.buffer?.length || 0,
    status: skipEmbedding ? 'STORED_ONLY' : 'PENDING',
    processingStage: skipEmbedding ? 'STORED_ONLY' : 'QUEUED',
    fileContentHash,
    ingestionBatchId: batchId || null,
    ingestionPriority: ingestionConfig.DEFAULT_INGESTION_PRIORITY,
    lastHeartbeatAt: new Date(),
    ...libraryFields,
    ...(originalObject ? { originalObject } : {}),
    ...(libraryResourceId ? { libraryResourceId } : {}),
  });

  if (skipEmbedding) {
    return finalizeSourceUnsupported(
      source,
      'AI indexing is not enabled for this tenant. This file is stored for reference only.',
      'AI_GENERATION_NOT_ENABLED'
    );
  }

  if (prior && String(prior._id) !== String(source._id)) {
    const cloned = await cloneEmbeddingsFromDuplicateSource({
      tenantId: libraryFields.tenantId,
      targetSourceId: source._id,
      priorSourceId: prior._id,
    });
    if (cloned > 0) {
      return finalizeSourceSuccess(source, {
        extractedCharCount: prior.extractedCharCount || 0,
        chunkCount: cloned,
        processingStage: 'AI_READY',
      });
    }
  }

  const job = await enqueueContentIndexing({
    tenantId: libraryFields.tenantId,
    userId: user._id,
    sourceId: source._id,
    resourceId: libraryResourceId || null,
    batchId,
  });

  source.processingJobId = job.jobId || '';
  await source.save();
  return source;
};

export const uploadContentLibraryUrl = async (user, { url, contentType, visibility, academicScope, chapter, unit, topic, libraryResourceId, batchId = null }) => {
  const libraryFields = await resolveUploadMetadata(user, { contentType, visibility, academicScope, chapter, unit, topic });
  const skipEmbedding = !(await isAiIndexingEnabled(libraryFields.tenantId));
  return ingestUrlSource({
    tenantId: libraryFields.tenantId,
    userId: user._id,
    contextSetId: null,
    url,
    libraryFields: { ...libraryFields, ...(libraryResourceId ? { libraryResourceId } : {}), ingestionBatchId: batchId },
    skipEmbedding,
  });
};

export const listContentLibrarySources = async (user, { contentType, status, uploadedBy, search, scope } = {}) => {
  const visibility = await resolveContentLibraryVisibility(user);
  const filter = { tenantId: visibility.tenantId, isLibraryItem: true };
  if (contentType) filter.contentType = contentType;
  if (status) filter.status = status;
  if (uploadedBy) filter.createdBy = uploadedBy;
  if (search) {
    const re = new RegExp(escapeRegExp(search), 'i');
    filter.$or = [{ originalFilename: re }, { sourceUrl: re }, { topic: re }, { chapter: re }, { unit: re }];
  }
  if (scope === 'mine') {
    filter.createdBy = user._id;
  } else if (!visibility.all) {
    filter.$and = [...(filter.$and || []), { $or: [{ createdBy: user._id }, { visibility: { $ne: 'PRIVATE' } }] }];
  }

  const docs = await ContextSource.find(filter)
    .select('sourceType originalFilename sourceUrl status processingStage failureReason errorCode sourceProvider contentType visibility academicScope chapter unit topic chunkCount extractedCharCount originalObject createdBy createdAt processingJobId lastHeartbeatAt')
    .sort({ createdAt: -1 })
    .limit(500)
    .populate('createdBy', 'name email')
    .lean();

  if (visibility.all || scope === 'mine') return docs;
  return docs.filter((doc) => {
    if (String(doc.createdBy?._id || doc.createdBy || '') === String(user._id)) return true;
    if (doc.visibility === 'PRIVATE') return false;
    return isContentScopeReadable(visibility, doc.academicScope || {});
  });
};

export const getContentLibrarySourceForRead = async (user, sourceId) => {
  const visibility = await resolveContentLibraryVisibility(user);
  const doc = await ContextSource.findOne({ _id: sourceId, tenantId: visibility.tenantId, isLibraryItem: true }).lean();
  if (!doc) throw new ContentLibraryError(404, 'Content Library source not found.', 'NOT_FOUND');
  const isOwner = String(doc.createdBy) === String(user._id);
  if (!visibility.all && !isOwner) {
    if (doc.visibility === 'PRIVATE' || !isContentScopeReadable(visibility, doc.academicScope || {})) {
      throw new ContentLibraryError(403, 'This content is outside your authorized academic scope.', 'SCOPE_NOT_AUTHORIZED');
    }
  }
  return doc;
};

const getContentLibrarySourceForWrite = async (user, sourceId) => {
  const visibility = await resolveAcademicVisibility(user);
  const doc = await ContextSource.findOne({ _id: sourceId, tenantId: visibility.tenantId, isLibraryItem: true });
  if (!doc) throw new ContentLibraryError(404, 'Content Library source not found.', 'NOT_FOUND');
  const isOwner = String(doc.createdBy) === String(user._id);
  const isPrivilegedAdmin =
    hasRole(user, 'TENANT_ADMIN') ||
    (hasRole(user, 'ACADEMIC_ADMIN') && (visibility.all || isContentScopeReadable(visibility, doc.academicScope || {})));
  if (!isOwner && !isPrivilegedAdmin) {
    throw new ContentLibraryError(403, 'You can only manage your own content, or content within your delegated academic scope.', 'NOT_AUTHORIZED');
  }
  return doc;
};

export const updateContentLibrarySourceMetadata = async (user, sourceId, updates = {}) => {
  const doc = await getContentLibrarySourceForWrite(user, sourceId);
  const libraryFields = await resolveUploadMetadata(user, {
    contentType: updates.contentType ?? doc.contentType,
    visibility: updates.visibility ?? doc.visibility,
    academicScope: updates.academicScope ?? doc.academicScope,
    chapter: updates.chapter ?? doc.chapter,
    unit: updates.unit ?? doc.unit,
    topic: updates.topic ?? doc.topic,
  });
  doc.contentType = libraryFields.contentType;
  doc.visibility = libraryFields.visibility;
  doc.academicScope = libraryFields.academicScope;
  doc.chapter = libraryFields.chapter;
  doc.unit = libraryFields.unit;
  doc.topic = libraryFields.topic;
  await doc.save();
  return doc;
};

export const deleteContentLibrarySource = async (user, sourceId) => {
  const doc = await getContentLibrarySourceForWrite(user, sourceId);
  await ContextChunk.deleteMany({ tenantId: doc.tenantId, sourceId: doc._id });
  if (doc.originalObject?.key) {
    try {
      await deletePrivateObject({ key: doc.originalObject.key });
    } catch {
      // best effort
    }
  }
  await ContextSource.deleteOne({ _id: doc._id });
  return { deleted: true };
};

export const reprocessContentLibrarySource = async (user, sourceId, { onProgress = async () => {}, jobId = null } = {}) => {
  const doc = await getContentLibrarySourceForWrite(user, sourceId);
  if (doc.sourceType !== 'FILE' || !doc.originalObject?.key) {
    throw new ContentLibraryError(400, 'Only a file-based source with a stored original can be reprocessed.', 'REPROCESS_UNSUPPORTED');
  }

  const skipEmbedding = !(await isAiIndexingEnabled(doc.tenantId));
  if (skipEmbedding) {
    return finalizeSourceUnsupported(
      doc,
      'AI indexing is not enabled for this tenant. This file is stored for reference only.',
      'AI_GENERATION_NOT_ENABLED'
    );
  }

  doc.retryCount = (doc.retryCount || 0) + 1;
  doc.status = 'PROCESSING';
  doc.processingStage = 'EXTRACTING';
  doc.failureReason = '';
  doc.errorCode = '';
  doc.processingJobId = jobId || doc.processingJobId || '';
  await doc.save();

  const buffer = await getPrivateObjectBuffer({ key: doc.originalObject.key });
  const file = { originalname: doc.originalFilename, buffer, size: buffer.length, mimetype: doc.originalObject.mimeType };

  try {
    const result = await processStoredFileSource({
      source: doc,
      file,
      tenantId: doc.tenantId,
      userId: user._id,
      skipEmbedding: false,
      forLibrary: true,
      onProgress,
      embedContext: { jobId, resourceId: doc.libraryResourceId },
    });
    if (doc.ingestionBatchId) await refreshBatchCounters(doc.ingestionBatchId);
    return result;
  } catch (error) {
    const retryable = !['SOURCE_EMPTY', 'UNSUPPORTED_FOR_AI', 'EMBEDDINGS_NOT_CONFIGURED'].includes(error?.code);
    if (String(error?.message || '').startsWith('Unsupported file type.')) {
      return finalizeSourceUnsupported(doc, error.message);
    }
    const failed = await finalizeSourceFailure(doc, error?.message || 'Failed to process this file.', error?.code || 'SOURCE_EXTRACTION_FAILED', { retryable });
    if (doc.ingestionBatchId) await refreshBatchCounters(doc.ingestionBatchId);
    return failed;
  }
};

export const markStaleSources = async () => {
  const cutoff = new Date(Date.now() - ingestionConfig.STALE_HEARTBEAT_MS);
  const result = await ContextSource.updateMany(
    {
      status: 'PROCESSING',
      lastHeartbeatAt: { $lt: cutoff },
    },
    {
      $set: {
        status: 'STALE',
        processingStage: 'STALE',
        failureReason: 'Processing stalled. Retry when the worker is available.',
        errorCode: 'STALE_JOB',
        retryable: true,
      },
    }
  );
  return result.modifiedCount || 0;
};

export const getContentLibraryOriginalSignedUrl = async (user, sourceId) => {
  const doc = await getContentLibrarySourceForRead(user, sourceId);
  if (!doc.originalObject?.key) throw new ContentLibraryError(404, 'No stored original file is available for this source.', 'NO_ORIGINAL_FILE');
  const url = await getPrivateSignedUrl({ key: doc.originalObject.key });
  return { url, mimeType: doc.originalObject.mimeType, filename: doc.originalFilename };
};

export const assertContentSourcesSelectable = async (user, sources) => {
  const foreignLibrarySources = sources.filter((source) => String(source.createdBy) !== String(user._id));
  if (!foreignLibrarySources.length) return;
  const visibility = await resolveContentLibraryVisibility(user);
  if (visibility.all) return;
  const resourceIds = [...new Set(
    foreignLibrarySources
      .map((source) => source.libraryResourceId)
      .filter(Boolean)
      .map(String)
  )];
  const resources = resourceIds.length
    ? await LibraryResource.find({ tenantId: visibility.tenantId, _id: { $in: resourceIds } })
      .select('_id visibility academicScope createdBy')
      .lean()
    : [];
  const resourceById = new Map(resources.map((resource) => [String(resource._id), resource]));
  const unauthorized = foreignLibrarySources.find((source) => {
    // A source attached to a logical LibraryResource inherits that
    // resource's current visibility/scope. This also repairs existing
    // sources created before ACADEMIC_SHARED was translated to SHARED for
    // ContextSource, without widening any legacy stand-alone source.
    const resource = source.libraryResourceId && resourceById.get(String(source.libraryResourceId));
    if (resource) {
      if (resource.visibility === 'PRIVATE') return true;
      return !isContentScopeReadable(visibility, resource.academicScope || {});
    }
    if (!source.isLibraryItem) return true;
    if (source.visibility === 'PRIVATE') return true;
    return !isContentScopeReadable(visibility, source.academicScope || {});
  });
  if (unauthorized) {
    throw new ContentLibraryError(403, 'One or more selected sources are outside your authorized academic scope.', 'SOURCE_NOT_AUTHORIZED');
  }
};
