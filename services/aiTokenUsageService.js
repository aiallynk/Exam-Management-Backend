import mongoose from 'mongoose';
import AITokenUsage from '../models/AITokenUsage.js';
import config from '../config/env.js';
import { getRequestContext } from '../middleware/requestContext.js';
import { estimateCostUsd, normalizeModelName } from '../utils/aiPricing.js';
import { evaluateAiUsageAlertRules } from './systemAlertService.js';

const VALID_REQUEST_STATUSES = new Set(['SUCCESS', 'FAILED']);
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEGACY_QUESTION_COUNT_MODEL_REGEX = new RegExp(
  `^${escapeRegex(normalizeModelName(config.openaiModel) || DEFAULT_OPENAI_MODEL)}`,
  'i'
);

const asNonNegativeInteger = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
};

const toNonNegativeNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
};

const asPositiveInteger = (value, fallback = 1) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(numeric));
};

const normalizeRequestStatus = (value) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return VALID_REQUEST_STATUSES.has(normalized) ? normalized : 'SUCCESS';
};

const normalizeErrorMessage = (value) =>
  String(value || '')
    .trim()
    .slice(0, 500);

const resolveTenantCandidateFromRequest = (req = null, requestUser = null) => {
  if (!req || typeof req !== 'object') {
    return requestUser?.tenantId ?? requestUser?.tenant_id ?? requestUser?.tenant?._id ?? null;
  }

  return (
    requestUser?.tenantId ??
    requestUser?.tenant_id ??
    requestUser?.tenant?._id ??
    req?.tenantId ??
    req?.tenant_id ??
    req?.body?.tenantId ??
    req?.body?.tenant_id ??
    req?.params?.tenantId ??
    req?.params?.tenant_id ??
    req?.query?.tenantId ??
    req?.query?.tenant_id ??
    null
  );
};

const resolveTokenUsage = (usage) => {
  const usageObject = usage && typeof usage === 'object' ? usage : {};

  const promptTokens = asNonNegativeInteger(
    usageObject.prompt_tokens ??
      usageObject.input_tokens ??
      usageObject.promptTokens ??
      usageObject.inputTokens
  );

  const completionTokens = asNonNegativeInteger(
    usageObject.completion_tokens ??
      usageObject.output_tokens ??
      usageObject.completionTokens ??
      usageObject.outputTokens
  );

  const explicitTotalTokens = toNonNegativeNumber(
    usageObject.total_tokens ??
      usageObject.totalTokens ??
      usageObject.total ??
      usageObject.total_token_count
  );

  const totalTokens = asNonNegativeInteger(
    explicitTotalTokens > 0 ? explicitTotalTokens : promptTokens + completionTokens
  );

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
};

const extractUsageFromCompletion = (completion) => {
  const usageCandidates = [
    completion?.usage,
    completion?.token_usage,
    completion?.usage_metadata,
    completion?.choices?.[0]?.usage,
    completion?.response?.usage,
    completion?.meta?.usage,
  ];

  for (const candidate of usageCandidates) {
    const resolved = resolveTokenUsage(candidate);
    if (
      resolved.prompt_tokens > 0 ||
      resolved.completion_tokens > 0 ||
      resolved.total_tokens > 0
    ) {
      return resolved;
    }
  }

  return resolveTokenUsage(usageCandidates.find(Boolean));
};

const toObjectIdOrNull = (value) => {
  if (!value) return null;

  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }

  const rawValue =
    typeof value === 'object' && value !== null && value._id
      ? value._id
      : value;

  const stringValue = String(rawValue || '').trim();
  if (!stringValue || !mongoose.Types.ObjectId.isValid(stringValue)) {
    return null;
  }

  return new mongoose.Types.ObjectId(stringValue);
};

