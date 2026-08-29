import config from '../../config/env.js';
import { logError } from '../../utils/logger.js';
import { executeAIOperation } from '../aiEngine/aiEngine.js';
import { AI_OPERATIONS } from '../aiEngine/aiOperations.js';
import { imageUrlToGeminiInlinePart } from '../aiEngine/imagePayload.js';

// The OCR/handwriting/vision provider boundary — now routed through the
// multi-provider AI engine (Master Phase 7). Handwriting extraction and
// diagram/vision rubric scoring default to Gemini; OpenAI is no longer
// the implicit provider for answer-script intelligence.

export const isVisionProviderConfigured = () => Boolean(config.geminiApiKey) || Boolean(config.openaiApiKey);

const SYSTEM_PROMPT = `You transcribe one page of a candidate's handwritten or printed exam answer sheet.
Identify each distinct answer on the page by the question number written or printed next to it (e.g. "1", "2", "3(a)", "Q4"). A page may contain zero, one, or several answers, and an answer may continue from a previous page (in which case it has no visible question number at the top — mark detectedQuestionNumber as null for that continuation and note it in a "continuesFromPrevious": true field).
Return strict JSON: {
  "isBlank": boolean,
  "segments": [ { "detectedQuestionNumber": string|null, "continuesFromPrevious": boolean, "text": string, "confidence": number (0-1, your honest confidence this transcription is accurate) } ],
  "pageConfidence": number (0-1, overall confidence in this page's transcription)
}
Transcribe faithfully — do not correct spelling/grammar, do not invent content you cannot read, and do not guess a question number you cannot actually see. If handwriting is illegible, set confidence low for that segment rather than fabricating plausible-sounding text.`;

