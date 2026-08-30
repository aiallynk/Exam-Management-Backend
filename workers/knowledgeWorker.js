import { connect } from '../utils/db.js';
import { bootstrapAiConfig } from '../services/aiEngine/aiConfigService.js';
import { createKnowledgeWorker, stopKnowledgeWorker } from '../services/jobs/knowledgeWorkerService.js';
import { getQueueMode, QUEUE_MODE } from '../services/jobs/jobDispatcherService.js';

const start = async () => {
  const mode = getQueueMode();
  if (mode !== QUEUE_MODE.DURABLE_QUEUE) {
    console.error('[knowledge-worker] REDIS_URL is required. Current mode:', mode);
    process.exit(1);
  }
  await connect();
  await bootstrapAiConfig();
  const worker = createKnowledgeWorker();
  const stop = async () => {
    await stopKnowledgeWorker(worker);
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log('[knowledge-worker] started');
};

start().catch((error) => {
  console.error('[knowledge-worker] failed to start:', error.message || error);
  process.exit(1);
});
