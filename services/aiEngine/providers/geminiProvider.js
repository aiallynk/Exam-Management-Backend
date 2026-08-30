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
  AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
  AI_OPERATIONS.QUESTION_IMAGE_GENERATION,
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
    case AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE:
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

const RETIRED_GEMINI_MODELS = new Map([
  ['gemini-2.5-flash', 'gemini-3.1-flash-lite'],
  ['gemini-2.0-flash', 'gemini-3.1-flash-lite'],
  ['gemini-2.0-flash-lite', 'gemini-3.1-flash-lite'],
  ['gemini-3.1-flash', 'gemini-3.1-flash-lite'],
  ['gemini-3.6-flash', 'gemini-3.1-flash-lite'],
  ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
]);

const normalizeGeminiModelName = (model) => {
  const value = String(model || '').replace(/^models\//, '').trim();
  return RETIRED_GEMINI_MODELS.get(value) || value;
};

const geminiModelCandidates = (requested) => {
  const normalized = normalizeGeminiModelName(requested);
  const names = [
    normalized,
    process.env.GEMINI_FALLBACK_MODEL,
    config.geminiVisionModel,
    config.geminiEvaluationModel,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
  ].map((value) => normalizeGeminiModelName(String(value || '').replace(/^models\//, '').trim())).filter(Boolean);
  return [...new Set(names)];
};

const geminiImageModelCandidates = (requested) => {
  const names = [
    requested,
    config.geminiImageModel,
    'gemini-2.5-flash-image',
    'gemini-2.0-flash-preview-image-generation',
    process.env.GEMINI_FALLBACK_MODEL,
  ].map((value) => String(value || '').replace(/^models\//, '').trim()).filter(Boolean);
  return [...new Set(names)];
};

const extractInlineImageParts = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => part?.inlineData?.data)
    .map((part) => ({
      b64_json: part.inlineData.data,
      mimeType: part.inlineData.mimeType || 'image/png',
    }));
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

const dataUriToInlineData = (value) => {
  const url = String(value || '').trim();
  const match = url.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
};

const openAiContentToGeminiParts = (content) => {
  if (typeof content === 'string') {
    return content.trim() ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ text: String(content ?? '') }];
  }
  const parts = [];
  content.forEach((item) => {
    if (item?.type === 'text') {
      const text = String(item.text || '').trim();
      if (text) parts.push({ text });
      return;
    }
    if (item?.type === 'image_url') {
      const url = item?.image_url?.url || item?.image_url;
      const inlineData = dataUriToInlineData(url);
      if (inlineData) {
        parts.push({ inlineData });
      } else if (url) {
        parts.push({ text: `[image:${url}]` });
      }
    }
  });
  return parts;
};

const openAiMessagesToGeminiParts = (messages = []) => {
  const parts = [];
  messages.forEach((message) => {
    const role = String(message?.role || 'user').toLowerCase();
    const rolePrefix =
      role === 'system' ? 'System instructions:\n'
      : role === 'assistant' ? 'Assistant:\n'
      : '';
    const messageParts = openAiContentToGeminiParts(message?.content);
    if (!messageParts.length && rolePrefix) {
      parts.push({ text: rolePrefix.trim() });
      return;
    }
    messageParts.forEach((part, index) => {
      if (index === 0 && rolePrefix && part.text) {
        parts.push({ ...part, text: `${rolePrefix}${part.text}` });
      } else if (index === 0 && rolePrefix) {
        parts.push({ text: rolePrefix.trim() });
        parts.push(part);
      } else {
        parts.push(part);
      }
    });
  });
  return parts.length ? parts : [{ text: '' }];
};

const buildGeminiRequestParts = (request = {}) => {
  if (Array.isArray(request.messages) && request.messages.length) {
    return openAiMessagesToGeminiParts(request.messages);
  }
  const parts = [];
  if (request.system) parts.push({ text: String(request.system) });
  if (request.user) parts.push({ text: String(request.user) });
  if (Array.isArray(request.images)) {
    request.images.forEach((image) => {
      if (image?.inlineData) parts.push({ inlineData: image.inlineData });
      else if (image?.url) {
        const inlineData = dataUriToInlineData(image.url);
        if (inlineData) parts.push({ inlineData });
        else parts.push({ text: `[image:${image.url}]` });
      }
    });
  }
  return parts.length ? parts : [{ text: '' }];
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
        image: config.geminiImageModel,
      },
      checkedAt: health.checkedAt || null,
    };
  },
  async generateStructured({ operation, request, context = {} }) {
    const client = getGeminiClient();
    if (!client) throw new Error('Gemini is not configured.');
    const requestedModel = normalizeGeminiModelName(
      context.model || request.model || getModelForOperation(operation) || resolveModelName(operation)
    );
    if (!requestedModel) throw new Error('Gemini model is not configured for this operation.');
    const parts = buildGeminiRequestParts(request);
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
  async generateImage({ operation, request, context = {} }) {
    if (!config.geminiApiKey) throw new Error('Gemini is not configured.');
    const requestedModel = context.model || request?.model || getModelForOperation(operation) || config.geminiImageModel;
    const prompt = String(request?.prompt || request?.contents || '').trim();
    if (!prompt) throw new Error('Image generation prompt is required.');

    const candidates = geminiImageModelCandidates(requestedModel);
    let payload = null;
    let modelName = candidates[0];
    let lastError = null;

    for (const candidate of candidates) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
              },
            }),
          }
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = body?.error?.message || `Gemini image generation failed (${response.status}).`;
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }
        payload = body;
        modelName = candidate;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!isMissingModelError(error) && !isQuotaError(error)) throw error;
      }
    }
    if (!payload) throw lastError || new Error('Gemini image model is not configured.');

    const images = extractInlineImageParts(payload);
    if (!images.length) {
      throw new Error('Gemini image generation returned no image payload.');
    }

    const usageMetadata = payload?.usageMetadata || {};
    return {
      provider: 'gemini',
      model: modelName,
      operation,
      raw: {
        data: images,
        model: modelName,
        usageMetadata,
      },
      images,
      usage: {
        inputTokens: usageMetadata.promptTokenCount ?? null,
        outputTokens: usageMetadata.candidatesTokenCount ?? null,
        totalTokens: usageMetadata.totalTokenCount ?? null,
        prompt_tokens: usageMetadata.promptTokenCount ?? 0,
        completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
        total_tokens: usageMetadata.totalTokenCount ?? 0,
        imageCount: images.length,
      },
    };
  },
});
