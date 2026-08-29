import config from '../../config/env.js';
import { AI_OPERATIONS, AIEngineError, AI_ERROR_CODES } from './aiOperations.js';
import { getProviderForOperation } from './providerRegistry.js';
import { getEffectiveRuntimeSettings } from './aiConfigService.js';

const normalizeProviderError = (error, { operation, providerId }) => {
  const message = String(error?.message || 'AI provider request failed.');
  if (/rate limit/i.test(message)) {
    return new AIEngineError(AI_ERROR_CODES.AI_RATE_LIMITED, message, { operation, provider: providerId, cause: error });
  }
  if (/timeout/i.test(message)) {
    return new AIEngineError(AI_ERROR_CODES.AI_TIMEOUT, message, { operation, provider: providerId, cause: error });
  }
  if (/not configured/i.test(message)) {
    return new AIEngineError(AI_ERROR_CODES.AI_PROVIDER_NOT_CONFIGURED, message, { operation, provider: providerId, cause: error });
  }
  if (/safety|blocked/i.test(message)) {
    return new AIEngineError(AI_ERROR_CODES.AI_SAFETY_BLOCKED, message, { operation, provider: providerId, cause: error });
  }
  return new AIEngineError(AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, message, { operation, provider: providerId, cause: error });
};

const dispatch = async (operation, payload, context, provider) => {
  switch (operation) {
    case AI_OPERATIONS.EMBEDDING:
      return provider.embed({ texts: payload.texts, context });
    case AI_OPERATIONS.HANDWRITING_EXTRACTION:
    case AI_OPERATIONS.ANSWER_SCRIPT_VISION:
    case AI_OPERATIONS.ANSWER_IMAGE_EVALUATION:
    case AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION:
    case AI_OPERATIONS.VISUAL_RESPONSE_EVALUATION:
      return provider.analyzeImages({ operation, request: payload.request, context });
    default:
      if (payload?.request) return provider.generateStructured({ operation, request: payload.request, context });
      return provider.generateText({ operation, request: payload, context });
  }
};

export const executeAIOperation = async (operation, payload = {}, context = {}) => {
  const { providerId, provider } = getProviderForOperation(operation);
  if (!provider.supports(operation)) {
    throw new AIEngineError(AI_ERROR_CODES.AI_OPERATION_UNSUPPORTED, `Provider "${providerId}" does not support ${operation}.`, { operation, provider: providerId });
  }
  const runtime = getEffectiveRuntimeSettings();
  const maxRetries = Number.isFinite(runtime.maxRetries) ? runtime.maxRetries : 2;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const startedAt = Date.now();
      const result = await Promise.race([
        dispatch(operation, payload, context, provider),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('AI request timed out.')), runtime.requestTimeoutMs || 60000);
        }),
      ]);
      return {
        ...result,
        operation,
        provider: providerId,
        latencyMs: Date.now() - startedAt,
        retryCount: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
    }
  }
  throw normalizeProviderError(lastError, { operation, providerId });
};

export { AI_OPERATIONS };
