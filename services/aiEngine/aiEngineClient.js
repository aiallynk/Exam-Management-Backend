import { executeAIOperation } from './aiEngine.js';
import { AI_OPERATIONS } from './aiOperations.js';
import { getModelForOperation } from './aiConfigService.js';
import { getProviderForOperation } from './providerRegistry.js';

/**
 * Canonical application entry point for AI chat/completion requests.
 * All product code should call these helpers instead of instantiating providers.
 */
export const runEngineChatCompletion = async ({
  operation = AI_OPERATIONS.QUESTION_GENERATION,
  feature,
  tenantId = null,
  userId = null,
  request = {},
  model = null,
  questionCount = null,
}) => {
  const resolvedModel = model || request.model || getModelForOperation(operation);
  const result = await executeAIOperation(
    operation,
    { request: { ...request, model: resolvedModel } },
    {
      tenantId,
      userId,
      feature: feature || operation.toLowerCase(),
      model: resolvedModel,
      questionCount,
    }
  );
  return result.raw;
};

export const runEngineEmbedding = async ({
  texts,
  tenantId = null,
  userId = null,
  feature = 'embedding',
}) => {
  const input = Array.isArray(texts) ? texts : [texts];
  const result = await executeAIOperation(
    AI_OPERATIONS.EMBEDDING,
    { texts: input },
    { tenantId, userId, feature, model: getModelForOperation(AI_OPERATIONS.EMBEDDING) }
  );
  const embeddings = result.embeddings || [];
  return Array.isArray(texts) ? embeddings : (embeddings[0] || null);
};

export const isEngineOperationAvailable = (operation) => {
  try {
    const { provider } = getProviderForOperation(operation);
    if (!provider.supports(operation)) return false;
    const health = typeof provider.getHealth === 'function' ? provider.getHealth() : null;
    return Boolean(health?.configured);
  } catch {
    return false;
  }
};

export const runEngineImageGeneration = async ({
  request,
  tenantId = null,
  userId = null,
  feature = 'question_image_generation',
  model = null,
}) => {
  const resolvedModel = model || request?.model || getModelForOperation(AI_OPERATIONS.QUESTION_IMAGE_GENERATION);
  const result = await executeAIOperation(
    AI_OPERATIONS.QUESTION_IMAGE_GENERATION,
    { request: { ...request, model: resolvedModel } },
    { tenantId, userId, feature, model: resolvedModel }
  );
  return result.raw;
};

export const isOpenAIEngineConfigured = () => isEngineOperationAvailable(AI_OPERATIONS.QUESTION_GENERATION);

export const isEmbeddingEngineConfigured = () => isEngineOperationAvailable(AI_OPERATIONS.EMBEDDING);

export const isImageGenerationEngineConfigured = () => isEngineOperationAvailable(AI_OPERATIONS.QUESTION_IMAGE_GENERATION);
