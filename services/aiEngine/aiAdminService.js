import config from '../../config/env.js';
import { AI_OPERATIONS } from './aiOperations.js';
import {
  refreshAiConfig,
  getCachedOperationRouting,
  getCachedAiConfigSource,
  getEffectiveRuntimeSettings,
  getDefaultQuestionProvider,
  getDefaultEvaluationProvider,
  buildEnvBootstrapOperationRouting,
  saveOperationRoutingToDatabase,
  saveRuntimeSettingsToDatabase,
  ALLOWED_PROVIDERS,
} from './aiConfigService.js';
import { getProviderHealthSnapshot } from './providerRegistry.js';

const OPERATION_META = Object.freeze({
  [AI_OPERATIONS.QUESTION_GENERATION]: { label: 'Question generation', group: 'question' },
  [AI_OPERATIONS.QUESTION_REGENERATION]: { label: 'Question regeneration', group: 'question' },
  [AI_OPERATIONS.QUESTION_REPAIR]: { label: 'Question repair', group: 'question' },
  [AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE]: { label: 'Question import assistance', group: 'question' },
  [AI_OPERATIONS.QUESTION_CLASSIFICATION]: { label: 'Question classification', group: 'question' },
  [AI_OPERATIONS.COGNITIVE_CLASSIFICATION]: { label: 'Cognitive demand classification', group: 'question' },
  [AI_OPERATIONS.BLOOM_CLASSIFICATION]: { label: 'Bloom classification', group: 'question' },
  [AI_OPERATIONS.QUESTION_EXPLANATION_GENERATION]: { label: 'Question explanation generation', group: 'question' },
  [AI_OPERATIONS.QUESTION_IMAGE_GENERATION]: { label: 'Question image generation', group: 'question' },
  [AI_OPERATIONS.EMBEDDING]: { label: 'Embeddings / similarity', group: 'question' },
  [AI_OPERATIONS.HANDWRITING_EXTRACTION]: { label: 'Handwriting extraction', group: 'evaluation' },
  [AI_OPERATIONS.ANSWER_SCRIPT_VISION]: { label: 'Answer script vision', group: 'evaluation' },
  [AI_OPERATIONS.ANSWER_TEXT_EVALUATION]: { label: 'Answer text evaluation', group: 'evaluation' },
  [AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION]: { label: 'Rubric evaluation', group: 'evaluation' },
  [AI_OPERATIONS.ANSWER_IMAGE_EVALUATION]: { label: 'Answer image evaluation', group: 'evaluation' },
  [AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION]: { label: 'Diagram response evaluation', group: 'evaluation' },
  [AI_OPERATIONS.VISUAL_RESPONSE_EVALUATION]: { label: 'Visual response evaluation', group: 'evaluation' },
  [AI_OPERATIONS.FORMATIVE_ANSWER_FEEDBACK]: { label: 'Formative answer feedback', group: 'evaluation' },
  [AI_OPERATIONS.MISCONCEPTION_ANALYSIS]: { label: 'Misconception analysis', group: 'evaluation' },
  [AI_OPERATIONS.EVALUATION_EXPLANATION]: { label: 'Evaluation explanation', group: 'evaluation' },
});

const sanitizeRouting = (routing = {}) => {
  const allowed = new Set(Object.values(AI_OPERATIONS));
  const next = {};
  Object.entries(routing || {}).forEach(([operation, providerId]) => {
    if (!allowed.has(operation)) return;
    const normalized = String(providerId || '').trim().toLowerCase();
    if (ALLOWED_PROVIDERS.has(normalized)) next[operation] = normalized;
  });
  return next;
};

export const getAiEngineAdminSnapshot = async () => {
  await refreshAiConfig();
  const routing = getCachedOperationRouting();
  const operations = Object.values(AI_OPERATIONS).map((operation) => ({
    operation,
    label: OPERATION_META[operation]?.label || operation,
    group: OPERATION_META[operation]?.group || 'other',
    providerId: routing[operation] || null,
  }));

  return {
    configSource: getCachedAiConfigSource(),
    envConfigSource: config.aiConfigSource,
    credentials: {
      openai: { configured: Boolean(config.openaiApiKey) },
      gemini: { configured: Boolean(config.geminiApiKey) },
    },
    models: {
      openai: {
        question: config.openaiQuestionModel,
        classification: config.openaiClassificationModel,
        embedding: config.openaiEmbeddingModel,
        image: config.openaiImageModel,
      },
      gemini: {
        evaluation: config.geminiEvaluationModel,
        vision: config.geminiVisionModel,
        handwriting: config.geminiHandwritingModel,
        feedback: config.geminiFeedbackModel,
      },
    },
    defaults: {
      questionProvider: getDefaultQuestionProvider(),
      evaluationProvider: getDefaultEvaluationProvider(),
    },
    operationRouting: routing,
    operations,
    runtime: getEffectiveRuntimeSettings(),
    providers: getProviderHealthSnapshot(),
    providerOptions: [...ALLOWED_PROVIDERS],
  };
};

export const updateAiEngineAdminConfig = async ({
  defaultQuestionProvider,
  defaultEvaluationProvider,
  operationRouting,
  runtime,
} = {}, updatedBy) => {
  let nextRouting = sanitizeRouting(operationRouting);
  if (!Object.keys(nextRouting).length && (defaultQuestionProvider || defaultEvaluationProvider)) {
    nextRouting = buildEnvBootstrapOperationRouting({
      questionProvider: defaultQuestionProvider,
      evaluationProvider: defaultEvaluationProvider,
    });
  } else if (Object.keys(nextRouting).length) {
    const bootstrap = buildEnvBootstrapOperationRouting({
      questionProvider: defaultQuestionProvider || getDefaultQuestionProvider(),
      evaluationProvider: defaultEvaluationProvider || getDefaultEvaluationProvider(),
    });
    nextRouting = { ...bootstrap, ...nextRouting };
  }

  if (Object.keys(nextRouting).length) {
    await saveOperationRoutingToDatabase(nextRouting, updatedBy);
  }
  if (runtime && typeof runtime === 'object') {
    await saveRuntimeSettingsToDatabase(runtime, updatedBy);
  }
  return getAiEngineAdminSnapshot();
};