const normalizeFeature = (feature) => {
  const normalized = String(feature || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  return normalized || 'unknown';
};

const inferFeatureFromPath = (path) => {
  const safePath = String(path || '').toLowerCase();
  if (!safePath) return 'unknown';

  if (safePath.includes('generate-questions')) return 'question_generation';
  if (safePath.includes('generate-answer-key')) return 'answer_key_generation';
  if (safePath.includes('import-questions')) return 'question_import';
  if (safePath.includes('evaluate')) return 'evaluation';
  if (safePath.includes('proctoring')) return 'ai_proctoring';
  return 'unknown';
};

export const trackAITokenUsage = async ({
  usage,
  feature,
  featureType,
  tenantId,
  userId,
  model,
  usageCount = 1,
  questionCount = 0,
  requestStatus = 'SUCCESS',
  errorMessage = '',
}) => {
  try {
    const resolvedUsage = resolveTokenUsage(usage);
    const promptTokens = resolvedUsage.prompt_tokens;
    const completionTokens = resolvedUsage.completion_tokens;
    const totalTokens = resolvedUsage.total_tokens;

    const context = getRequestContext();
    const requestUser = context?.req?.user || {};
    const contextTenantCandidate = resolveTenantCandidateFromRequest(
      context?.req,
      requestUser
    );
    const resolvedTenantId = toObjectIdOrNull(tenantId ?? contextTenantCandidate);
    const resolvedUserId = toObjectIdOrNull(userId ?? requestUser._id);
    const resolvedFeature = normalizeFeature(
      featureType || feature || inferFeatureFromPath(context?.req?.path)
    );
    const resolvedModel = normalizeModelName(model) || 'unknown';
    const resolvedUsageCount = asPositiveInteger(usageCount, 1);
    const resolvedQuestionCount = asNonNegativeInteger(questionCount);
    const resolvedRequestStatus = normalizeRequestStatus(requestStatus);
    const resolvedErrorMessage = normalizeErrorMessage(errorMessage);
    const resolvedCostUsd =
      promptTokens > 0 || completionTokens > 0 || totalTokens > 0
        ? estimateCostUsd({
            model: resolvedModel,
            promptTokens,
            completionTokens,
            totalTokens,
          })
        : 0;

    const record = await AITokenUsage.create({
      tenant_id: resolvedTenantId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      tokens_used: totalTokens,
      usage_count: resolvedUsageCount,
      question_count: resolvedQuestionCount,
      feature: resolvedFeature,
      feature_type: resolvedFeature,
      user_id: resolvedUserId,
      model: resolvedModel,
      cost_usd: resolvedCostUsd,
      request_status: resolvedRequestStatus,
      error_message: resolvedErrorMessage,
    });

    if (resolvedRequestStatus === 'SUCCESS' && resolvedTenantId) {
      evaluateAiUsageAlertRules(resolvedTenantId).catch((ruleError) => {
        console.error(
          '[ai-token-usage] failed to evaluate AI usage alert rules:',
          ruleError?.message || ruleError
        );
      });
    }

    if (process.env.NODE_ENV === 'development') {
      console.info(
        `[ai-token-usage] saved feature="${resolvedFeature}" tenant="${
          resolvedTenantId || 'null'
        }" total_tokens=${totalTokens} usage_count=${resolvedUsageCount} question_count=${resolvedQuestionCount} status=${resolvedRequestStatus}`
      );
    }

    return record;
  } catch (error) {
    // Token usage logging must never break primary AI workflows.
    console.warn('[ai-token-usage] failed to persist usage:', error?.message || error);
    return null;
  }
};

export const trackAIUsageEvent = async ({
  feature,
  featureType,
  tenantId,
  userId,
  model = 'unknown',
  usageCount = 1,
  questionCount = 0,
  requestStatus = 'SUCCESS',
  errorMessage = '',
  usage = null,
}) =>
  trackAITokenUsage({
    usage,
    feature,
    featureType,
    tenantId,
    userId,
    model,
    usageCount,
    questionCount,
    requestStatus,
    errorMessage,
  });

export const createTrackedChatCompletion = async ({
  client,
  request,
  feature,
  tenantId,
  userId,
  questionCount = 0,
}) => {
  if (!client?.chat?.completions?.create) {
    throw new Error('OpenAI client is not initialized');
  }

  const requestedModel = normalizeModelName(request?.model) || 'unknown';
  let completion;

  try {
    completion = await client.chat.completions.create(request);
  } catch (error) {
    await trackAITokenUsage({
      usage: null,
      feature,
      tenantId,
      userId,
      model: requestedModel,
      usageCount: 1,
      questionCount: 0,
      requestStatus: 'FAILED',
      errorMessage: error?.message || 'AI chat completion failed',
    });
    throw error;
  }

  const resolvedModel = normalizeModelName(completion?.model || requestedModel) || 'unknown';
  const resolvedUsage = extractUsageFromCompletion(completion);

  await trackAITokenUsage({
    usage: resolvedUsage,
    feature,
    tenantId,
    userId,
    model: resolvedModel,
    usageCount: 1,
    questionCount,
    requestStatus: 'SUCCESS',
  });

  return completion;
};

// Source-Grounded AI Question Generation — mirrors createTrackedChatCompletion
// above so embedding calls land in the same ai_token_usage collection/
// reporting/quota system rather than opening a third accounting path
// (generation already has its own path via createTrackedChatCompletion,
// grading has its own via aiGradingUsageService.js — this feature must not
// add a fourth).
export const createTrackedEmbedding = async ({
  client,
  request,
  model,
  input,
  feature = 'source_grounded_context_embedding',
  tenantId,
  userId,
}) => {
  if (!client?.embeddings?.create) {
    throw new Error('OpenAI client is not initialized');
  }

  const resolvedRequest = request || { model, input };
  const requestedModel = normalizeModelName(resolvedRequest?.model) || 'unknown';
  if (requestedModel.includes('gpt-') && !requestedModel.includes('embedding')) {
    throw new Error(`Invalid embedding model "${requestedModel}". Configure an embeddings model for EMBEDDING operations.`);
  }

  let response;

  try {
    response = await client.embeddings.create(resolvedRequest);
  } catch (error) {
    await trackAITokenUsage({
      usage: null,
      feature,
      tenantId,
      userId,
      model: requestedModel,
      usageCount: Array.isArray(resolvedRequest?.input) ? resolvedRequest.input.length : 1,
      questionCount: 0,
      requestStatus: 'FAILED',
      errorMessage: error?.message || 'AI embedding request failed',
    });
    throw error;
  }

  const resolvedModel = normalizeModelName(response?.model || requestedModel) || 'unknown';
  const resolvedUsage = {
    prompt_tokens: response?.usage?.prompt_tokens || 0,
    completion_tokens: 0,
    total_tokens: response?.usage?.total_tokens || response?.usage?.prompt_tokens || 0,
  };

  await trackAITokenUsage({
    usage: resolvedUsage,
    feature,
    tenantId,
    userId,
    model: resolvedModel,
    usageCount: Array.isArray(resolvedRequest?.input) ? resolvedRequest.input.length : 1,
    questionCount: 0,
    requestStatus: 'SUCCESS',
  });

  return response;
};

export const createTrackedImageGeneration = async ({
  client,
  request,
  feature = 'question_image_generation',
  tenantId,
  userId,
  usageCount,
}) => {
  if (!client?.images?.generate) {
    throw new Error('OpenAI image client is not initialized');
  }

  const requestedModel = normalizeModelName(request?.model) || 'gpt-image-1';
  const requestedCount = asPositiveInteger(usageCount ?? request?.n ?? 1, 1);

  try {
    const response = await client.images.generate(request);
    const resolvedModel = normalizeModelName(response?.model || requestedModel) || 'unknown';
    const resolvedUsage = resolveTokenUsage(
      response?.usage ?? response?.token_usage ?? response?.usage_metadata
    );
    const generatedCount = Array.isArray(response?.data) && response.data.length > 0
      ? response.data.length
      : requestedCount;

    await trackAITokenUsage({
      usage: resolvedUsage,
      feature,
      tenantId,
      userId,
      model: resolvedModel,
      usageCount: generatedCount,
      requestStatus: 'SUCCESS',
    });

    return response;
  } catch (error) {
    await trackAITokenUsage({
      usage: null,
      feature,
      tenantId,
      userId,
      model: requestedModel,
      usageCount: requestedCount,
      requestStatus: 'FAILED',
      errorMessage: error?.message || 'AI image generation failed',
    });
    throw error;
  }
};

export const getAIQuestionCountForTenantByWindow = async (tenantId, start, end) => {
  try {
    const resolvedTenantId = toObjectIdOrNull(tenantId);
    if (!resolvedTenantId) return 0;
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) return 0;
    if (!(end instanceof Date) || Number.isNaN(end.getTime())) return 0;

    const aggregation = await AITokenUsage.aggregate([
      {
        $match: {
          tenant_id: resolvedTenantId,
          feature: 'question_generation',
          request_status: 'SUCCESS',
          created_at: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: null,
          totalQuestions: {
            $sum: {
              $switch: {
                branches: [
                  {
                    case: { $gt: [{ $ifNull: ['$question_count', 0] }, 0] },
                    then: { $ifNull: ['$question_count', 0] },
                  },
                  {
                    // Backward compatibility for legacy records created before `question_count`.
                    case: {
                      $and: [
                        { $eq: [{ $type: '$question_count' }, 'missing'] },
                        {
                          $regexMatch: {
                            input: { $ifNull: ['$model', ''] },
                            regex: LEGACY_QUESTION_COUNT_MODEL_REGEX,
                          },
                        },
                      ],
                    },
                    then: { $ifNull: ['$usage_count', 0] },
                  },
                ],
                default: 0,
              },
            },
          },
        },
      },
    ]);

    return asNonNegativeInteger(aggregation?.[0]?.totalQuestions);
  } catch (error) {
    console.warn(
      '[ai-token-usage] failed to read tenant monthly AI question usage:',
      error?.message || error
    );
    return 0;
  }
};

