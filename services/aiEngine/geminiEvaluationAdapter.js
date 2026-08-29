import config from '../../config/env.js';
import { executeAIOperation } from './aiEngine.js';
import { AI_OPERATIONS } from './aiOperations.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const evaluateAnswerWithGemini = async ({
  question,
  correctAnswer,
  studentAnswer,
  questionType,
  points,
  rubric = [],
  evaluationConfig = {},
  tenantId,
  userId,
}) => {
  if (!config.geminiApiKey) {
    return {
      score: 0,
      pointsEarned: 0,
      isCorrect: false,
      confidence: 0,
      needsReview: true,
      feedback: 'AI evaluation provider is not configured.',
      provider: 'gemini',
      fallbackReason: 'GEMINI_API_KEY_MISSING',
      mode: 'provider_unavailable',
    };
  }
  const maxPoints = Number(points) || 0;
  const effectiveRubric = Array.isArray(rubric) ? rubric : [];
  const result = await executeAIOperation(
    AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION,
    {
      request: {
        system: 'You grade a student answer against the frozen question, reference answer, and rubric. Return strict JSON only with criterionScores[], totalScore, maxScore, overallConfidence, feedback, reviewRequired.',
        user: `Question type: ${questionType}
Question: ${question}
Reference answer: ${correctAnswer || 'None'}
Student answer: ${studentAnswer}
Maximum marks: ${maxPoints}
Rubric: ${JSON.stringify(effectiveRubric)}
Evaluation config: ${JSON.stringify(evaluationConfig || {})}`,
        response_format: { type: 'json_object' },
      },
    },
    { tenantId, userId, feature: 'evaluation' }
  );
  const parsed = result.parsed || {};
  const criterionScores = Array.isArray(parsed.criterionScores) ? parsed.criterionScores : [];
  const mappedScores = effectiveRubric.length
    ? effectiveRubric.map((entry) => {
        const candidate = criterionScores.find((item) => String(item.criterionId || item.criterion) === String(entry.criterion || entry.id || entry.key));
        const rawScore = Number(candidate?.score);
        const score = Number(clamp(Number.isFinite(rawScore) ? rawScore : 0, 0, entry.maxScore || maxPoints).toFixed(2));
        return {
          criterion: entry.criterion || entry.label || entry.key,
          score,
          maxScore: entry.maxScore || maxPoints,
          rationale: String(candidate?.reason || ''),
          confidence: Number(candidate?.confidence) || 0.5,
        };
      })
    : criterionScores;
  const computedTotal = mappedScores.reduce((sum, item) => sum + (Number(item.score) || 0), 0);
  const totalScore = Number.isFinite(Number(parsed.totalScore)) ? Number(parsed.totalScore) : computedTotal;
  const score = Number(clamp(totalScore, 0, maxPoints).toFixed(2));
  const confidence = Number(clamp(Number(parsed.overallConfidence) || 0.5, 0, 1).toFixed(3));
  return {
    score,
    pointsEarned: score,
    isCorrect: maxPoints > 0 ? score >= maxPoints * 0.6 : score > 0,
    confidence,
    needsReview: Boolean(parsed.reviewRequired) || confidence < 0.8,
    feedback: String(parsed.feedback || 'No feedback provided.'),
    rubricScores: mappedScores,
    rubricTotal: score,
    provider: 'gemini',
    model: result.model,
    mode: 'semantic_rubric',
    evaluationMethod: 'gemini_rubric',
  };
};
