import IORedis from 'ioredis';
import { logError } from '../../utils/logger.js';

const JOB_STATUS_PREFIX = 'xamigo:job:status:';
const JOB_STATUS_TTL_SECONDS = 60 * 60 * 24 * 7;

let redis = null;

const getRedis = () => {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) return null;
  if (!redis) redis = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  return redis;
};

const fallbackStore = new Map();

export const saveJobStatus = async (jobId, record) => {
  const payload = { ...record, jobId, updatedAt: new Date().toISOString() };
  const client = getRedis();
  if (client) {
    try {
      await client.set(`${JOB_STATUS_PREFIX}${jobId}`, JSON.stringify(payload), 'EX', JOB_STATUS_TTL_SECONDS);
      return payload;
    } catch (error) {
      logError(error, { context: 'jobStatusService.save.redis', jobId });
    }
  }
  fallbackStore.set(jobId, payload);
  return payload;
};

export const getJobStatusRecord = async (jobId) => {
  const client = getRedis();
  if (client) {
    try {
      const raw = await client.get(`${JOB_STATUS_PREFIX}${jobId}`);
      if (raw) return JSON.parse(raw);
    } catch (error) {
      logError(error, { context: 'jobStatusService.get.redis', jobId });
    }
  }
  return fallbackStore.get(jobId) || null;
};

export const updateJobProgress = async (jobId, patch = {}) => {
  const current = (await getJobStatusRecord(jobId)) || { jobId };
  return saveJobStatus(jobId, { ...current, ...patch });
};
