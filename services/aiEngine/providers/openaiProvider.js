import config from '../../../config/env.js';
import { AI_OPERATIONS } from '../aiOperations.js';
import { getModelForOperation } from '../aiConfigService.js';
import { getOpenAIClient } from '../openaiClient.js';

const SUPPORTED = new Set([
  AI_OPERATIONS.QUESTION_GENERATION,
  AI_OPERATIONS.CONTENT_GROUNDED_QUESTION_GENERATION,
  AI_OPERATIONS.QUESTION_REGENERATION,
  AI_OPERATIONS.QUESTION_REPAIR,
  AI_OPERATIONS.QUESTION_CLASSIFICATION,
  AI_OPERATIONS.COGNITIVE_CLASSIFICATION,
  AI_OPERATIONS.BLOOM_CLASSIFICATION,
  AI_OPERATIONS.QUESTION_EXPLANATION_GENERATION,
  AI_OPERATIONS.EMBEDDING,
  AI_OPERATIONS.GUIDELINE_INTERPRETATION,
  AI_OPERATIONS.CONTENT_METADATA_ENRICHMENT,
  AI_OPERATIONS.ANSWER_TEXT_EVALUATION,
  AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION,
]);

const extractUsage = (usage = {}) => ({
  prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
  completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  total_tokens: usage.total_tokens ?? usage.totalTokens ?? 0,
});

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
      },
    };
  },
  async generateStructured({ operation, request, context = {} }) {
    const client = getOpenAIClient();
    if (!client) throw new Error('OpenAI is not configured.');
    const model = context.model || request.model || getModelForOperation(operation);
    const completion = await client.chat.completions.create({
      model,
      ...request,
    });
    return {
      provider: 'openai',
      model: completion?.model || model,
      operation,
      raw: completion,
      content: completion?.choices?.[0]?.message?.content || '',
      usage: extractUsage(completion?.usage || {}),
    };
  },
  async generateText(params) {
    return this.generateStructured(params);
  },
  async embed({ texts, context = {} }) {
    const client = getOpenAIClient();
    if (!client) throw new Error('OpenAI is not configured.');
    const model = getModelForOperation(AI_OPERATIONS.EMBEDDING);
    const response = await client.embeddings.create({ model, input: texts });
    return {
      provider: 'openai',
      model: response?.model || model,
      embeddings: response?.data?.map((item) => item.embedding) || [],
      usage: extractUsage(response?.usage || {}),
    };
  },
});
