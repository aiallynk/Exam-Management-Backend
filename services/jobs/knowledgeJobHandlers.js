import ContextSource from '../../models/ContextSource.js';
import ContextChunk from '../../models/ContextChunk.js';
import GuidelineDocument from '../../models/GuidelineDocument.js';
import { JOB_TYPES } from './jobDispatcherService.js';
import { updateJobProgress } from './jobStatusService.js';
import { NonRetryableJobError } from './jobErrors.js';
import { runSourceIndexingPipeline } from '../knowledgeMemoryService.js';
import { interpretGuidelineDocument } from '../guidelineInterpretationService.js';
import { indexQuestionMemory } from '../questionMemoryService.js';
import { logError } from '../../utils/logger.js';

const assertPayload = (payload, fields) => {
  for (const field of fields) {
    if (!payload?.[field]) throw new NonRetryableJobError(`Missing required job payload field: ${field}`, 'INVALID_PAYLOAD');
  }
};

export const executeKnowledgeJob = async (jobType, { tenantId, correlationId, payload = {}, job = null }) => {
  const jobId = job?.id || `${jobType}:${correlationId}`;
  const progress = async (value, message) => updateJobProgress(jobId, { progress: value, progressMessage: message, status: 'PROCESSING' });

  switch (jobType) {
    case JOB_TYPES.CONTENT_INGESTION:
    case JOB_TYPES.CONTENT_INDEXING:
    case JOB_TYPES.CONTENT_EMBEDDING: {
      assertPayload(payload, ['sourceId', 'userId']);
      await progress(10, 'Starting content indexing');
      const result = await runSourceIndexingPipeline({
        tenantId,
        userId: payload.userId,
        sourceId: payload.sourceId,
        resourceId: payload.resourceId || null,
        jobId,
        onProgress: progress,
      });
      return result;
    }
    case JOB_TYPES.GUIDELINE_INGESTION:
    case JOB_TYPES.GUIDELINE_INTERPRETATION: {
      assertPayload(payload, ['guidelineDocumentId', 'userId']);
      await progress(5, 'Reading guideline');
      return interpretGuidelineDocument({
        tenantId,
        userId: payload.userId,
        guidelineDocumentId: payload.guidelineDocumentId,
        onProgress: progress,
      });
    }
    case JOB_TYPES.QUESTION_MEMORY_INDEX:
    case JOB_TYPES.QUESTION_EMBEDDING: {
      assertPayload(payload, ['questionId', 'questionText']);
      await progress(20, 'Indexing question memory');
      return indexQuestionMemory({
        tenantId,
        userId: payload.userId || null,
        questionId: payload.questionId,
        questionVersionId: payload.questionVersionId || null,
        questionText: payload.questionText,
        questionType: payload.questionType || null,
        difficulty: payload.difficulty || null,
      });
    }
    default:
      throw new NonRetryableJobError(`Unsupported knowledge job type: ${jobType}`, 'UNSUPPORTED_JOB');
  }
};

export const invalidateSourceIndexVersion = async ({ tenantId, sourceId }) => {
  try {
    await ContextChunk.deleteMany({ tenantId, sourceId });
    await ContextSource.updateOne(
      { _id: sourceId, tenantId },
      { $inc: { indexVersion: 1 }, $set: { status: 'PROCESSING', chunkCount: 0, processedAt: null } }
    );
  } catch (error) {
    logError(error, { context: 'knowledgeJobHandlers.invalidateSourceIndexVersion', tenantId, sourceId });
    throw error;
  }
};
