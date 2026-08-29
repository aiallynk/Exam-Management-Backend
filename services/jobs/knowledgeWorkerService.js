import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAME, getQueueMode, QUEUE_MODE } from './jobDispatcherService.js';
import { executeKnowledgeJob } from './knowledgeJobHandlers.js';
import { saveJobStatus } from './jobStatusService.js';
import { isNonRetryableJobError } from './jobErrors.js';
import { logError } from '../../utils/logger.js';

const WORKER_HEARTBEAT_KEY = 'xamigo:knowledge-worker:heartbeat';
const HEARTBEAT_INTERVAL_MS = 15000;

let heartbeatTimer = null;
let heartbeatRedis = null;

const touchHeartbeat = async () => {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) return;
  if (!heartbeatRedis) heartbeatRedis = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  await heartbeatRedis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 60);
};

export const getWorkerHeartbeat = async () => {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) return { status: 'UNAVAILABLE', reason: 'REDIS_URL not configured' };
  const client = heartbeatRedis || new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const value = await client.get(WORKER_HEARTBEAT_KEY);
  if (!value) return { status: 'STALE', lastSeenAt: null };
  const ageMs = Date.now() - new Date(value).getTime();
  if (ageMs > 45000) return { status: 'STALE', lastSeenAt: value };
  return { status: 'HEALTHY', lastSeenAt: value };
};

export const createKnowledgeWorker = () => {
  const mode = getQueueMode();
  if (mode !== QUEUE_MODE.DURABLE_QUEUE) {
    throw new Error('Knowledge worker requires REDIS_URL and DURABLE_QUEUE mode.');
  }
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const jobId = job.id;
      const jobType = job.name;
      const { tenantId, correlationId, payload } = job.data || {};
      await saveJobStatus(jobId, {
        jobType,
        tenantId,
        correlationId,
        status: 'PROCESSING',
        progress: 0,
        attemptsMade: job.attemptsMade,
      });
      try {
        const result = await executeKnowledgeJob(jobType, { tenantId, correlationId, payload, job });
        await saveJobStatus(jobId, {
          jobType,
          tenantId,
          correlationId,
          status: 'COMPLETED',
          progress: 100,
          result,
          attemptsMade: job.attemptsMade,
        });
        return result;
      } catch (error) {
        await saveJobStatus(jobId, {
          jobType,
          tenantId,
          correlationId,
          status: 'FAILED',
          error: error.message,
          code: error.code || null,
          attemptsMade: job.attemptsMade,
        });
        if (isNonRetryableJobError(error)) throw error;
        throw error;
      }
    },
    {
      connection,
      prefix: process.env.JOB_QUEUE_PREFIX || 'xamigo',
      concurrency: Number(process.env.KNOWLEDGE_WORKER_CONCURRENCY || 2),
    }
  );

  worker.on('failed', (job, error) => {
    logError(error, { context: 'knowledgeWorker.failed', jobId: job?.id, jobType: job?.name });
  });

  heartbeatTimer = setInterval(() => {
    touchHeartbeat().catch((error) => logError(error, { context: 'knowledgeWorker.heartbeat' }));
  }, HEARTBEAT_INTERVAL_MS);
  void touchHeartbeat();

  return worker;
};

export const stopKnowledgeWorker = async (worker) => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (worker) await worker.close();
  if (heartbeatRedis) await heartbeatRedis.quit();
  heartbeatRedis = null;
};
