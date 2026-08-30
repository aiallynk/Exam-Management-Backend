import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOperationProviderId, DEFAULT_OPERATION_ROUTING, bootstrapAiConfig } from '../services/aiEngine/providerRegistry.js';
import { AI_OPERATIONS } from '../services/aiEngine/aiOperations.js';
import { computeResourceAiReadiness } from '../services/libraryResourceService.js';
import { buildEnvBootstrapOperationRouting } from '../services/aiEngine/aiConfigService.js';
import { getAiEngineAdminSnapshot } from '../services/aiEngine/aiAdminService.js';

test('AI operation routing defaults', async () => {
  await bootstrapAiConfig();
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.QUESTION_GENERATION), 'openai');
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.EMBEDDING), 'openai');
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE), 'gemini');
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.QUESTION_IMAGE_GENERATION), 'gemini');
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.HANDWRITING_EXTRACTION), 'gemini');
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION), 'gemini');
  assert.equal(resolveOperationProviderId(AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION), 'gemini');
  assert.equal(DEFAULT_OPERATION_ROUTING.MCQ_EVALUATION, undefined);
});

test('env bootstrap routing maps question vs evaluation domains', () => {
  const routing = buildEnvBootstrapOperationRouting({ questionProvider: 'openai', evaluationProvider: 'gemini' });
  assert.equal(routing[AI_OPERATIONS.QUESTION_GENERATION], 'openai');
  assert.equal(routing[AI_OPERATIONS.CONTENT_GROUNDED_QUESTION_GENERATION], 'openai');
  assert.equal(routing[AI_OPERATIONS.EMBEDDING], 'openai');
  assert.equal(routing[AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE], 'gemini');
  assert.equal(routing[AI_OPERATIONS.QUESTION_IMAGE_GENERATION], 'gemini');
  assert.equal(routing[AI_OPERATIONS.HANDWRITING_EXTRACTION], 'gemini');
  assert.equal(routing[AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION], 'gemini');
});

test('LibraryResource AI readiness aggregation', () => {
  assert.equal(computeResourceAiReadiness([]), 'STORED_ONLY');
  assert.equal(computeResourceAiReadiness([{ status: 'READY' }, { status: 'READY' }]), 'READY');
  assert.equal(computeResourceAiReadiness([{ status: 'PROCESSING' }]), 'PROCESSING');
  assert.equal(computeResourceAiReadiness([{ status: 'UNSUPPORTED_FOR_AI' }]), 'UNSUPPORTED');
  assert.equal(computeResourceAiReadiness([{ status: 'FAILED' }]), 'FAILED');
});

test('AI admin snapshot never exposes API key fields', async () => {
  const snapshot = await getAiEngineAdminSnapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(typeof snapshot.credentials.openai.configured, 'boolean');
  assert.equal(typeof snapshot.credentials.gemini.configured, 'boolean');
  assert.equal(serialized.includes('openaiApiKey'), false);
  assert.equal(serialized.includes('geminiApiKey'), false);
  assert.equal(serialized.includes('OPENAI_API_KEY'), false);
  assert.equal(serialized.includes('GEMINI_API_KEY'), false);
});
