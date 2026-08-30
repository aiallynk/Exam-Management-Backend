import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import LibraryResource from '../models/LibraryResource.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { isContentScopeReadable } from '../utils/contentScope.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { reprocessContentLibrarySource } from './contentLibraryService.js';
import { dispatchJob, JOB_TYPES } from './jobs/jobDispatcherService.js';
import { enrichContentMetadata } from './contentMetadataEnrichmentService.js';
import { logError } from '../utils/logger.js';

export const isAiIndexingEnabled = async (tenantId) => {
  const feature = await resolveTenantFeature(tenantId, 'AI_CONTENT_INDEXING');
  return feature?.effectiveEnabled === true;
};

export const runSourceIndexingPipeline = async ({ tenantId, userId, sourceId, resourceId = null, jobId = null, onProgress = async () => {} }) => {
  const source = await ContextSource.findOne({ _id: sourceId, tenantId });
  if (!source) return { status: 'NOT_FOUND', sourceId };
  if (!(await isAiIndexingEnabled(tenantId))) {
    return { status: 'STORED_ONLY', reason: 'AI_CONTENT_INDEXING is not enabled for this tenant.' };
  }

  const user = { _id: userId, tenantId };
  const refreshed = await reprocessContentLibrarySource(user, sourceId, { onProgress, jobId });

  if (refreshed?.status === 'READY') {
    await onProgress(85, 'Enriching metadata');
    try {
      await enrichContentMetadata({ tenantId, userId, sourceId, resourceId: resourceId || source.libraryResourceId });
    } catch (error) {
      logError(error, { context: 'knowledgeMemoryService.enrichMetadata', tenantId, sourceId });
    }
  }

  await onProgress(100, 'Indexing complete');
  return {
    status: refreshed?.status || 'UNKNOWN',
    processingStage: refreshed?.processingStage || null,
    sourceId,
    chunkCount: refreshed?.chunkCount || 0,
    resourceId: resourceId || source.libraryResourceId || null,
  };
};

export const ingestLibraryResource = async ({ tenantId, userId, resourceId, sourceId }) => {
  if (sourceId) {
    return dispatchJob({
      jobType: JOB_TYPES.CONTENT_INDEXING,
      tenantId,
      correlationId: String(sourceId),
      payload: { tenantId, userId, sourceId, resourceId },
    });
  }
  const sources = await ContextSource.find({ tenantId, libraryResourceId: resourceId }).select('_id').lean();
  const jobs = [];
  for (const source of sources) {
    jobs.push(await ingestLibraryResource({ tenantId, userId, resourceId, sourceId: source._id }));
  }
  return { resourceId, jobs };
};

export const refreshLibraryResource = async ({ tenantId, userId, resourceId, sourceId }) => {
  if (sourceId) {
    return dispatchJob({
      jobType: JOB_TYPES.CONTENT_INDEXING,
      tenantId,
      correlationId: String(sourceId),
      payload: { tenantId, userId, sourceId, resourceId },
    });
  }
  return ingestLibraryResource({ tenantId, userId, resourceId });
};

export const removeLibraryResourceFromIndex = async ({ tenantId, resourceId, archiveOnly = false }) => {
  const sources = await ContextSource.find({ tenantId, libraryResourceId: resourceId }).select('_id').lean();
  const sourceIds = sources.map((s) => s._id);
  if (sourceIds.length) {
    await ContextChunk.deleteMany({ tenantId, sourceId: { $in: sourceIds } });
    const nextStatus = archiveOnly ? 'READY' : 'PENDING';
    await ContextSource.updateMany(
      { _id: { $in: sourceIds }, tenantId },
      { $set: { status: archiveOnly ? 'READY' : 'PENDING', chunkCount: 0, extractedCharCount: 0, processedAt: null } }
    );
  }
  if (archiveOnly) {
    await LibraryResource.updateOne({ _id: resourceId, tenantId }, { $set: { approvalStatus: 'ARCHIVED' } });
  }
  return { resourceId, clearedSources: sourceIds.length, archiveOnly };
};

export const searchKnowledge = async ({ tenantId, sourceIds, queryEmbedding, topK, retrieveFn }) => {
  if (!tenantId || !Array.isArray(sourceIds) || !sourceIds.length) return [];
  return retrieveFn({ tenantId, sourceIds, queryEmbedding, topK });
};

