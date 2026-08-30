import IORedis from 'ioredis';
import { Worker, DelayedError } from 'bullmq';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';
import { ANSWER_SCRIPT_QUEUE } from './answerScriptQueueService.js';
import { executeAnswerScriptJob, markAnswerScriptJobPermanentlyFailed } from './answerScriptJobHandlers.js';
import { logError } from '../../utils/logger.js';
import AnswerScript from '../../models/AnswerScript.js';

const PREFIX = process.env.JOB_QUEUE_PREFIX || 'xamigo';
const PERMIT_TTL_MS = Math.max(offlineEvaluationConfig.STALE_AFTER_MS, 60_000);
const HEARTBEAT_TTL_SECONDS = 60;
const workers = [];
let redis;
let heartbeatTimer;
let staleSweepTimer;

const acquireScript = `
local tenant = tonumber(redis.call('GET', KEYS[1]) or '0')
local uploader = tonumber(redis.call('GET', KEYS[2]) or '0')
if tenant >= tonumber(ARGV[1]) or uploader >= tonumber(ARGV[2]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`;

const releaseScript = `
for index = 1, 2 do
  local current = tonumber(redis.call('GET', KEYS[index]) or '0')
  if current <= 1 then redis.call('DEL', KEYS[index]) else redis.call('DECR', KEYS[index]) end
end
return 1
`;

const permitKeys = (job, resourceClass) => [
  `${PREFIX}:answer-script:permit:${resourceClass}:tenant:${job.data.tenantId}`,
  `${PREFIX}:answer-script:permit:${resourceClass}:uploader:${job.data.tenantId}:${job.data.uploaderId}`,
];

const acquirePermit = async (job, resourceClass) => Number(await redis.eval(
  acquireScript,
  2,
  ...permitKeys(job, resourceClass),
  offlineEvaluationConfig.MAX_ACTIVE_PER_TENANT,
  offlineEvaluationConfig.MAX_ACTIVE_PER_UPLOADER,
  PERMIT_TTL_MS,
)) === 1;

const releasePermit = async (job, resourceClass) => redis.eval(releaseScript, 2, ...permitKeys(job, resourceClass));

const createWorker = ({ queueName, resourceClass, concurrency, limiter }) => {
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const worker = new Worker(
    queueName,
    async (job, token) => {
      const acquired = await acquirePermit(job, resourceClass);
      if (!acquired) {
        // Put the job back without consuming an attempt. This makes another
        // uploader's waiting job eligible instead of holding a worker slot.
        await job.moveToDelayed(Date.now() + 750 + Math.floor(Math.random() * 500), token);
        throw new DelayedError();
      }
      try {
        return await executeAnswerScriptJob(job);
      } finally {
        await releasePermit(job, resourceClass).catch((error) => logError(error, { context: 'answerScriptWorker.releasePermit', jobId: job.id }));
      }
    },
    {
      connection,
      prefix: PREFIX,
      concurrency,
      ...(limiter ? { limiter } : {}),
    },
  );
  worker.on('failed', async (job, error) => {
    if (error instanceof DelayedError) return;
    logError(error, { context: 'answerScriptWorker.failed', queueName, jobId: job?.id, stage: job?.name });
    const attempts = Number(job?.opts?.attempts || 1);
    if (Number(job?.attemptsMade || 0) >= attempts) await markAnswerScriptJobPermanentlyFailed(job, error);
  });
  workers.push(worker);
  return worker;
};

const touchHeartbeat = async () => {
  await redis.set(`${PREFIX}:answer-script-worker:heartbeat`, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
};

export const startAnswerScriptWorkers = () => {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for answer-script workers.');
  if (workers.length) return workers;
  redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  createWorker({
    queueName: ANSWER_SCRIPT_QUEUE.DOCUMENT,
    resourceClass: 'document',
    concurrency: offlineEvaluationConfig.DOCUMENT_CONCURRENCY,
  });
  createWorker({
    queueName: ANSWER_SCRIPT_QUEUE.AI,
    resourceClass: 'ai',
    concurrency: offlineEvaluationConfig.AI_CONCURRENCY,
    limiter: { max: offlineEvaluationConfig.PROVIDER_REQUESTS_PER_MINUTE, duration: 60_000 },
  });
  createWorker({
    queueName: ANSWER_SCRIPT_QUEUE.RENDER,
    resourceClass: 'render',
    concurrency: offlineEvaluationConfig.RENDER_CONCURRENCY,
  });
  heartbeatTimer = setInterval(() => void touchHeartbeat().catch((error) => logError(error, { context: 'answerScriptWorker.heartbeat' })), 15_000);
  staleSweepTimer = setInterval(() => {
    const staleBefore = new Date(Date.now() - offlineEvaluationConfig.STALE_AFTER_MS);
    void AnswerScript.updateMany(
      {
        status: { $in: ['NORMALIZING', 'IDENTIFYING_CANDIDATE', 'EXTRACTING', 'SEGMENTING', 'EVALUATING', 'FINALIZING'] },
        'processingMeta.heartbeatAt': { $lt: staleBefore },
      },
      { $set: { status: 'STALE', statusReason: 'Worker heartbeat expired. Retry resumes from the persisted stage checkpoint.' } },
    ).catch((error) => logError(error, { context: 'answerScriptWorker.staleSweep' }));
  }, 60_000);
  void touchHeartbeat();
  return workers;
};

export const getAnswerScriptWorkerHeartbeat = async () => {
  if (!process.env.REDIS_URL) return { status: 'UNAVAILABLE', lastSeenAt: null };
  const client = redis || new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const value = await client.get(`${PREFIX}:answer-script-worker:heartbeat`);
  if (!redis) await client.quit();
  if (!value) return { status: 'STALE', lastSeenAt: null };
  return { status: Date.now() - new Date(value).getTime() <= 45_000 ? 'HEALTHY' : 'STALE', lastSeenAt: value };
};

export const stopAnswerScriptWorkers = async () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (staleSweepTimer) clearInterval(staleSweepTimer);
  staleSweepTimer = null;
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  if (redis) await redis.quit();
  redis = null;
};
