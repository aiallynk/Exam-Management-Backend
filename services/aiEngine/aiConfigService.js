import config from '../../config/env.js';
import SystemConfig from '../../models/SystemConfig.js';
import { AI_OPERATIONS } from './aiOperations.js';

export const AI_OPERATION_ROUTING_CONFIG_KEY = 'platform.ai.operationRouting';
export const AI_RUNTIME_SETTINGS_CONFIG_KEY = 'platform.ai.runtimeSettings';

const ALLOWED_PROVIDERS = new Set(['openai', 'gemini']);

const normalizeProviderId = (value, fallback) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(normalized)) return fallback;
  return normalized || fallback;
};

export const buildEnvBootstrapOperationRouting = ({
  questionProvider = config.aiDefaultQuestionProvider,
  evaluationProvider = config.aiDefaultEvaluationProvider,
} = {}) => {
  const question = normalizeProviderId(questionProvider, 'openai');
  const evaluation = normalizeProviderId(evaluationProvider, 'gemini');
  return {
    [AI_OPERATIONS.QUESTION_GENERATION]: question,
    [AI_OPERATIONS.QUESTION_REGENERATION]: question,
    [AI_OPERATIONS.QUESTION_REPAIR]: question,
    [AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE]: question,
    [AI_OPERATIONS.QUESTION_CLASSIFICATION]: question,
    [AI_OPERATIONS.COGNITIVE_CLASSIFICATION]: question,
    [AI_OPERATIONS.BLOOM_CLASSIFICATION]: question,
    [AI_OPERATIONS.QUESTION_EXPLANATION_GENERATION]: question,
    [AI_OPERATIONS.QUESTION_IMAGE_GENERATION]: question,
    [AI_OPERATIONS.EMBEDDING]: question,
    [AI_OPERATIONS.HANDWRITING_EXTRACTION]: evaluation,
    [AI_OPERATIONS.ANSWER_SCRIPT_VISION]: evaluation,
    [AI_OPERATIONS.ANSWER_TEXT_EVALUATION]: evaluation,
    [AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION]: evaluation,
    [AI_OPERATIONS.ANSWER_IMAGE_EVALUATION]: evaluation,
    [AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION]: evaluation,
    [AI_OPERATIONS.VISUAL_RESPONSE_EVALUATION]: evaluation,
    [AI_OPERATIONS.FORMATIVE_ANSWER_FEEDBACK]: evaluation,
    [AI_OPERATIONS.MISCONCEPTION_ANALYSIS]: evaluation,
    [AI_OPERATIONS.EVALUATION_EXPLANATION]: evaluation,
  };
};

export const buildEnvRuntimeSettings = () => ({
  requestTimeoutMs: Number(config.aiRequestTimeoutMs) || 60000,
  maxRetries: Number(config.aiMaxRetries) || 2,
  strictProviderRouting: config.aiStrictProviderRouting !== false,
  enableProviderFallback: config.aiEnableProviderFallback === true,
});

let cachedRouting = null;
let cachedSource = 'env';
let cachedRuntime = null;

const parseDbJsonObject = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const getCachedOperationRouting = () => cachedRouting || buildEnvBootstrapOperationRouting();

export const getCachedAiConfigSource = () => cachedSource;

export const getEffectiveRuntimeSettings = () => cachedRuntime || buildEnvRuntimeSettings();

export const resolveOperationProviderFromCache = (operation) => {
  const routing = getCachedOperationRouting();
  return routing[operation] || null;
};

export const getDefaultQuestionProvider = () => normalizeProviderId(
  getCachedOperationRouting()[AI_OPERATIONS.QUESTION_GENERATION],
  config.aiDefaultQuestionProvider
);

export const getDefaultEvaluationProvider = () => normalizeProviderId(
  getCachedOperationRouting()[AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION],
  config.aiDefaultEvaluationProvider
);

