import config from '../../config/env.js';
import { AI_OPERATIONS, AI_PROVIDER_IDS, AIEngineError, AI_ERROR_CODES } from './aiOperations.js';
import {
  resolveOperationProviderFromCache,
  bootstrapAiConfig,
  resetAiConfigCacheForTests,
  buildEnvBootstrapOperationRouting,
} from './aiConfigService.js';
import { createOpenAIProvider } from './providers/openaiProvider.js';
import { createGeminiProvider } from './providers/geminiProvider.js';
import { createMockOpenAIProvider, createMockGeminiProvider } from './providers/mockProviders.js';

const DEFAULT_OPERATION_ROUTING = Object.freeze(buildEnvBootstrapOperationRouting());

const resolveOperationProviderId = (operation) => {
  return resolveOperationProviderFromCache(operation)
    || DEFAULT_OPERATION_ROUTING[operation]
    || null;
};

let providerCache = null;

const buildProviderRegistry = () => {
  if (providerCache) return providerCache;
  const useMocks = config.nodeEnv === 'test' && config.aiUseMockProviders;
  providerCache = {
    [AI_PROVIDER_IDS.OPENAI]: useMocks ? createMockOpenAIProvider() : createOpenAIProvider(),
    [AI_PROVIDER_IDS.GEMINI]: useMocks ? createMockGeminiProvider() : createGeminiProvider(),
    [AI_PROVIDER_IDS.MOCK_OPENAI]: createMockOpenAIProvider(),
    [AI_PROVIDER_IDS.MOCK_GEMINI]: createMockGeminiProvider(),
  };
  return providerCache;
};

export const getProviderForOperation = (operation) => {
  const providerId = resolveOperationProviderId(operation);
  if (!providerId) {
    throw new AIEngineError(AI_ERROR_CODES.AI_OPERATION_UNSUPPORTED, `No provider routing configured for operation: ${operation}`, { operation });
  }
  const provider = buildProviderRegistry()[providerId];
  if (!provider) {
    throw new AIEngineError(AI_ERROR_CODES.AI_PROVIDER_NOT_CONFIGURED, `Provider "${providerId}" is not registered.`, { operation, provider: providerId });
  }
  return { providerId, provider };
};

export const getProviderHealthSnapshot = () => {
  const registry = buildProviderRegistry();
  return Object.entries(registry).map(([providerId, provider]) => ({
    providerId,
    ...(typeof provider.getHealth === 'function' ? provider.getHealth() : { status: 'UNKNOWN' }),
  }));
};

export const resetProviderRegistryForTests = () => {
  providerCache = null;
  resetAiConfigCacheForTests();
};

export { DEFAULT_OPERATION_ROUTING, resolveOperationProviderId, bootstrapAiConfig };
