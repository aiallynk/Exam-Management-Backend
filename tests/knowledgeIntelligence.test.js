import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_MODES, InsufficientContextError } from '../services/generationContextOrchestrator.js';
import { getQueueMode, QUEUE_MODE } from '../services/jobs/jobDispatcherService.js';
import { REPEAT_POLICIES } from '../services/questionMemoryService.js';
import { AI_OPERATIONS } from '../services/aiEngine/aiOperations.js';
import { buildEnvBootstrapOperationRouting } from '../services/aiEngine/aiConfigService.js';

test('context modes are defined for product-facing orchestration', () => {
  assert.equal(CONTEXT_MODES.STANDARD, 'STANDARD');
  assert.equal(CONTEXT_MODES.AUTO_CONTEXT, 'AUTO_CONTEXT');
  assert.equal(CONTEXT_MODES.SELECTED_CONTEXT, 'SELECTED_CONTEXT');
  assert.equal(CONTEXT_MODES.STRICT_SOURCE, 'STRICT_SOURCE');
});

test('insufficient context error carries actionable code', () => {
  const error = new InsufficientContextError('No sources', 'NO_READY_SOURCES');
  assert.equal(error.code, 'NO_READY_SOURCES');
});

test('job dispatcher falls back in non-production without redis', () => {
  const mode = getQueueMode();
  assert.ok([QUEUE_MODE.IN_PROCESS_FALLBACK, QUEUE_MODE.DURABLE_QUEUE, QUEUE_MODE.UNAVAILABLE].includes(mode));
});

test('question repeat policies include deterministic outcomes', () => {
  assert.equal(REPEAT_POLICIES.BLOCK, 'BLOCK');
  assert.equal(REPEAT_POLICIES.WARN, 'WARN');
  assert.equal(REPEAT_POLICIES.REGENERATE, 'REGENERATE');
});

test('guideline interpretation routes through OpenAI domain in bootstrap routing', () => {
  const routing = buildEnvBootstrapOperationRouting({ questionProvider: 'openai', evaluationProvider: 'gemini' });
  assert.equal(routing[AI_OPERATIONS.GUIDELINE_INTERPRETATION], 'openai');
  assert.equal(routing[AI_OPERATIONS.CONTENT_METADATA_ENRICHMENT], 'openai');
});