const loadRuntimeFromDatabase = async () => {
  const envDefaults = buildEnvRuntimeSettings();
  try {
    const record = await SystemConfig.findOne({ key: AI_RUNTIME_SETTINGS_CONFIG_KEY }).lean();
    const dbRuntime = parseDbJsonObject(record?.value);
    if (!dbRuntime) return envDefaults;
    return {
      requestTimeoutMs: Number(dbRuntime.requestTimeoutMs) || envDefaults.requestTimeoutMs,
      maxRetries: Number(dbRuntime.maxRetries) || envDefaults.maxRetries,
      strictProviderRouting: dbRuntime.strictProviderRouting !== undefined
        ? Boolean(dbRuntime.strictProviderRouting)
        : envDefaults.strictProviderRouting,
      enableProviderFallback: dbRuntime.enableProviderFallback !== undefined
        ? Boolean(dbRuntime.enableProviderFallback)
        : envDefaults.enableProviderFallback,
    };
  } catch {
    return envDefaults;
  }
};

export const bootstrapAiConfig = async () => {
  const bootstrap = buildEnvBootstrapOperationRouting();
  cachedRuntime = await loadRuntimeFromDatabase();

  if (config.aiConfigSource !== 'database') {
    cachedRouting = bootstrap;
    cachedSource = 'env';
    return { source: cachedSource, routing: cachedRouting, runtime: cachedRuntime };
  }

  try {
    const record = await SystemConfig.findOne({ key: AI_OPERATION_ROUTING_CONFIG_KEY }).lean();
    const dbRouting = parseDbJsonObject(record?.value);
    if (dbRouting && Object.keys(dbRouting).length) {
      cachedRouting = { ...bootstrap, ...dbRouting };
      cachedSource = 'database';
      return { source: cachedSource, routing: cachedRouting, runtime: cachedRuntime };
    }
  } catch {
    // DB unavailable during tests or early boot — env bootstrap is safe.
  }

  cachedRouting = bootstrap;
  cachedSource = 'env-bootstrap';
  return { source: cachedSource, routing: cachedRouting, runtime: cachedRuntime };
};

export const refreshAiConfig = async () => bootstrapAiConfig();

export const resetAiConfigCacheForTests = () => {
  cachedRouting = null;
  cachedSource = 'env';
  cachedRuntime = null;
};

export const saveOperationRoutingToDatabase = async (routing, updatedBy) => {
  const nextRouting = { ...buildEnvBootstrapOperationRouting(), ...(routing || {}) };
  Object.keys(nextRouting).forEach((operation) => {
    nextRouting[operation] = normalizeProviderId(nextRouting[operation], 'openai');
  });
  await SystemConfig.findOneAndUpdate(
    { key: AI_OPERATION_ROUTING_CONFIG_KEY },
    {
      key: AI_OPERATION_ROUTING_CONFIG_KEY,
      value: JSON.stringify(nextRouting),
      description: 'Platform AI operation → provider routing map (secrets remain env-only).',
      ...(updatedBy ? { updatedBy } : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cachedRouting = nextRouting;
  cachedSource = 'database';
  return nextRouting;
};

export const saveRuntimeSettingsToDatabase = async (runtime, updatedBy) => {
  const envDefaults = buildEnvRuntimeSettings();
  const nextRuntime = {
    requestTimeoutMs: Math.max(5000, Number(runtime?.requestTimeoutMs) || envDefaults.requestTimeoutMs),
    maxRetries: Math.max(0, Math.min(5, Number(runtime?.maxRetries) || envDefaults.maxRetries)),
    strictProviderRouting: runtime?.strictProviderRouting !== undefined
      ? Boolean(runtime.strictProviderRouting)
      : envDefaults.strictProviderRouting,
    enableProviderFallback: runtime?.enableProviderFallback !== undefined
      ? Boolean(runtime.enableProviderFallback)
      : envDefaults.enableProviderFallback,
  };
  await SystemConfig.findOneAndUpdate(
    { key: AI_RUNTIME_SETTINGS_CONFIG_KEY },
    {
      key: AI_RUNTIME_SETTINGS_CONFIG_KEY,
      value: JSON.stringify(nextRuntime),
      description: 'Platform AI runtime safety settings.',
      ...(updatedBy ? { updatedBy } : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cachedRuntime = nextRuntime;
  return nextRuntime;
};

export { ALLOWED_PROVIDERS };