const normalizeFeatureList = (features = []) => {
  if (!Array.isArray(features)) return [];
  return features
    .map((feature) => normalizeFeature(feature))
    .filter(Boolean);
};

const aggregateUsageCountForTenantByWindow = async ({
  tenantId,
  start,
  end,
  features = [],
  requestStatus = 'SUCCESS',
  field = 'usage_count',
}) => {
  const resolvedTenantId = toObjectIdOrNull(tenantId);
  if (!resolvedTenantId) return 0;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return 0;
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) return 0;

  const normalizedFeatures = normalizeFeatureList(features);
  if (!normalizedFeatures.length) return 0;

  const normalizedField = String(field || 'usage_count').trim();
  const safeField =
    ['usage_count', 'question_count', 'tokens_used', 'total_tokens', 'events'].includes(
      normalizedField
    )
      ? normalizedField
      : 'usage_count';
  const safeStatus = normalizeRequestStatus(requestStatus);

  const totalUsageExpression =
    safeField === 'events'
      ? 1
      : {
          $ifNull: [`$${safeField}`, 0],
        };

  const aggregation = await AITokenUsage.aggregate([
    {
      $match: {
        tenant_id: resolvedTenantId,
        feature: { $in: normalizedFeatures },
        request_status: safeStatus,
        created_at: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        totalUsage: {
          $sum: totalUsageExpression,
        },
      },
    },
  ]);

  return asNonNegativeInteger(aggregation?.[0]?.totalUsage);
};

export const getAIUsageCountForTenantByWindow = async (
  tenantId,
  start,
  end,
  {
    features = [],
    fallbackFeatures = [],
    requestStatus = 'SUCCESS',
    field = 'usage_count',
  } = {}
) => {
  try {
    const usage = await aggregateUsageCountForTenantByWindow({
      tenantId,
      start,
      end,
      features,
      requestStatus,
      field,
    });

    if (usage > 0 || !Array.isArray(fallbackFeatures) || fallbackFeatures.length === 0) {
      return usage;
    }

    return aggregateUsageCountForTenantByWindow({
      tenantId,
      start,
      end,
      features: fallbackFeatures,
      requestStatus,
      field,
    });
  } catch (error) {
    console.warn(
      '[ai-token-usage] failed to read tenant usage count:',
      error?.message || error
    );
    return 0;
  }
};
