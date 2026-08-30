import LibraryResource from '../models/LibraryResource.js';
import ContextSource from '../models/ContextSource.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { resolveContentLibraryVisibility } from './contentLibraryAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { CONTENT_SCOPE_FIELDS, isContentScopeReadable, isGlobalContentScope } from '../utils/contentScope.js';
import { uploadContentLibraryFile, uploadContentLibraryUrl, ContentLibraryError } from './contentLibraryService.js';

// LibraryResource (Blueprint section 7B / master brief Parts J-N) — the
// educator-facing logical unit ("a textbook", "a chapter", "a past paper")
// that groups one or many technical ContextSource assets underneath it via
// ContextSource.libraryResourceId. This file owns LibraryResource CRUD and
// scope authorization only; it deliberately reuses
// contentLibraryService.js's upload/ingestion functions verbatim for
// attaching an asset to a resource, rather than duplicating S3/embedding
// logic here.

const RESOURCE_TYPES = [
  'TEXTBOOK', 'BOOK', 'CHAPTER', 'SYLLABUS', 'CURRICULUM_DOCUMENT',
  'TEACHER_NOTES', 'STUDY_MATERIAL', 'LESSON_MATERIAL', 'WORKSHEET',
  'PAST_PAPER', 'MODEL_PAPER', 'MARKING_GUIDE', 'REFERENCE',
  'IMAGE_COLLECTION', 'OTHER',
];
const VISIBILITIES = ['PRIVATE', 'COURSE', 'ACADEMIC_SHARED'];

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeAcademicScope = (raw = {}) => {
  const scope = {};
  Object.keys(CONTENT_SCOPE_FIELDS).forEach((field) => {
    if (raw && raw[field]) scope[field] = String(raw[field]);
  });
  return scope;
};

// Same role gate as contentLibraryService.js#assertLibraryUploadAllowed
// (Part H) — Content Library / LibraryResource creation is a Teacher/
// Academic Admin/Tenant Admin capability, not an Exam Creator one.
const assertResourceWriteAllowed = (user) => {
  if (!hasRole(user, 'TEACHER') && !hasRole(user, 'ACADEMIC_ADMIN') && !hasRole(user, 'TENANT_ADMIN')) {
    throw new ContentLibraryError(403, 'Only a Teacher, Academic Admin, or Tenant Admin can manage Content Library resources.', 'RESOURCE_WRITE_NOT_ALLOWED');
  }
};

const normalizeTags = (raw = []) => {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 30).map((value) => value.slice(0, 80));
};

const resolveResourceFields = async (user, { title, description, resourceType, parentResourceId, academicScope, chapter, unit, topic, tags, visibility, metadata } = {}) => {
  assertResourceWriteAllowed(user);
  const normalizedTitle = String(title || '').trim().slice(0, 300);
  if (!normalizedTitle) throw new ContentLibraryError(400, 'A title is required.', 'TITLE_REQUIRED');
  const normalizedType = RESOURCE_TYPES.includes(resourceType) ? resourceType : 'OTHER';
  const normalizedVisibility = VISIBILITIES.includes(visibility) ? visibility : 'PRIVATE';
  if (normalizedVisibility === 'ACADEMIC_SHARED' && !hasRole(user, 'ACADEMIC_ADMIN') && !hasRole(user, 'TENANT_ADMIN')) {
    throw new ContentLibraryError(403, 'Only Academic Admin or Tenant Admin may publish Academic-Shared content.', 'SHARED_NOT_ALLOWED');
  }
  const scope = normalizeAcademicScope(academicScope);
  if (normalizedVisibility === 'COURSE' && isGlobalContentScope(scope)) {
    throw new ContentLibraryError(400, 'Course-visibility content needs at least one academic scope field selected.', 'SCOPE_REQUIRED');
  }
  const visibilityRecord = await resolveAcademicVisibility(user);
  if (!visibilityRecord.all && !isContentScopeReadable(visibilityRecord, scope)) {
    throw new ContentLibraryError(403, 'The selected academic scope is outside your delegated academic scope.', 'SCOPE_NOT_AUTHORIZED');
  }
  let parent = null;
  if (parentResourceId) {
    parent = await LibraryResource.findOne({ _id: parentResourceId, tenantId: visibilityRecord.tenantId });
    if (!parent) throw new ContentLibraryError(404, 'Parent resource not found.', 'PARENT_NOT_FOUND');
  }
  return {
    tenantId: visibilityRecord.tenantId,
    title: normalizedTitle,
    description: String(description || '').trim().slice(0, 2000),
    resourceType: normalizedType,
    parentResourceId: parent ? parent._id : null,
    academicScope: scope,
    chapter: String(chapter || '').trim().slice(0, 200),
    unit: String(unit || '').trim().slice(0, 200),
    topic: String(topic || '').trim().slice(0, 200),
    tags: normalizeTags(tags),
    visibility: normalizedVisibility,
    metadata: {
      publisher: String(metadata?.publisher || '').trim().slice(0, 200),
      edition: String(metadata?.edition || '').trim().slice(0, 100),
      language: String(metadata?.language || '').trim().slice(0, 100),
      isbn: String(metadata?.isbn || '').trim().slice(0, 50),
      author: String(metadata?.author || '').trim().slice(0, 200),
    },
  };
};

