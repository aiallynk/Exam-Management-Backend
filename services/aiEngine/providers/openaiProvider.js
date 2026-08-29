import config from '../../../config/env.js';
import { createTrackedChatCompletion, createTrackedEmbedding, createTrackedImageGeneration } from '../../aiTokenUsageService.js';
import { AI_OPERATIONS } from '../aiOperations.js';
import { getModelForOperation } from '../aiConfigService.js';
import { getOpenAIClient } from '../openaiClient.js';

const SUPPORTED = new Set([
  AI_OPERATIONS.QUESTION_GENERATION,
  AI_OPERATIONS.CONTENT_GROUNDED_QUESTION_GENERATION,
  AI_OPERATIONS.QUESTION_REGENERATION,
  AI_OPERATIONS.QUESTION_REPAIR,
  AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
  AI_OPERATIONS.QUESTION_CLASSIFICATION,
  AI_OPERATIONS.COGNITIVE_CLASSIFICATION,
  AI_OPERATIONS.BLOOM_CLASSIFICATION,
  AI_OPERATIONS.QUESTION_EXPLANATION_GENERATION,
  AI_OPERATIONS.QUESTION_IMAGE_GENERATION,
  AI_OPERATIONS.EMBEDDING,
  AI_OPERATIONS.GUIDELINE_INTERPRETATION,
  AI_OPERATIONS.CONTENT_METADATA_ENRICHMENT,
  AI_OPERATIONS.ANSWER_TEXT_EVALUATION,
  AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION,
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
        question: getModelForOperation(AI_OPERATIONS.QUESTION_GENERATION),
        classification: getModelForOperation(AI_OPERATIONS.QUESTION_CLASSIFICATION),
        embedding: getModelForOperation(AI_OPERATIONS.EMBEDDING),
        image: getModelForOperation(AI_OPERATIONS.QUESTION_IMAGE_GENERATION),
      },
    };
  },
  async generateStructured({ operation, request, context = {} }) {
    const client = getOpenAIClient();
    if (!client) throw new Error('OpenAI is not configured.');
    const model = context.model || request.model || getModelForOperation(operation);
    const completion = await createTrackedChatCompletion({
      client,
      feature: context.feature || operation.toLowerCase(),
      tenantId: context.tenantId,
      userId: context.userId,
      questionCount: context.questionCount,
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
    const model = getModelForOperation(AI_OPERATIONS.EMBEDDING);
    const embeddings = await createTrackedEmbedding({
      client,
      feature: context.feature || 'embedding',
      tenantId: context.tenantId,
      userId: context.userId,
      model,
      input: texts,
    });
    return {
      provider: 'openai',
      model,
      embeddings: embeddings?.data?.map((item) => item.embedding) || [],
    };
  },
  async generateImage({ operation, request, context = {} }) {
    const client = getOpenAIClient();
    if (!client) throw new Error('OpenAI is not configured.');
    const model = context.model || request.model || getModelForOperation(operation);
    const response = await createTrackedImageGeneration({
      client,
      feature: context.feature || 'question_image_generation',
      tenantId: context.tenantId,
      userId: context.userId,
      usageCount: request.n,
      request: { ...request, model },
    });
    return {
      provider: 'openai',
      model,
      operation,
      raw: response,
      images: response?.data || [],
    };
  },
});
