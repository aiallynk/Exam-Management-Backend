import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { logError } from '../../utils/logger.js';

export const JOB_TYPES = Object.freeze({
  CONTENT_INGESTION: 'CONTENT_INGESTION',
  CONTENT_INDEXING: 'CONTENT_INDEXING',
  CONTENT_EMBEDDING: 'CONTENT_EMBEDDING',
  QUESTION_MEMORY_INDEX: 'QUESTION_MEMORY_INDEX',
  QUESTION_EMBEDDING: 'QUESTION_EMBEDDING',
  GUIDELINE_INGESTION: 'GUIDELINE_INGESTION',
  GUIDELINE_INTERPRETATION: 'GUIDELINE_INTERPRETATION',
  ANSWER_SCRIPT_INGESTION: 'ANSWER_SCRIPT_INGESTION',
  ANSWER_SCRIPT_VISION: 'ANSWER_SCRIPT_VISION',
  ANSWER_SCRIPT_MAPPING: 'ANSWER_SCRIPT_MAPPING',
  ANSWER_SCRIPT_EVALUATION: 'ANSWER_SCRIPT_EVALUATION',
  EVALUATED_PDF_GENERATION: 'EVALUATED_PDF_GENERATION',
});

export const QUEUE_MODE = Object.freeze({
  DURABLE_QUEUE: 'DURABLE_QUEUE',
  IN_PROCESS_FALLBACK: 'IN_PROCESS_FALLBACK',
  UNAVAILABLE: 'UNAVAILABLE',
});

const QUEUE_NAME = 'xamigo-knowledge-jobs';
const inProcessJobs = new Map();
let connection = null;
let queue = null;

const getRedisUrl = () => String(process.env.REDIS_URL || '').trim();

export const getQueueMode = () => {
  if (getRedisUrl()) return QUEUE_MODE.DURABLE_QUEUE;
  if (process.env.NODE_ENV === 'production') return QUEUE_MODE.UNAVAILABLE;
  return QUEUE_MODE.IN_PROCESS_FALLBACK;
};

const getConnection = () => {
  if (!connection) {
    const redisUrl = getRedisUrl();
    if (!redisUrl) return null;
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  }
  return connection;
};

const getQueue = () => {
  if (!queue) {
    const conn = getConnection();
    if (!conn) return null;
    queue = new Queue(QUEUE_NAME, {
      connection: conn,
      prefix: process.env.JOB_QUEUE_PREFIX || 'xamigo',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }
  return queue;
};

const buildJobRecord = ({ jobId, jobType, tenantId, correlationId, status, progress = 0, result = null, error = null }) => ({
  jobId,
  jobType,
  tenantId: tenantId ? String(tenantId) : null,
  correlationId: correlationId || jobId,
  status,
  progress,
  result,
  error,
  updatedAt: new Date().toISOString(),
});

export const dispatchJob = async ({ jobType, tenantId, correlationId, payload = {}, handler }) => {
  const mode = getQueueMode();
  const jobId = `${jobType}:${correlationId || Date.now()}`;

  if (mode === QUEUE_MODE.DURABLE_QUEUE) {
    const q = getQueue();
    if (!q) throw new Error('Durable job queue is not available.');
    await q.add(jobType, { tenantId, correlationId, payload }, { jobId });
    inProcessJobs.set(jobId, buildJobRecord({ jobId, jobType, tenantId, correlationId, status: 'QUEUED' }));
    return { jobId, mode, status: 'QUEUED' };
  }

  if (mode === QUEUE_MODE.UNAVAILABLE) {
    throw new Error('Durable job processing is required in production but Redis is not configured.');
  }

  inProcessJobs.set(jobId, buildJobRecord({ jobId, jobType, tenantId, correlationId, status: 'PROCESSING', progress: 0 }));
  setImmediate(async () => {
    try {
      const result = await handler(payload);
      inProcessJobs.set(jobId, buildJobRecord({ jobId, jobType, tenantId, correlationId, status: 'COMPLETED', progress: 100, result }));
    } catch (error) {
      logError(error, { context: 'jobDispatcherService.inProcess', jobType, jobId, tenantId });
      inProcessJobs.set(jobId, buildJobRecord({ jobId, jobType, tenantId, correlationId, status: 'FAILED', error: error.message }));
    }
  });
  return { jobId, mode, status: 'PROCESSING' };
};

export const getJobStatus = (jobId) => inProcessJobs.get(jobId) || null;

export const closeJobDispatcher = async () => {
  if (queue) await queue.close();
  if (connection) await connection.quit();
  queue = null;
  connection = null;
};
