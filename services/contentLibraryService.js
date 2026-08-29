import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { CONTENT_SCOPE_FIELDS, isContentScopeReadable, isGlobalContentScope } from '../utils/contentScope.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import {
  ingestFileSource,
  ingestUrlSource,
  chunkText,
  embedTexts,
  persistChunks,
  finalizeSourceSuccess,
  finalizeSourceFailure,
  finalizeSourceUnsupported,
} from './contextIngestionService.js';
import { isS3Configured, putPrivateObject, getPrivateObjectBuffer, deletePrivateObject, getPrivateSignedUrl } from './storage/imageStorage.js';
import { parseQuestionImportFile } from './questionImportImageService.js';

// Content Library (Blueprint section 7A / master brief Parts E-N) — a
// persistent, scoped view over the SAME ContextSource/ContextChunk
// collections the existing Source-Grounded AI feature already uses
// (isLibraryItem: true distinguishes a genuine library entry from an ad
// hoc per-exam-generation upload). This file owns Content-Library-specific
// authorization (who may upload/see/manage what); it deliberately does not
// duplicate ingestion, retrieval, or embedding logic — see
// contextIngestionService.js / contextRetrievalService.js, both reused here
// and by generation verbatim.

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

// Only Teacher/Academic Admin/Tenant Admin may add material to the
// persistent Content Library (Part H: "Do NOT give every Exam Creator
// unrestricted academic-content governance"). An Exam Creator keeps their
// existing, unchanged ad hoc "upload material for this assessment" path
// (routes/ai.js POST /context-sources) — that is a different, narrower
// capability this file does not touch.
const assertLibraryUploadAllowed = (user) => {
  if (!hasRole(user, 'TEACHER') && !hasRole(user, 'ACADEMIC_ADMIN') && !hasRole(user, 'TENANT_ADMIN')) {
    throw new ContentLibraryError(403, 'Only a Teacher, Academic Admin, or Tenant Admin can add Content Library material.', 'UPLOAD_NOT_ALLOWED');
  }
};

const resolveUploadMetadata = async (user, { contentType, visibility, academicScope, chapter, unit, topic } = {}) => {
  assertLibraryUploadAllowed(user);
  const normalizedContentType = CONTENT_TYPES.includes(contentType) ? contentType : 'OTHER';
  const normalizedVisibility = VISIBILITIES.includes(visibility) ? visibility : 'PRIVATE';
  // Teacher-created content defaults to a bounded scope; only Academic/
  // Tenant Admin may publish tenant-wide SHARED material (Part H).
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

// Content Library storage is decoupled from AI generation (Part P): a
// tenant may store/organize/browse a Content Library without the
// SOURCE_GROUNDED_GENERATION entitlement — the upload still succeeds and
// the original is retained, only the embed/index step is skipped (see
// ingestFileSource/ingestUrlSource's skipEmbedding param).
const isAiIndexingEnabled = async (tenantId) => {
  const feature = await resolveTenantFeature(tenantId, 'AI_CONTENT_INDEXING');
  return feature?.effectiveEnabled === true;
};

export const uploadContentLibraryFile = async (user, { file, contentType, visibility, academicScope, chapter, unit, topic, libraryResourceId }) => {
  const libraryFields = await resolveUploadMetadata(user, { contentType, visibility, academicScope, chapter, unit, topic });
  if (!isS3Configured()) {
    throw new ContentLibraryError(503, 'Content Library file storage is not configured on this deployment.', 'STORAGE_NOT_CONFIGURED');
  }
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
  return ingestFileSource({
    tenantId: libraryFields.tenantId,
    userId: user._id,
    contextSetId: null,
    file,
    libraryFields: {
      ...libraryFields,
      ...(originalObject ? { originalObject } : {}),
      ...(libraryResourceId ? { libraryResourceId } : {}),
    },
    skipEmbedding,
  });
};

export const uploadContentLibraryUrl = async (user, { url, contentType, visibility, academicScope, chapter, unit, topic, libraryResourceId }) => {
  const libraryFields = await resolveUploadMetadata(user, { contentType, visibility, academicScope, chapter, unit, topic });
  const skipEmbedding = !(await isAiIndexingEnabled(libraryFields.tenantId));
  return ingestUrlSource({
    tenantId: libraryFields.tenantId,
    userId: user._id,
    contextSetId: null,
    url,
    libraryFields: { ...libraryFields, ...(libraryResourceId ? { libraryResourceId } : {}) },
    skipEmbedding,
  });
};

export const listContentLibrarySources = async (user, { contentType, status, uploadedBy, search, scope } = {}) => {
  const visibility = await resolveAcademicVisibility(user);
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
    // Cheap DB-level narrowing (excludes everyone else's PRIVATE docs);
    // the finer scope-vs-visibility check below still runs in-app, same
    // established pattern as assessmentGovernance.js#filterReadableItems.
    filter.$and = [...(filter.$and || []), { $or: [{ createdBy: user._id }, { visibility: { $ne: 'PRIVATE' } }] }];
  }

  const docs = await ContextSource.find(filter)
    .select('sourceType originalFilename sourceUrl status failureReason errorCode sourceProvider contentType visibility academicScope chapter unit topic chunkCount extractedCharCount originalObject createdBy createdAt')
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
  const visibility = await resolveAcademicVisibility(user);
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
      // Best-effort — the metadata row is still removed even if the S3
      // delete itself fails (e.g. transient network error); an orphaned
      // object costs storage, not correctness or security.
    }
  }
  await ContextSource.deleteOne({ _id: doc._id });
  return { deleted: true };
};