export const createLibraryResource = async (user, fields) => {
  const resolved = await resolveResourceFields(user, fields);
  return LibraryResource.create({ ...resolved, createdBy: user._id, approvalStatus: 'DRAFT' });
};

const getLibraryResourceForRead = async (user, resourceId) => {
  const visibility = await resolveContentLibraryVisibility(user);
  const doc = await LibraryResource.findOne({ _id: resourceId, tenantId: visibility.tenantId }).populate('createdBy', 'name email').lean();
  if (!doc) throw new ContentLibraryError(404, 'Resource not found.', 'NOT_FOUND');
  const isOwner = String(doc.createdBy?._id || doc.createdBy) === String(user._id);
  if (!visibility.all && !isOwner) {
    if (doc.visibility === 'PRIVATE' || !isContentScopeReadable(visibility, doc.academicScope || {})) {
      throw new ContentLibraryError(403, 'This resource is outside your authorized academic scope.', 'SCOPE_NOT_AUTHORIZED');
    }
  }
  return doc;
};

const getLibraryResourceForWrite = async (user, resourceId) => {
  const visibility = await resolveAcademicVisibility(user);
  const doc = await LibraryResource.findOne({ _id: resourceId, tenantId: visibility.tenantId });
  if (!doc) throw new ContentLibraryError(404, 'Resource not found.', 'NOT_FOUND');
  const isOwner = String(doc.createdBy) === String(user._id);
  const isPrivilegedAdmin =
    hasRole(user, 'TENANT_ADMIN') ||
    (hasRole(user, 'ACADEMIC_ADMIN') && (visibility.all || isContentScopeReadable(visibility, doc.academicScope || {})));
  if (!isOwner && !isPrivilegedAdmin) {
    throw new ContentLibraryError(403, 'You can only manage your own resources, or resources within your delegated academic scope.', 'NOT_AUTHORIZED');
  }
  return { doc, isPrivilegedAdmin };
};

export const listLibraryResources = async (user, { search, resourceType, visibility: visibilityFilter, approvalStatus, parentResourceId, scope } = {}) => {
  const visibility = await resolveContentLibraryVisibility(user);
  const filter = { tenantId: visibility.tenantId };
  if (resourceType) filter.resourceType = resourceType;
  if (approvalStatus) filter.approvalStatus = approvalStatus;
  // Explicit 'root' means "top-level only" (no parent); omitted means "any level".
  if (parentResourceId === 'root') filter.parentResourceId = null;
  else if (parentResourceId) filter.parentResourceId = parentResourceId;
  if (visibilityFilter) filter.visibility = visibilityFilter;
  if (search) {
    const re = new RegExp(escapeRegExp(search), 'i');
    filter.$or = [
      { title: re }, { description: re }, { topic: re }, { chapter: re },
      { unit: re }, { tags: re }, { 'metadata.author': re },
    ];
  }
  if (scope === 'mine') {
    filter.createdBy = user._id;
  } else if (!visibility.all) {
    filter.$and = [...(filter.$and || []), { $or: [{ createdBy: user._id }, { visibility: { $ne: 'PRIVATE' } }] }];
  }

  const docs = await LibraryResource.find(filter)
    .sort({ createdAt: -1 })
    .limit(500)
    .populate('createdBy', 'name email')
    .lean();

  const readable = visibility.all || scope === 'mine'
    ? docs
    : docs.filter((doc) => {
        if (String(doc.createdBy?._id || doc.createdBy || '') === String(user._id)) return true;
        if (doc.visibility === 'PRIVATE') return false;
        return isContentScopeReadable(visibility, doc.academicScope || {});
      });

  if (!readable.length) return readable;
  return enrichResourcesWithCounts(readable);
};

export const getLibraryResourceDetail = async (user, resourceId) => {
  const doc = await getLibraryResourceForRead(user, resourceId);
  const [sources, childResources] = await Promise.all([
    ContextSource.find({ tenantId: doc.tenantId, libraryResourceId: doc._id })
      .select('sourceType originalFilename sourceUrl status failureReason errorCode chunkCount extractedCharCount originalObject createdBy createdAt')
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name email')
      .lean(),
    LibraryResource.find({ tenantId: doc.tenantId, parentResourceId: doc._id })
      .select('title resourceType approvalStatus visibility createdAt')
      .sort({ createdAt: -1 })
      .lean(),
  ]);
  return {
    ...doc,
    sources,
    childResources,
    sourceCount: sources.length,
    childResourceCount: childResources.length,
    aiReadiness: computeResourceAiReadiness(sources),
  };
};

