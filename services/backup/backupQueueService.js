import IORedis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { assertBackupConfiguration, getBackupConfiguration } from './backupConfiguration.js';

export const QUEUES = Object.freeze({ PLATFORM: 'backup-platform', TENANT: 'backup-tenant', INCREMENTAL: 'backup-incremental', VERIFY: 'backup-verification', RETENTION: 'backup-retention', RESTORE_PREVIEW: 'restore-preview', RESTORE_EXECUTION: 'restore-execution', RESTORE_ROLLBACK: 'restore-rollback' });
let connection; const queues = new Map(); const events = new Map();
export const getQueueConnection = () => { if (!connection) { const config = assertBackupConfiguration(); connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false }); } return connection; };
export const getBackupQueue = (name) => { if (!queues.has(name)) { const config = getBackupConfiguration(); queues.set(name, new Queue(name, { connection: getQueueConnection(), prefix: config.queuePrefix, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 } })); } return queues.get(name); };
export const getBackupQueueEvents = (name) => { if (!events.has(name)) { const config = getBackupConfiguration(); events.set(name, new QueueEvents(name, { connection: getQueueConnection(), prefix: config.queuePrefix })); } return events.get(name); };
export const enqueue = async ({ queue, jobName, jobId, data }) => getBackupQueue(queue).add(jobName, data, { jobId });
export const closeBackupQueues = async () => { await Promise.all([...queues.values()].map((queue) => queue.close())); await Promise.all([...events.values()].map((event) => event.close())); if (connection) await connection.quit(); queues.clear(); events.clear(); connection = null; };
