import config from '../../../config/env.js';
import { getOpenAIClient } from '../../aiService.js';
import { createTrackedChatCompletion, createTrackedEmbedding } from '../../aiTokenUsageService.js';
import { AI_OPERATIONS } from '../aiOperations.js';

const SUPPORTED = new Set([
  AI_OPERATIONS.QUESTION_GENERATION,
  AI_OPERATIONS.QUESTION_REGENERATION,
  AI_OPERATIONS.QUESTION_REPAIR,
  AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
  AI_OPERATIONS.QUESTION_CLASSIFICATION,
  AI_OPERATIONS.COGNITIVE_CLASSIFICATION,
  AI_OPERATIONS.BLOOM_CLASSIFICATION,
  AI_OPERATIONS.QUESTION_EXPLANATION_GENERATION,
  AI_OPERATIONS.QUESTION_IMAGE_GENERATION,
  AI_OPERATIONS.EMBEDDING,
]);

export const createOpenAIProvider = () => ({
  id: 'openai',
  supports(operation) {
    return SUPPORTED.has(operation);
  },
  getHealth() {
    const configured = Boolean(config.openaiApiKey);
    return {
      configured,
      status: configured ? 'CONFIGURED' : 'UNAVAILABLE',
      models: {
        question: config.openaiQuestionModel || config.openaiModel,
        classification: config.openaiClassificationModel || config.openaiModel,
        embedding: config.openaiEmbeddingModel,
        image: config.openaiImageModel || config.openaiModel,
      },
    };
  },
  async generateStructured({ operation, request, context = {} }) {
    const client = getOpenAIClient();
    if (!client) throw new Error('OpenAI is not configured.');
    const model = context.model || (
      operation === AI_OPERATIONS.QUESTION_CLASSIFICATION || operation === AI_OPERATIONS.COGNITIVE_CLASSIFICATION || operation === AI_OPERATIONS.BLOOM_CLASSIFICATION
        ? (config.openaiClassificationModel || config.openaiModel)
        : (config.openaiQuestionModel || config.openaiModel)
    );
    const completion = await createTrackedChatCompletion({
      client,
      feature: context.feature || operation.toLowerCase(),
      tenantId: context.tenantId,
      userId: context.userId,
      request: {
        model,
        ...request,
      },
    });
    return {
      provider: 'openai',
      model,
      operation,
      raw: completion,
      content: completion?.choices?.[0]?.message?.content || '',
    };
  },
  async generateText(params) {
    return this.generateStructured(params);
  },
  async embed({ texts, context = {} }) {
    const client = getOpenAIClient();
    if (!client) throw new Error('OpenAI is not configured.');
    const embeddings = await createTrackedEmbedding({
      client,
      feature: context.feature || 'embedding',
      tenantId: context.tenantId,
      userId: context.userId,
      model: config.openaiEmbeddingModel,
      input: texts,
    });
    return {
      provider: 'openai',
      model: config.openaiEmbeddingModel,
      embeddings: embeddings?.data?.map((item) => item.embedding) || [],
    };
  },
});