export const extractPageContent = async ({ imageUrl, tenantId, userId, examId, answerScriptId, pageNumber }) => {
  if (!config.geminiApiKey) {
    return { available: false, segments: [], isBlank: false, pageConfidence: 0, error: 'AI vision provider is not configured on this deployment (missing GEMINI_API_KEY).' };
  }
  const inlineImage = imageUrlToGeminiInlinePart(imageUrl);
  if (!inlineImage) {
    return { available: false, segments: [], isBlank: false, pageConfidence: 0, error: 'Unsupported image payload for vision extraction.' };
  }
  try {
    const result = await executeAIOperation(
      AI_OPERATIONS.HANDWRITING_EXTRACTION,
      {
        request: {
          system: SYSTEM_PROMPT,
          user: `Transcribe this answer-sheet page (page ${pageNumber || '?'}).`,
          images: [inlineImage],
          response_format: { type: 'json_object' },
        },
      },
      { tenantId, userId, feature: 'offline_answer_script_ocr', examId, answerScriptId, pageNumber }
    );
    const parsed = result.parsed || {};
    const segments = Array.isArray(parsed.segments) ? parsed.segments.map((segment) => ({
      detectedQuestionNumber: segment.detectedQuestionNumber ? String(segment.detectedQuestionNumber).trim() : null,
      continuesFromPrevious: Boolean(segment.continuesFromPrevious),
      text: String(segment.text || '').trim(),
      confidence: Number.isFinite(Number(segment.confidence)) ? Math.max(0, Math.min(1, Number(segment.confidence))) : 0.4,
    })) : [];
    return {
      available: true,
      segments,
      isBlank: Boolean(parsed.isBlank),
      pageConfidence: Number.isFinite(Number(parsed.pageConfidence)) ? Math.max(0, Math.min(1, Number(parsed.pageConfidence))) : 0.4,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    logError(error, { context: 'documentVisionProvider.extractPageContent', tenantId, examId, answerScriptId, pageNumber });
    return { available: true, segments: [], isBlank: false, pageConfidence: 0, error: error.message || 'Vision extraction failed.', provider: 'gemini' };
  }
};

// DIAGRAM/IMAGE RESPONSE routing (Part I) — scores a candidate's drawn/
// diagram answer directly against rubric criteria from the page image,
// mirroring aiService.evaluateAnswer's rubric output shape (rubricScores/
// rubricTotal/confidence) so the rest of the pipeline (attemptMaterialization,
// the existing evaluator review UI) treats it identically regardless of
// whether the score came from text or vision. Only called when a rubric
// actually exists on the question — with no rubric, the Evaluation Router
// routes to mandatory human review instead of guessing a total.
export const evaluateDiagramResponse = async ({ imageUrl, questionText, rubric, maxMarks, tenantId, userId, examId, answerScriptId }) => {
  if (!config.geminiApiKey) {
    return { available: false, rubricScores: null, pointsEarned: 0, confidence: 0, error: 'AI vision provider is not configured on this deployment (missing GEMINI_API_KEY).' };
  }
  if (!Array.isArray(rubric) || !rubric.length) {
    return { available: true, rubricScores: null, pointsEarned: 0, confidence: 0, error: 'No rubric is attached to this question — cannot score a diagram response without one.' };
  }
  const inlineImage = imageUrlToGeminiInlinePart(imageUrl);
  if (!inlineImage) {
    return { available: false, rubricScores: null, pointsEarned: 0, confidence: 0, error: 'Unsupported image payload for vision rubric scoring.' };
  }
  try {
    const criteriaList = rubric.map((criterion) => `- ${criterion.label || criterion.key} (max ${criterion.maxMarks} marks)`).join('\n');
    const result = await executeAIOperation(
      AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION,
      {
        request: {
          system: `You evaluate a candidate's hand-drawn diagram/visual answer against a marking rubric. Question: "${questionText}". Rubric criteria:\n${criteriaList}\nScore each criterion honestly based only on what is visible in the image. Return strict JSON: {"criteria": [{"key": string, "marks": number, "comment": string}], "confidence": number (0-1)}.`,
          user: 'Score this diagram/visual response against the rubric.',
          images: [inlineImage],
          response_format: { type: 'json_object' },
        },
      },
      { tenantId, userId, feature: 'offline_answer_script_vision_rubric', examId, answerScriptId }
    );
    const parsed = result.parsed || {};
    const scoredCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
    const rubricScores = rubric.map((criterion) => {
      const scored = scoredCriteria.find((entry) => entry.key === criterion.key) || {};
      const marks = Math.max(0, Math.min(Number(criterion.maxMarks) || 0, Number(scored.marks) || 0));
      return { key: criterion.key, label: criterion.label, maxMarks: criterion.maxMarks, marks, comment: String(scored.comment || '') };
    });
    const pointsEarned = rubricScores.reduce((sum, entry) => sum + entry.marks, 0);
    const confidence = Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0.4;
    return { available: true, rubricScores, pointsEarned: Math.min(pointsEarned, maxMarks ?? pointsEarned), confidence, model: result.model, provider: result.provider };
  } catch (error) {
    logError(error, { context: 'documentVisionProvider.evaluateDiagramResponse', tenantId, examId, answerScriptId });
    return { available: true, rubricScores: null, pointsEarned: 0, confidence: 0, error: error.message, provider: 'gemini' };
  }
};

// A lighter-weight pass specifically for the roll-number/candidate-ID
// region a script's first page typically carries — used by candidate
// mapping (Part E) as an assist signal, never an auto-confirm.
export const extractCandidateIdentifiers = async ({ imageUrl, tenantId, userId }) => {
  if (!config.geminiApiKey) {
    return { available: false, rollNumber: '', candidateName: '', confidence: 0 };
  }
  const inlineImage = imageUrlToGeminiInlinePart(imageUrl);
  if (!inlineImage) return { available: false, rollNumber: '', candidateName: '', confidence: 0 };
  try {
    const result = await executeAIOperation(
      AI_OPERATIONS.ANSWER_SCRIPT_VISION,
      {
        request: {
          system: 'You read the identification header of an exam answer sheet (roll number / candidate ID and, if present, printed or handwritten name). Return strict JSON: {"rollNumber": string, "candidateName": string, "confidence": number 0-1}. Leave a field empty string if not visible — never guess.',
          user: 'Read the roll number / candidate ID and name from this page.',
          images: [inlineImage],
          response_format: { type: 'json_object' },
        },
      },
      { tenantId, userId, feature: 'offline_answer_script_identification' }
    );
    const parsed = result.parsed || {};
    return {
      available: true,
      rollNumber: String(parsed.rollNumber || '').trim(),
      candidateName: String(parsed.candidateName || '').trim(),
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0,
      provider: result.provider,
    };
  } catch (error) {
    logError(error, { context: 'documentVisionProvider.extractCandidateIdentifiers', tenantId });
    return { available: true, rollNumber: '', candidateName: '', confidence: 0, error: error.message };
  }
};
