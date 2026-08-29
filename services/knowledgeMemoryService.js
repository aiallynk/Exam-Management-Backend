import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import LibraryResource from '../models/LibraryResource.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { reprocessContentLibrarySource } from './contentLibraryService.js';
import { dispatchJob, JOB_TYPES } from './jobs/jobDispatcherService.js';
import { logError } from '../utils/logger.js';

const isAiIndexingEnabled = async (tenantId) => {
  const feature = await resolveTenantFeature(tenantId, 'AI_CONTENT_INDEXING');
  return feature?.effectiveEnabled === true;
};

const runSourceIndexing = async ({ tenantId, userId, sourceId }) => {
  const source = await ContextSource.findOne({ _id: sourceId, tenantId });
  if (!source) return { status: 'NOT_FOUND' };
  if (!(await isAiIndexingEnabled(tenantId))) {
    return { status: 'STORED_ONLY', reason: 'AI_CONTENT_INDEXING is not enabled for this tenant.' };
  }
  const user = { _id: userId, tenantId };
  await reprocessContentLibrarySource(user, sourceId);
  const refreshed = await ContextSource.findById(sourceId).lean();
  return { status: refreshed?.status || 'UNKNOWN', sourceId, chunkCount: refreshed?.chunkCount || 0 };
};

export const ingestLibraryResource = async ({ tenantId, userId, resourceId, sourceId }) => {
  const handler = async () => runSourceIndexing({ tenantId, userId, sourceId });
  if (sourceId) {
    return dispatchJob({
      jobType: JOB_TYPES.CONTENT_INDEXING,
      tenantId,
      correlationId: String(sourceId),
      payload: { tenantId, userId, sourceId },
      handler,
    });
  }
  const sources = await ContextSource.find({ tenantId, libraryResourceId: resourceId }).select('_id').lean();
  const jobs = [];
  for (const source of sources) {
    jobs.push(await ingestLibraryResource({ tenantId, userId, resourceId, sourceId: source._id }));
  }
  return { resourceId, jobs };
};

export const refreshLibraryResource = async ({ tenantId, userId, resourceId }) =>
  ingestLibraryResource({ tenantId, userId, resourceId });

export const removeLibraryResourceFromIndex = async ({ tenantId, resourceId }) => {
  const sources = await ContextSource.find({ tenantId, libraryResourceId: resourceId }).select('_id').lean();
  const sourceIds = sources.map((s) => s._id);
  if (sourceIds.length) {
    await ContextChunk.deleteMany({ tenantId, sourceId: { $in: sourceIds } });
    await ContextSource.updateMany(
      { _id: { $in: sourceIds }, tenantId },
      { $set: { status: 'PENDING', chunkCount: 0, extractedCharCount: 0, processedAt: null } }
    );
  }
  return { resourceId, clearedSources: sourceIds.length };
};

export const searchKnowledge = async ({ tenantId, sourceIds, queryEmbedding, topK, retrieveFn }) => {
  if (!tenantId || !Array.isArray(sourceIds) || !sourceIds.length) return [];
  return retrieveFn({ tenantId, sourceIds, queryEmbedding, topK });
};

export const onLibraryAssetUploaded = async ({ tenantId, userId, resourceId, sourceId }) => {
  try {
    if (!(await isAiIndexingEnabled(tenantId))) {
      return { triggered: false, reason: 'AI_CONTENT_INDEXING disabled' };
    }
    return ingestLibraryResource({ tenantId, userId, resourceId, sourceId });
  } catch (error) {
    logError(error, { context: 'knowledgeMemoryService.onLibraryAssetUploaded', tenantId, resourceId, sourceId });
    return { triggered: false, error: error.message };
  }
};

export const listEligibleAutoContextResources = async ({ tenantId, user, academicScope = {}, topic = '', courseId = null }) => {
  const visibility = user?.visibilityRecord;
  const filter = {
    tenantId,
    approvalStatus: { $in: ['READY', 'APPROVED'] },
    visibility: { $ne: 'PRIVATE' },
  };
  if (courseId) filter['academicScope.courseId'] = String(courseId);
  const resources = await LibraryResource.find(filter).select('title resourceType academicScope topic chapter visibility createdBy').lean();
  return resources.filter((resource) => {
    if (String(resource.createdBy) === String(user?._id)) return true;
    if (resource.visibility === 'PRIVATE') return false;
    if (topic && resource.topic && !String(resource.topic).toLowerCase().includes(String(topic).toLowerCase())) {
      return false;
    }
    return true;
  });
};