export const updateLibraryResource = async (user, resourceId, updates = {}) => {
  const { doc, isPrivilegedAdmin } = await getLibraryResourceForWrite(user, resourceId);
  const resolved = await resolveResourceFields(user, {
    title: updates.title ?? doc.title,
    description: updates.description ?? doc.description,
    resourceType: updates.resourceType ?? doc.resourceType,
    parentResourceId: updates.parentResourceId ?? doc.parentResourceId,
    academicScope: updates.academicScope ?? doc.academicScope,
    chapter: updates.chapter ?? doc.chapter,
    unit: updates.unit ?? doc.unit,
    topic: updates.topic ?? doc.topic,
    tags: updates.tags ?? doc.tags,
    visibility: updates.visibility ?? doc.visibility,
    metadata: updates.metadata ?? doc.metadata,
  });
  Object.assign(doc, resolved);
  if (updates.approvalStatus && updates.approvalStatus !== doc.approvalStatus) {
    if (updates.approvalStatus === 'APPROVED') {
      // Only an Academic/Tenant Admin may move a resource to APPROVED
      // (Part N: an approval workflow, not self-certification).
      if (!isPrivilegedAdmin) {
        throw new ContentLibraryError(403, 'Only an Academic Admin or Tenant Admin can approve a resource.', 'APPROVAL_NOT_ALLOWED');
      }
      doc.approvedBy = user._id;
      doc.approvedAt = new Date();
    }
    if (['DRAFT', 'READY', 'ARCHIVED'].includes(updates.approvalStatus)) {
      doc.approvalStatus = updates.approvalStatus;
      if (updates.approvalStatus !== 'APPROVED') {
        doc.approvedBy = null;
        doc.approvedAt = null;
      }
    } else if (updates.approvalStatus === 'APPROVED') {
      doc.approvalStatus = 'APPROVED';
    }
  }
  await doc.save();
  return doc;
};

export const deleteLibraryResource = async (user, resourceId) => {
  const { doc } = await getLibraryResourceForWrite(user, resourceId);
  const [linkedSourceCount, childCount] = await Promise.all([
    ContextSource.countDocuments({ tenantId: doc.tenantId, libraryResourceId: doc._id }),
    LibraryResource.countDocuments({ tenantId: doc.tenantId, parentResourceId: doc._id }),
  ]);
  if (linkedSourceCount > 0 || childCount > 0) {
    throw new ContentLibraryError(
      400,
      'This resource still has linked files/URLs or chapters. Remove or move those first.',
      'RESOURCE_NOT_EMPTY'
    );
  }
  await LibraryResource.deleteOne({ _id: doc._id });
  return { deleted: true };
};

// Attaches a new file to an existing LibraryResource — thin wrapper over
// contentLibraryService.js's upload, adding only ownership/write-access
// verification for the target resource before delegating storage/
// ingestion entirely to the already-shipped, already-tested function.
export const addFileToLibraryResource = async (user, resourceId, uploadFields) => {
  const { doc } = await getLibraryResourceForWrite(user, resourceId);
  const source = await uploadContentLibraryFile(user, {
    ...uploadFields,
    // ContextSource predates LibraryResource and uses SHARED for the same
    // logical visibility named ACADEMIC_SHARED above. Keep the legacy enum
    // at the technical asset layer while the parent resource remains the
    // authorization source of truth.
    visibility: uploadFields.visibility ?? (doc.visibility === 'ACADEMIC_SHARED' ? 'SHARED' : doc.visibility),
    academicScope: uploadFields.academicScope ?? doc.academicScope,
    chapter: uploadFields.chapter ?? doc.chapter,
    unit: uploadFields.unit ?? doc.unit,
    topic: uploadFields.topic ?? doc.topic,
    libraryResourceId: doc._id,
  });
  return source;
};

export const addUrlToLibraryResource = async (user, resourceId, uploadFields) => {
  const { doc } = await getLibraryResourceForWrite(user, resourceId);
  const source = await uploadContentLibraryUrl(user, {
    ...uploadFields,
    visibility: uploadFields.visibility ?? (doc.visibility === 'ACADEMIC_SHARED' ? 'SHARED' : doc.visibility),
    academicScope: uploadFields.academicScope ?? doc.academicScope,
    chapter: uploadFields.chapter ?? doc.chapter,
    unit: uploadFields.unit ?? doc.unit,
    topic: uploadFields.topic ?? doc.topic,
    libraryResourceId: doc._id,
  });
  return source;
};

