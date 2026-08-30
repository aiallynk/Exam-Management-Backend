import config from '../../config/env.js';
import { executeAIOperation } from './aiEngine.js';
import { AI_OPERATIONS } from './aiOperations.js';
import {
  buildCriterionReferenceKeys,
  computeWeightedQuestionScore,
  migrateLegacyCriteriaToWeights,
} from '../offlineEvaluation/rubricWeightService.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const STRICT_RUBRIC_INSTRUCTION = `Evaluate only against the supplied question, expected-answer guidance, and rubric.
Do not introduce additional criteria.
Do not reward or penalize for characteristics that are not represented in the supplied marking guidance/rubric unless an existing platform policy explicitly requires them.
Return achievement percentages (0-100) per criterion reference key — do NOT invent final question marks.
The application computes weighted contributions deterministically.`;

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
  qualityTier = 'STANDARD',
  model,
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
      rubricEvaluationFailed: true,
    };
  }
  const maxPoints = Number(points) || 0;
  const configuredRubric = Array.isArray(evaluationConfig?.rubric) && evaluationConfig.rubric.length
    ? evaluationConfig.rubric
    : rubric;
  const { criteria: weightedCriteria } = migrateLegacyCriteriaToWeights(configuredRubric);
  const criterionRefs = buildCriterionReferenceKeys(weightedCriteria);
  const result = await executeAIOperation(
    AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION,
    {
      request: {
        system: `${STRICT_RUBRIC_INSTRUCTION}

Return strict JSON only:
{
  "questionId": "optional",
  "rubricEvaluation": [
    {
      "criterionRef": "criterion_1",
      "achievementPercentage": number,
      "level": "Excellent|Good|Developing|Beginning|No Evidence",
      "justification": "brief evidence-based rationale",
      "evidenceText": "optional quoted phrase from student answer"
    }
  ],
  "findings": [
    { "type": "CORRECT|INCORRECT|PARTIAL|MISSING|IRRELEVANT|UNCLEAR", "description": "...", "evidenceText": "..." }
  ],
  "overallFeedback": "short actionable feedback",
  "confidence": "HIGH|MEDIUM|LOW",
  "reviewRequired": boolean
}`,
        user: `Question type: ${questionType}
Question: ${question}
Reference / marking guidance: ${correctAnswer || 'None'}
Student answer: ${studentAnswer}
Maximum marks: ${maxPoints}
Quality tier: ${qualityTier}
Evaluation config: ${JSON.stringify(evaluationConfig || {})}
Criterion references (use criterionRef exactly): ${JSON.stringify(criterionRefs)}`,
        response_format: { type: 'json_object' },
      },
    },
    { tenantId, userId, feature: 'evaluation', ...(model ? { model } : {}) },
  );

  const parsed = result.parsed || {};
  const confidenceLabel = String(parsed.confidence || parsed.overallConfidence || 'MEDIUM').toUpperCase();
  const confidenceNumeric = confidenceLabel === 'HIGH' ? 0.9 : confidenceLabel === 'LOW' ? 0.45 : 0.7;
  const rubricEvaluation = Array.isArray(parsed.rubricEvaluation) ? parsed.rubricEvaluation : [];
  const legacyCriterionScores = Array.isArray(parsed.criterionScores) ? parsed.criterionScores : [];

  let weighted = { valid: false, total: 0, entries: [], reason: 'RUBRIC_EVALUATION_FAILED' };
  if (criterionRefs.length) {
    const achievements = rubricEvaluation.length
      ? rubricEvaluation
      : legacyCriterionScores.map((item) => ({
        criterionRef: item.criterionRef || item.criterionId || item.criterion,
        achievementPercentage: item.maxScore > 0
          ? clamp((Number(item.score) / Number(item.maxScore)) * 100, 0, 100)
          : Number(item.score),
        level: item.level,
        justification: item.reason || item.rationale,
      }));
    weighted = computeWeightedQuestionScore({
      questionMaxMarks: maxPoints,
      criteria: weightedCriteria,
      achievements,
      strictCriterionRefs: true,
    });
  }

  if (!weighted.valid && criterionRefs.length) {
    return {
      score: 0,
      pointsEarned: 0,
      isCorrect: false,
      confidence: confidenceNumeric,
      needsReview: true,
      feedback: 'Rubric assessment unavailable — review required.',
      rubricScores: [],
      rubricTotal: 0,
      provider: 'gemini',
      model: result.model,
      mode: 'semantic_rubric',
      evaluationMethod: 'gemini_rubric',
      rubricEvaluationFailed: true,
      rubricFailureReason: weighted.reason,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  }

  const mappedScores = weighted.entries.map((entry) => ({
    key: entry.key,
    criterion: entry.criterion,
    weight: entry.weightPercentage,
    weightPercentage: entry.weightPercentage,
    achievementPercentage: entry.achievementPercentage,
    score: entry.contribution,
    marks: entry.contribution,
    maxScore: entry.maxContribution,
    maxMarks: entry.maxContribution,
    rationale: entry.justification,
    level: entry.level,
  }));
  const score = weighted.valid
    ? Number(clamp(weighted.total, 0, maxPoints).toFixed(2))
    : Number(clamp(Number(parsed.totalScore) || 0, 0, maxPoints).toFixed(2));

  return {
    score,
    pointsEarned: score,
    isCorrect: maxPoints > 0 ? score >= maxPoints * 0.6 : score > 0,
    confidence: confidenceNumeric,
    needsReview: Boolean(parsed.reviewRequired) || confidenceLabel === 'LOW' || confidenceNumeric < 0.8,
    feedback: String(parsed.overallFeedback || parsed.feedback || 'No feedback provided.'),
    rubricScores: mappedScores,
    rubricTotal: score,
    provider: 'gemini',
    model: result.model,
    mode: 'semantic_rubric',
    evaluationMethod: 'gemini_rubric',
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    rubricEvaluationFailed: false,
  };
};
