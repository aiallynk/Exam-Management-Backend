import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../../config/env.js';
import { AI_OPERATIONS } from '../aiOperations.js';
import { getModelForOperation } from '../aiConfigService.js';

const SUPPORTED = new Set([
  AI_OPERATIONS.HANDWRITING_EXTRACTION,
  AI_OPERATIONS.ANSWER_SCRIPT_IDENTITY_EXTRACTION,
  AI_OPERATIONS.ANSWER_SCRIPT_VISION,
  AI_OPERATIONS.ANSWER_TEXT_EVALUATION,
  AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION,
  AI_OPERATIONS.ANSWER_IMAGE_EVALUATION,
  AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION,
  AI_OPERATIONS.VISUAL_RESPONSE_EVALUATION,
  AI_OPERATIONS.FORMATIVE_ANSWER_FEEDBACK,
  AI_OPERATIONS.MISCONCEPTION_ANALYSIS,
  AI_OPERATIONS.EVALUATION_EXPLANATION,
]);

let geminiClient = null;
let geminiHealthCache = { status: 'UNAVAILABLE', checkedAt: 0 };

const getGeminiClient = () => {
  if (!config.geminiApiKey) return null;
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(config.geminiApiKey);
  return geminiClient;
};

const probeGeminiHealth = () => {
  const configured = Boolean(config.geminiApiKey);
  if (!configured) {
    geminiHealthCache = { status: 'UNAVAILABLE', checkedAt: Date.now(), configured: false };
    return geminiHealthCache;
  }
  try {
    getGeminiClient();
    geminiHealthCache = {
      status: 'CONFIGURED',
      checkedAt: Date.now(),
      configured: true,
      models: {
        evaluation: config.geminiEvaluationModel,
        vision: config.geminiVisionModel,
        handwriting: config.geminiHandwritingModel,
        feedback: config.geminiFeedbackModel,
      },
    };
  } catch {
    geminiHealthCache = { status: 'DEGRADED', checkedAt: Date.now(), configured: true };
  }
  return geminiHealthCache;
};

const resolveModelName = (operation) => {
  switch (operation) {
    case AI_OPERATIONS.HANDWRITING_EXTRACTION:
      return config.geminiHandwritingModel || config.geminiVisionModel || config.geminiEvaluationModel;
    case AI_OPERATIONS.ANSWER_SCRIPT_IDENTITY_EXTRACTION:
    case AI_OPERATIONS.ANSWER_SCRIPT_VISION:
    case AI_OPERATIONS.ANSWER_IMAGE_EVALUATION:
    case AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION:
    case AI_OPERATIONS.VISUAL_RESPONSE_EVALUATION:
      return config.geminiVisionModel || config.geminiEvaluationModel;
    case AI_OPERATIONS.FORMATIVE_ANSWER_FEEDBACK:
      return config.geminiFeedbackModel || config.geminiEvaluationModel;
    default:
      return config.geminiEvaluationModel;
  }
};

const isMissingModelError = (error) => {
  const message = String(error?.message || '');
  return error?.status === 404 || /is no longer available|is not found for API version|not supported for generateContent/i.test(message);
};

const isQuotaError = (error) => {
  const message = String(error?.message || '');
  return error?.status === 429 || /exceeded your current quota|rate-limit|quota exceeded/i.test(message);
};

const geminiModelCandidates = (requested) => {
  const names = [
    requested,
    process.env.GEMINI_FALLBACK_MODEL,
    'gemini-3.6-flash',
    'gemini-2.5-flash',
  ].map((value) => String(value || '').replace(/^models\//, '').trim()).filter(Boolean);
  return [...new Set(names)];
};

const parseJsonContent = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
};

export const createGeminiProvider = () => ({
  id: 'gemini',
  supports(operation) {
    return SUPPORTED.has(operation);
  },
  getHealth() {
    const cacheAgeMs = Date.now() - (geminiHealthCache.checkedAt || 0);
    if (cacheAgeMs > 5 * 60 * 1000) probeGeminiHealth();
    const health = geminiHealthCache.checkedAt ? geminiHealthCache : probeGeminiHealth();
    return {
      configured: Boolean(health.configured),
      status: health.status || (health.configured ? 'CONFIGURED' : 'UNAVAILABLE'),
      models: health.models || {
        evaluation: config.geminiEvaluationModel,
        vision: config.geminiVisionModel,
        handwriting: config.geminiHandwritingModel,
        feedback: config.geminiFeedbackModel,
      },
      checkedAt: health.checkedAt || null,
    };
  },
  async generateStructured({ operation, request, context = {} }) {
    const client = getGeminiClient();
    if (!client) throw new Error('Gemini is not configured.');
    const requestedModel = context.model || getModelForOperation(operation) || resolveModelName(operation);
    if (!requestedModel) throw new Error('Gemini model is not configured for this operation.');
    const parts = [];
    if (request?.system) parts.push({ text: String(request.system) });
    if (request?.user) parts.push({ text: String(request.user) });
    if (Array.isArray(request?.images)) {
      request.images.forEach((image) => {
        if (image?.inlineData) parts.push({ inlineData: image.inlineData });
        else if (image?.url) parts.push({ text: `[image:${image.url}]` });
      });
    }
    const generationConfig = {
      temperature: request?.temperature ?? 0.1,
      responseMimeType: request?.response_format?.type === 'json_object' ? 'application/json' : undefined,
    };
    const candidates = geminiModelCandidates(requestedModel);
    let result;
    let modelName = candidates[0];
    let lastError;
    for (const candidate of candidates) {
      try {
        const model = client.getGenerativeModel({ model: candidate, generationConfig });
        result = await model.generateContent({ contents: [{ role: 'user', parts }] });
        modelName = candidate;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!isMissingModelError(error) && !isQuotaError(error)) throw error;
      }
    }
    if (!result) throw lastError || new Error('Gemini model is not configured for this operation.');
    const content = result?.response?.text?.() || '';
    return {
      provider: 'gemini',
      model: modelName,
      operation,
      raw: result,
      content,
      parsed: parseJsonContent(content),
      usage: {
        inputTokens: result?.response?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: result?.response?.usageMetadata?.candidatesTokenCount ?? null,
        totalTokens: result?.response?.usageMetadata?.totalTokenCount ?? null,
        prompt_tokens: result?.response?.usageMetadata?.promptTokenCount ?? null,
        completion_tokens: result?.response?.usageMetadata?.candidatesTokenCount ?? null,
        total_tokens: result?.response?.usageMetadata?.totalTokenCount ?? null,
      },
    };
  },
  async generateText(params) {
    return this.generateStructured(params);
  },
  async analyzeImages({ operation, request, context = {} }) {
    return this.generateStructured({ operation, request, context });
  },
});