export const onLibraryAssetUploaded = async ({ tenantId, userId, resourceId, sourceId }) => {
  try {
    if (!(await isAiIndexingEnabled(tenantId))) {
      return { triggered: false, reason: 'AI_CONTENT_INDEXING disabled', status: 'STORED_ONLY' };
    }
    return ingestLibraryResource({ tenantId, userId, resourceId, sourceId });
  } catch (error) {
    logError(error, { context: 'knowledgeMemoryService.onLibraryAssetUploaded', tenantId, resourceId, sourceId });
    return { triggered: false, error: error.message };
  }
};

const SOURCE_AUTHORITY_RANK = {
  CURRICULUM_DOCUMENT: 100,
  SYLLABUS: 95,
  TEXTBOOK: 90,
  BOOK: 88,
  CHAPTER: 85,
  PAST_PAPER: 70,
  MODEL_PAPER: 68,
  TEACHER_NOTES: 60,
  LESSON_MATERIAL: 58,
  WORKSHEET: 55,
  REFERENCE: 50,
  OTHER: 40,
};

export const computeSourceAuthorityRank = (resource = {}) => {
  const typeRank = SOURCE_AUTHORITY_RANK[String(resource.resourceType || '').toUpperCase()] || 30;
  const approvalBoost = resource.approvalStatus === 'APPROVED' ? 20 : resource.approvalStatus === 'READY' ? 10 : 0;
  const visibilityBoost = resource.visibility === 'ACADEMIC_SHARED' ? 15 : resource.visibility === 'COURSE' ? 8 : 0;
  return typeRank + approvalBoost + visibilityBoost;
};

export const listEligibleAutoContextResources = async ({ tenantId, user, academicScope = {}, topic = '', courseId = null, subject = '' }) => {
  const visibility = user?.visibilityRecord || (await resolveAcademicVisibility(user));
  const filter = {
    tenantId,
    approvalStatus: { $in: ['READY', 'APPROVED'] },
  };

  if (courseId) filter['academicScope.courseId'] = String(courseId);

  // Scope-aware DB filter before in-memory eligibility — never tenant-wide fetch + hope.
  if (!visibility.all) {
    const scopeClauses = [];
    if (visibility.user?._id) {
      scopeClauses.push({ createdBy: visibility.user._id });
    }
    const orgIds = visibility.ids?.['organization-units'] || [];
    const courseIds = visibility.ids?.courses || [];
    if (orgIds.length) {
      scopeClauses.push({ 'academicScope.organizationUnitId': { $in: orgIds } });
    }
    if (courseIds.length) {
      scopeClauses.push({ 'academicScope.courseId': { $in: courseIds } });
    }
    scopeClauses.push({ visibility: 'ACADEMIC_SHARED' });
    if (scopeClauses.length) filter.$or = scopeClauses;
    else return [];
  }

  const resources = await LibraryResource.find(filter)
    .select('title resourceType academicScope topic chapter unit visibility createdBy approvalStatus')
    .lean();

  const topicNeedle = String(topic || subject || '').trim().toLowerCase();

  const scored = resources
    .filter((resource) => {
      if (resource.approvalStatus === 'ARCHIVED') return false;
      if (String(resource.createdBy) === String(user?._id)) return true;
      if (resource.visibility === 'PRIVATE') return false;
      if (resource.visibility === 'COURSE') {
        return isContentScopeReadable(visibility, resource.academicScope || {});
      }
      if (resource.visibility === 'ACADEMIC_SHARED') {
        if (!visibility.all && !isContentScopeReadable(visibility, resource.academicScope || {})) return false;
      }
      if (topicNeedle) {
        const haystack = [resource.title, resource.topic, resource.chapter, resource.unit].join(' ').toLowerCase();
        if (!haystack.includes(topicNeedle)) return false;
      }
      return true;
    })
    .map((resource) => ({ resource, authority: computeSourceAuthorityRank(resource) }))
    .sort((a, b) => b.authority - a.authority);

  return scored.map((entry) => entry.resource);
};

export const previewAutoContextResources = async (params) => {
  const resources = await listEligibleAutoContextResources(params);
  return resources.slice(0, 5).map((resource) => ({
    id: resource._id,
    title: resource.title,
    resourceType: resource.resourceType,
    chapter: resource.chapter || null,
    topic: resource.topic || null,
  }));
};
