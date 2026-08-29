import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../../config/env.js';
import { AI_OPERATIONS } from '../aiOperations.js';

const SUPPORTED = new Set([
  AI_OPERATIONS.HANDWRITING_EXTRACTION,
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

const getGeminiClient = () => {
  if (!config.geminiApiKey) return null;
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(config.geminiApiKey);
  return geminiClient;
};

const resolveModelName = (operation) => {
  switch (operation) {
    case AI_OPERATIONS.HANDWRITING_EXTRACTION:
      return config.geminiHandwritingModel || config.geminiVisionModel || config.geminiEvaluationModel;
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
    const configured = Boolean(config.geminiApiKey);
    return {
      configured,
      status: configured ? 'CONFIGURED' : 'UNAVAILABLE',
      models: {
        evaluation: config.geminiEvaluationModel,
        vision: config.geminiVisionModel,
        handwriting: config.geminiHandwritingModel,
        feedback: config.geminiFeedbackModel,
      },
    };
  },
  async generateStructured({ operation, request, context = {} }) {
    const client = getGeminiClient();
    if (!client) throw new Error('Gemini is not configured.');
    const modelName = context.model || resolveModelName(operation);
    if (!modelName) throw new Error('Gemini model is not configured for this operation.');
    const model = client.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: request?.temperature ?? 0.1,
        responseMimeType: request?.response_format?.type === 'json_object' ? 'application/json' : undefined,
      },
    });
    const parts = [];
    if (request?.system) parts.push({ text: String(request.system) });
    if (request?.user) parts.push({ text: String(request.user) });
    if (Array.isArray(request?.images)) {
      request.images.forEach((image) => {
        if (image?.inlineData) parts.push({ inlineData: image.inlineData });
        else if (image?.url) parts.push({ text: `[image:${image.url}]` });
      });
    }
    const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
    const content = result?.response?.text?.() || '';
    return {
      provider: 'gemini',
      model: modelName,
      operation,
      raw: result,
      content,
      parsed: parseJsonContent(content),
      usage: {
        inputTokens: result?.response?.usageMetadata?.promptTokenCount,
        outputTokens: result?.response?.usageMetadata?.candidatesTokenCount,
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
