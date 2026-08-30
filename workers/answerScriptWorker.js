import { connect } from '../utils/db.js';
import { bootstrapAiConfig } from '../services/aiEngine/aiConfigService.js';
import { startAnswerScriptWorkers, stopAnswerScriptWorkers } from '../services/offlineEvaluation/answerScriptWorkerService.js';

const start = async () => {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required.');
  await connect();
  await bootstrapAiConfig();
  startAnswerScriptWorkers();
  const stop = async () => {
    await stopAnswerScriptWorkers();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log('[answer-script-worker] document, AI, and render workers started');
};

start().catch((error) => {
  console.error('[answer-script-worker] failed to start:', error.message || error);
  process.exit(1);
});