// Aggregated AI readiness across all ContextSource assets under a resource.
// STORED_ONLY = files exist but none are AI-indexed; distinct from UNSUPPORTED.
export const computeResourceAiReadiness = (sources = []) => {
  if (!sources.length) return 'STORED_ONLY';
  const statuses = sources.map((source) => String(source.status || '').toUpperCase());
  const stages = sources.map((source) => String(source.processingStage || '').toUpperCase());
  if (statuses.some((status) => status === 'STALE') || stages.some((stage) => stage === 'STALE')) return 'STALE';
  if (stages.some((stage) => stage === 'INDEXING')) return 'INDEXING';
  if (statuses.some((status) => status === 'PROCESSING' || status === 'PENDING') || stages.some((stage) => ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EMBEDDING', 'INDEXING'].includes(stage))) return 'PROCESSING';
  if (statuses.every((status) => status === 'UNSUPPORTED_FOR_AI')) return 'UNSUPPORTED';
  if (statuses.some((status) => status === 'FAILED') && !statuses.some((status) => status === 'READY')) return 'FAILED';
  if (statuses.some((status) => status === 'READY')) return 'READY';
  return 'STORED_ONLY';
};

const enrichResourcesWithCounts = async (resources) => {
  if (!resources.length) return resources;
  const resourceIds = resources.map((doc) => doc._id);
  const [counts, childCounts, sourceStatuses] = await Promise.all([
    ContextSource.aggregate([
      { $match: { libraryResourceId: { $in: resourceIds } } },
      { $group: { _id: '$libraryResourceId', count: { $sum: 1 } } },
    ]),
    LibraryResource.aggregate([
      { $match: { parentResourceId: { $in: resourceIds } } },
      { $group: { _id: '$parentResourceId', count: { $sum: 1 } } },
    ]),
    ContextSource.find({ libraryResourceId: { $in: resourceIds } })
      .select('libraryResourceId status processingStage failureReason errorCode')
      .lean(),
  ]);
  const countByResource = new Map(counts.map((row) => [String(row._id), row.count]));
  const childCountByResource = new Map(childCounts.map((row) => [String(row._id), row.count]));
  const sourcesByResource = new Map();
  sourceStatuses.forEach((source) => {
    const key = String(source.libraryResourceId);
    if (!sourcesByResource.has(key)) sourcesByResource.set(key, []);
    sourcesByResource.get(key).push(source);
  });
  return resources.map((doc) => {
    const sources = sourcesByResource.get(String(doc._id)) || [];
    const failedSource = sources.find((source) => String(source.status).toUpperCase() === 'FAILED');
    return {
      ...doc,
      sourceCount: countByResource.get(String(doc._id)) || 0,
      childResourceCount: childCountByResource.get(String(doc._id)) || 0,
      aiReadiness: computeResourceAiReadiness(sources),
      failureReason: failedSource?.failureReason || failedSource?.errorCode || '',
    };
  });
};

// Resolve educator-selected LibraryResource IDs into authorized, READY
// ContextSource IDs for source-grounded generation (Part 7).
export const resolveLibraryResourcesToContextSourceIds = async (user, resourceIds = []) => {
  const normalizedIds = [...new Set((resourceIds || []).map(String).filter(Boolean))];
  if (!normalizedIds.length) return [];
  const visibility = await resolveContentLibraryVisibility(user);
  const resources = await LibraryResource.find({ _id: { $in: normalizedIds }, tenantId: visibility.tenantId }).lean();
  if (resources.length !== normalizedIds.length) {
    throw new ContentLibraryError(403, 'One or more selected library resources are unavailable or do not belong to this tenant.', 'RESOURCE_NOT_FOUND');
  }
  for (const resource of resources) {
    const isOwner = String(resource.createdBy) === String(user._id);
    if (!visibility.all && !isOwner) {
      if (resource.visibility === 'PRIVATE' || !isContentScopeReadable(visibility, resource.academicScope || {})) {
        throw new ContentLibraryError(403, 'One or more selected library resources are outside your authorized academic scope.', 'SCOPE_NOT_AUTHORIZED');
      }
    }
  }
  const sources = await ContextSource.find({
    tenantId: visibility.tenantId,
    libraryResourceId: { $in: normalizedIds },
    status: 'READY',
  }).select('createdBy isLibraryItem visibility academicScope libraryResourceId').lean();
  if (!sources.length) {
    throw new ContentLibraryError(400, 'Selected library resources have no AI-ready source material yet.', 'NO_READY_SOURCES');
  }
  // Parent LibraryResource authorization above is authoritative for these
  // sources. Do not re-apply ContextSource's legacy visibility field here:
  // older attached sources may still say PRIVATE even though their logical
  // resource is institution-shared.
  return sources.map((source) => source._id);
};

export { RESOURCE_TYPES, VISIBILITIES };
