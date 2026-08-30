import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';
import { QUEUE_MODE, getQueueMode } from '../jobs/jobDispatcherService.js';

export const ANSWER_SCRIPT_JOB = Object.freeze({
  NORMALIZE: 'ANSWER_SCRIPT_NORMALIZE',
  IDENTITY: 'ANSWER_SCRIPT_IDENTITY',
  EXTRACT_PAGE: 'ANSWER_SCRIPT_EXTRACT_PAGE',
  SEGMENT: 'ANSWER_SCRIPT_SEGMENT',
  EVALUATE_SEGMENT: 'ANSWER_SCRIPT_EVALUATE_SEGMENT',
  MATERIALIZE: 'ANSWER_SCRIPT_MATERIALIZE',
  RENDER: 'ANSWER_SCRIPT_RENDER',
});

export const ANSWER_SCRIPT_QUEUE = Object.freeze({
  DOCUMENT: 'xamigo-answer-script-document',
  AI: 'xamigo-answer-script-ai',
  RENDER: 'xamigo-answer-script-render',
});

const queueForStage = (stage) => {
  if ([ANSWER_SCRIPT_JOB.NORMALIZE, ANSWER_SCRIPT_JOB.SEGMENT].includes(stage)) return ANSWER_SCRIPT_QUEUE.DOCUMENT;
  if (stage === ANSWER_SCRIPT_JOB.RENDER) return ANSWER_SCRIPT_QUEUE.RENDER;
  return ANSWER_SCRIPT_QUEUE.AI;
};

let connection;
const queues = new Map();

const redisConnection = () => {
  if (!connection) {
    if (!process.env.REDIS_URL) return null;
    connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  }
  return connection;
};

const getQueue = (name) => {
  if (queues.has(name)) return queues.get(name);
  const redis = redisConnection();
  if (!redis) return null;
  const queue = new Queue(name, {
    connection: redis,
    prefix: process.env.JOB_QUEUE_PREFIX || 'xamigo',
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 2000,
      removeOnFail: 4000,
    },
  });
  queues.set(name, queue);
  return queue;
};

const safeId = (value) => String(value || 'all').replace(/[^a-zA-Z0-9_-]/g, '-');

export const enqueueAnswerScriptStage = async ({
  stage, answerScriptId, tenantId, uploaderId, batchId, scopeId = 'all', version = 1, delay = 0,
}) => {
  if (!Object.values(ANSWER_SCRIPT_JOB).includes(stage)) throw new Error(`Unsupported answer-script stage: ${stage}`);
  const mode = getQueueMode();
  const data = {
    answerScriptId: String(answerScriptId), tenantId: String(tenantId),
    uploaderId: String(uploaderId || 'system'), batchId: batchId ? String(batchId) : null,
    scopeId: String(scopeId || 'all'), version: Number(version || 1),
  };
  const jobId = `as-${safeId(stage)}-${safeId(answerScriptId)}-${safeId(scopeId)}-v${Number(version || 1)}`;
  if (mode === QUEUE_MODE.DURABLE_QUEUE) {
    const queue = getQueue(queueForStage(stage));
    if (!queue) throw Object.assign(new Error('The durable answer-sheet queue is unavailable.'), { statusCode: 503, code: 'ANSWER_SCRIPT_QUEUE_UNAVAILABLE' });
    await queue.add(stage, data, { jobId, delay: Math.max(0, Number(delay || 0)) });
    return { jobId, mode, status: 'QUEUED', queue: queue.name };
  }
  if (mode === QUEUE_MODE.UNAVAILABLE) {
    throw Object.assign(new Error('Redis-backed answer-sheet processing is required in production.'), { statusCode: 503, code: 'ANSWER_SCRIPT_QUEUE_UNAVAILABLE' });
  }
  // Development/test compatibility only. Production can never report a
  // durable queue while running this fallback.
  setImmediate(async () => {
    const { executeAnswerScriptJob, markAnswerScriptJobPermanentlyFailed } = await import('./answerScriptJobHandlers.js');
    const job = { name: stage, id: jobId, data, attemptsMade: 1, opts: { attempts: 1 } };
    try {
      await executeAnswerScriptJob(job);
    } catch (error) {
      await markAnswerScriptJobPermanentlyFailed(job, error);
    }
  });
  return { jobId, mode, status: 'PROCESSING', queue: 'in-process-development-fallback' };
};

export const getAnswerScriptQueueHealth = async () => {
  const mode = getQueueMode();
  if (mode !== QUEUE_MODE.DURABLE_QUEUE) {
    return { mode, status: mode === QUEUE_MODE.UNAVAILABLE ? 'UNAVAILABLE' : 'DEGRADED', queues: {} };
  }
  const entries = await Promise.all(Object.values(ANSWER_SCRIPT_QUEUE).map(async (name) => {
    const counts = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    return [name, counts];
  }));
  return { mode, status: 'HEALTHY', queues: Object.fromEntries(entries) };
};

export const closeAnswerScriptQueues = async () => {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
  if (connection) await connection.quit();
  connection = null;
};

// Pure round-robin reference scheduler used by the capacity benchmark and
// tests. Runtime workers additionally enforce Redis tenant/uploader permits,
// so a burst from one batch is delayed while another uploader can proceed.
export const buildFairSchedule = (jobs, { maxPerTenant = offlineEvaluationConfig.MAX_ACTIVE_PER_TENANT } = {}) => {
  const tenants = new Map();
  for (const job of jobs || []) {
    const tenantId = String(job.tenantId);
    const key = `${job.uploaderId}:${job.batchId || 'none'}`;
    if (!tenants.has(tenantId)) tenants.set(tenantId, { groups: new Map(), ring: [] });
    const tenant = tenants.get(tenantId);
    if (!tenant.groups.has(key)) {
      tenant.groups.set(key, []);
      tenant.ring.push(key);
    }
    tenant.groups.get(key).push(job);
  }
  const result = [];
  while ([...tenants.values()].some((tenant) => tenant.ring.length)) {
    for (const tenant of tenants.values()) {
      const opportunityCount = Math.min(maxPerTenant, tenant.ring.length);
      for (let index = 0; index < opportunityCount; index += 1) {
        const key = tenant.ring.shift();
        const queue = tenant.groups.get(key);
        result.push(queue.shift());
        if (queue.length) tenant.ring.push(key);
        else tenant.groups.delete(key);
      }
    }
  }
  return result;
};