// Re-runs parse -> chunk -> embed against the already-stored private
// original, in place (same _id — any Exam already referencing this source
// via Question.provenance.sourceIds must keep pointing at a live document).
export const reprocessContentLibrarySource = async (user, sourceId) => {
  const doc = await getContentLibrarySourceForWrite(user, sourceId);
  if (doc.sourceType !== 'FILE' || !doc.originalObject?.key) {
    throw new ContentLibraryError(400, 'Only a file-based source with a stored original can be reprocessed.', 'REPROCESS_UNSUPPORTED');
  }
  await ContextChunk.deleteMany({ tenantId: doc.tenantId, sourceId: doc._id });
  doc.status = 'PROCESSING';
  doc.failureReason = '';
  doc.errorCode = '';
  await doc.save();

  const buffer = await getPrivateObjectBuffer({ key: doc.originalObject.key });
  const file = { originalname: doc.originalFilename, buffer, size: buffer.length, mimetype: doc.originalObject.mimeType };

  try {
    const parsed = await parseQuestionImportFile(file, { tenantId: doc.tenantId });
    const text = String(parsed?.text || '').trim();
    if (!text) return finalizeSourceFailure(doc, 'No extractable text was found in this file.', 'SOURCE_EMPTY');
    const chunks = chunkText(text);
    if (!chunks.length) return finalizeSourceFailure(doc, 'No extractable text was found in this file.', 'SOURCE_EMPTY');
    const embeddings = await embedTexts(chunks, { tenantId: doc.tenantId, userId: user._id });
    await persistChunks({ tenantId: doc.tenantId, contextSetId: null, sourceId: doc._id, texts: chunks, embeddings });
    doc.extractionMethod = parsed?.extractionMethod || 'text';
    return finalizeSourceSuccess(doc, { extractedCharCount: text.length, chunkCount: chunks.length });
  } catch (error) {
    if (String(error?.message || '').startsWith('Unsupported file type.')) {
      return finalizeSourceUnsupported(doc, error.message);
    }
    return finalizeSourceFailure(doc, error?.message || 'Failed to process this file.', 'SOURCE_EXTRACTION_FAILED');
  }
};

export const getContentLibraryOriginalSignedUrl = async (user, sourceId) => {
  const doc = await getContentLibrarySourceForRead(user, sourceId);
  if (!doc.originalObject?.key) throw new ContentLibraryError(404, 'No stored original file is available for this source.', 'NO_ORIGINAL_FILE');
  const url = await getPrivateSignedUrl({ key: doc.originalObject.key });
  return { url, mimeType: doc.originalObject.mimeType, filename: doc.originalFilename };
};

// Called by routes/ai.js immediately before generation, for every selected
// contextSourceId that is NOT the requesting user's own upload. Fails
// closed: any one unauthorized source rejects the whole request rather
// than silently dropping it (Part S: "A source excluded by authorization
// must never be placed in the AI prompt").
export const assertContentSourcesSelectable = async (user, sources) => {
  const foreignLibrarySources = sources.filter((source) => String(source.createdBy) !== String(user._id));
  if (!foreignLibrarySources.length) return;
  const visibility = await resolveAcademicVisibility(user);
  if (visibility.all) return;
  const unauthorized = foreignLibrarySources.find((source) => {
    if (!source.isLibraryItem) return true; // another user's ad hoc per-exam upload was never shareable
    if (source.visibility === 'PRIVATE') return true;
    return !isContentScopeReadable(visibility, source.academicScope || {});
  });
  if (unauthorized) {
    throw new ContentLibraryError(403, 'One or more selected sources are outside your authorized academic scope.', 'SOURCE_NOT_AUTHORIZED');
  }
};
