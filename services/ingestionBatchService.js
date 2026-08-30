import KnowledgeIngestionBatch from '../models/KnowledgeIngestionBatch.js';
import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import { dispatchJob, JOB_TYPES, getQueueMode, QUEUE_MODE } from './jobs/jobDispatcherService.js';

export const createIngestionBatch = async ({ tenantId, userId, resourceIds = [], sourceIds = [], priority = 'FAST' }) => {
  const total = Math.max(sourceIds.length, resourceIds.length);
  return KnowledgeIngestionBatch.create({
    tenantId,
    createdBy: userId,
    resourceIds,
    sourceIds,
    total,
    queued: total,
    status: 'QUEUED',
    priority,
  });
};

export const refreshBatchCounters = async (batchId) => {
  const batch = await KnowledgeIngestionBatch.findById(batchId);
  if (!batch) return null;

  const sources = await ContextSource.find({ _id: { $in: batch.sourceIds } }).select('status processingStage').lean();
  let ready = 0;
  let failed = 0;
  let processing = 0;
  let storedOnly = 0;
  let queued = 0;

  sources.forEach((source) => {
    const status = String(source.status || '').toUpperCase();
    const stage = String(source.processingStage || '').toUpperCase();
    if (status === 'READY' || stage === 'AI_READY') ready += 1;
    else if (status === 'FAILED' || stage === 'FAILED') failed += 1;
    else if (status === 'STORED_ONLY' || stage === 'STORED_ONLY') storedOnly += 1;
    else if (status === 'PENDING' || stage === 'QUEUED') queued += 1;
    else processing += 1;
  });

  batch.ready = ready;
  batch.failed = failed;
  batch.processing = processing;
  batch.storedOnly = storedOnly;
  batch.queued = queued;
  if (failed && ready) batch.status = 'PARTIAL';
  else if (failed && !ready) batch.status = 'FAILED';
  else if (ready + storedOnly >= batch.total) batch.status = 'COMPLETED';
  else batch.status = processing ? 'PROCESSING' : 'QUEUED';
  await batch.save();
  return batch;
};

export const attachSourceToBatch = async ({ batchId, sourceId }) => {
  if (!batchId) return null;
  await KnowledgeIngestionBatch.updateOne(
    { _id: batchId },
    { $addToSet: { sourceIds: sourceId }, $inc: { total: 0 } }
  );
  return refreshBatchCounters(batchId);
};

export const cloneEmbeddingsFromDuplicateSource = async ({ tenantId, targetSourceId, priorSourceId }) => {
  const priorChunks = await ContextChunk.find({ tenantId, sourceId: priorSourceId }).sort({ chunkIndex: 1 }).lean();
  if (!priorChunks.length) return 0;
  const docs = priorChunks.map((chunk) => ({
    tenantId,
    contextSetId: null,
    sourceId: targetSourceId,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    charCount: chunk.charCount,
    contentHash: chunk.contentHash,
    sectionTitle: chunk.sectionTitle || '',
    sectionLevel: chunk.sectionLevel || 'CHUNK',
    embedding: chunk.embedding,
    embeddingModel: chunk.embeddingModel,
  }));
  await ContextChunk.insertMany(docs, { ordered: true });
  return docs.length;
};

export const findReusableSourceByHash = async ({ tenantId, fileContentHash }) => {
  if (!fileContentHash) return null;
  return ContextSource.findOne({
    tenantId,
    fileContentHash,
    status: 'READY',
    chunkCount: { $gt: 0 },
  }).sort({ processedAt: -1 }).lean();
};

export const enqueueContentIndexing = async ({ tenantId, userId, sourceId, resourceId, batchId = null }) => {
  const mode = getQueueMode();
  if (mode === QUEUE_MODE.UNAVAILABLE) {
    await ContextSource.updateOne(
      { _id: sourceId, tenantId },
      { $set: { status: 'PENDING', processingStage: 'QUEUED', failureReason: 'Worker queue unavailable. Retry when Redis worker is online.' } }
    );
    return { jobId: null, mode, status: 'QUEUED', workerUnavailable: true };
  }

  const job = await dispatchJob({
    jobType: JOB_TYPES.CONTENT_INDEXING,
    tenantId,
    correlationId: String(sourceId),
    payload: { tenantId, userId, sourceId, resourceId, batchId },
  });

  await ContextSource.updateOne(
    { _id: sourceId, tenantId },
    { $set: { processingJobId: job.jobId, processingStage: 'QUEUED', status: 'PENDING', lastHeartbeatAt: new Date() } }
  );

  if (batchId) await attachSourceToBatch({ batchId, sourceId });
  return job;
};
