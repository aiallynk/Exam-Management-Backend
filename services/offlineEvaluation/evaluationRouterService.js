import { evaluateAnswer } from '../aiService.js';
import { canScoreDeterministically, scoreDeterministic } from './deterministicOfflineScorer.js';
import { evaluateDiagramResponse } from './documentVisionProvider.js';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';
import { evaluateGeneralAnswer } from './generalAiEvaluationService.js';
import { resolveEvaluationStrategy } from './evaluationStrategyResolver.js';
import config from '../../config/env.js';
import { getDefaultEvaluationProvider } from '../aiEngine/aiConfigService.js';

const VISION_RUBRIC_TYPES = ['DIAGRAM', 'IMAGE_BASED', 'IMAGE_RESPONSE'];
const NON_AI_HUMAN_ONLY_TYPES = ['CODING', 'PRACTICAL', 'VIVA'];
const SUBJECTIVE_AI_TYPES = ['SHORT_ANSWER', 'PARAGRAPH', 'ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY', 'FILL_IN_THE_BLANK_LONG'];

const composeConfidence = (...values) => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return Number(finite.reduce((min, value) => Math.min(min, value), 1).toFixed(3));
};

const evaluationFailure = ({ reason, confidence = 0, rubricConfigured = false }) => ({
  evaluationMethod: rubricConfigured ? 'RUBRIC_REVIEW_REQUIRED' : 'AI_EVALUATION_FAILED',
  scoringMode: 'EVALUATION_FAILED', aiEvaluationStatus: 'FAILED', aiProposedScore: null,
  finalScore: null, scoreResolved: false, requiresReview: true,
  isCorrect: undefined, pointsEarned: null, confidence, needsReview: true, reason,
});

const blankProposal = ({ strategy, confidence, maxMarks }) => ({
  evaluationMethod: strategy.scoringMode === 'RUBRIC_BASED' ? 'RUBRIC_BLANK_REVIEW_REQUIRED' : 'AI_GENERAL_PROVISIONAL',
  scoringMode: strategy.scoringMode === 'RUBRIC_BASED' ? 'RUBRIC_BASED' : 'AI_GENERAL_PROVISIONAL',
  aiEvaluationStatus: 'NOT_RUN', aiProposedScore: 0, aiConfidence: confidence,
  evaluatorDecision: 'PENDING', finalScore: null, scoreResolved: false, requiresReview: true,
  answerStatus: 'NOT_ATTEMPTED', isCorrect: false, pointsEarned: null, confidence, needsReview: true,
  feedback: 'No response was detected. Proposed score: 0; evaluator confirmation is required.',
  aiEvaluation: {
    proposedScore: 0, maxScore: maxMarks, notAttempted: true,
    feedback: 'No response was detected. Proposed score: 0; evaluator confirmation is required.',
    requirements: [], findings: [],
  },
  reason: 'No response was detected; evaluator confirmation is required for this handwritten answer.',
});

const rubricEvaluationFailed = (result, rubric) => (
  !result
  || result.rubricEvaluationFailed
  || Boolean(result.fallbackReason)
  || !Number.isFinite(Number(result.pointsEarned))
  || !Array.isArray(result.rubricScores)
  || result.rubricScores.length !== rubric.criteria.length
);

const resolveQualityRouting = ({ question, questionType, extractionConfidence, mappingConfidence }) => {
  const configuredTier = String(question?.evaluationConfig?.aiQualityTier || '').toUpperCase();
  const highAccuracy = configuredTier === 'HIGH'
    || ['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY', 'PARAGRAPH'].includes(questionType)
    || Boolean(question?.evaluationConfig?.highStakes)
    || Math.min(Number(extractionConfidence) || 1, Number(mappingConfidence) || 1) < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE;
  return {
    qualityTier: highAccuracy ? 'HIGH' : 'STANDARD',
    model: highAccuracy && getDefaultEvaluationProvider() === 'gemini'
      ? config.geminiHighAccuracyEvaluationModel
      : undefined,
  };
};

// The one offline evaluator dispatcher. It owns policy selection only; the
// deterministic scorer, strict rubric evaluator, and general AI evaluator
// remain separate implementations so their output schemas cannot drift.
export const routeAndEvaluate = async ({ question, extractedText, extractionConfidence, mappingConfidence, pageImageUrl, tenantId, userId, examId, answerScriptId }) => {
  const questionType = String(question?.questionType || '').toUpperCase();
  const baseConfidence = composeConfidence(extractionConfidence, mappingConfidence);
  const strategy = resolveEvaluationStrategy(question);
  const maxMarks = Math.max(Number(question?.points) || 0, 0);
  const qualityRouting = resolveQualityRouting({ question, questionType, extractionConfidence, mappingConfidence });

  if (VISION_RUBRIC_TYPES.includes(questionType)) {
    if (strategy.scoringMode === 'EVALUATION_FAILED') {
      return evaluationFailure({ reason: 'The configured rubric is invalid and must be corrected or reviewed manually.', confidence: baseConfidence, rubricConfigured: true });
    }
    if (!pageImageUrl || strategy.scoringMode !== 'RUBRIC_BASED') {
      return {
        evaluationMethod: 'MANUAL_REQUIRED', scoringMode: 'MANUAL', aiEvaluationStatus: 'NOT_RUN',
        finalScore: null, scoreResolved: false, requiresReview: true, isCorrect: false, pointsEarned: null,
        confidence: baseConfidence, needsReview: true,
        reason: strategy.rubric.configured ? 'Source page image unavailable for rubric evaluation.' : 'This visual response has no rubric and requires evaluator marking.',
      };
    }
    try {
      const visionResult = await evaluateDiagramResponse({ imageUrl: pageImageUrl, questionText: question.questionText, rubric: strategy.rubric.criteria, maxMarks, tenantId, userId, examId, answerScriptId });
      if (!visionResult.available || visionResult.error) {
        return evaluationFailure({ reason: visionResult.error || 'Rubric evaluation could not be completed.', confidence: 0, rubricConfigured: true });
      }
      const confidence = composeConfidence(baseConfidence, visionResult.confidence);
      const requiresReview = confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE;
      return {
        evaluationMethod: 'AI_VISION_RUBRIC', scoringMode: 'RUBRIC_BASED',
        aiEvaluationStatus: requiresReview ? 'LOW_CONFIDENCE' : 'SUCCESS', aiProposedScore: visionResult.pointsEarned, aiConfidence: confidence,
        evaluatorDecision: requiresReview ? 'PENDING' : undefined, finalScore: requiresReview ? null : visionResult.pointsEarned,
        scoreResolved: !requiresReview, requiresReview, isCorrect: visionResult.pointsEarned >= maxMarks,
        pointsEarned: requiresReview ? null : visionResult.pointsEarned, confidence, rubricScores: visionResult.rubricScores,
        needsReview: requiresReview, reason: requiresReview ? 'Vision rubric scoring confidence is below the review threshold.' : '',
      };
    } catch (error) {
      return evaluationFailure({ reason: 'Rubric evaluation could not be completed. Retry it or evaluate manually.', confidence: 0, rubricConfigured: true });
    }
  }

  if (NON_AI_HUMAN_ONLY_TYPES.includes(questionType)) {
    return {
      evaluationMethod: 'MANUAL_REQUIRED', scoringMode: 'MANUAL', aiEvaluationStatus: 'NOT_RUN',
      finalScore: null, scoreResolved: false, requiresReview: true, isCorrect: false, pointsEarned: null,
      confidence: baseConfidence, needsReview: true,
      reason: `${questionType} responses require human evaluation — not auto-evaluable from a scanned page.`,
    };
  }

  if (canScoreDeterministically(questionType)) {
    const result = scoreDeterministic({ question, extractedText });
    const confidence = composeConfidence(baseConfidence, result.confidence);
    const requiresReview = confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE;
    return {
      ...result, scoringMode: 'DETERMINISTIC', aiEvaluationStatus: 'NOT_RUN',
      finalScore: result.pointsEarned, scoreResolved: true, requiresReview,
      confidence, needsReview: requiresReview,
      reason: requiresReview ? 'Low OCR/mapping confidence on an otherwise deterministic answer type.' : '',
    };
  }

  if (strategy.scoringMode === 'EVALUATION_FAILED') {
    return evaluationFailure({
      reason: 'Rubric evaluation could not be completed because the configured rubric is invalid. Retry after correcting the rubric or evaluate manually.',
      confidence: baseConfidence, rubricConfigured: true,
    });
  }

  if (!String(extractedText || '').trim()) {
    if (strategy.scoringMode === 'RUBRIC_BASED' || strategy.scoringMode === 'AI_GENERAL_PROVISIONAL') {
      return blankProposal({ strategy, confidence: baseConfidence, maxMarks });
    }
    return {
      evaluationMethod: 'MANUAL_REQUIRED', scoringMode: 'MANUAL', aiEvaluationStatus: 'NOT_RUN',
      finalScore: null, scoreResolved: false, requiresReview: true, answerStatus: 'NOT_ATTEMPTED',
      isCorrect: false, pointsEarned: null, confidence: baseConfidence, needsReview: true,
      reason: 'No text was extracted for this answer.',
    };
  }

  if (strategy.scoringMode === 'AI_GENERAL_PROVISIONAL' && SUBJECTIVE_AI_TYPES.includes(questionType)) {
    try {
      const general = await evaluateGeneralAnswer({
        question: question.questionText, correctAnswer: question.correctAnswer, studentAnswer: extractedText,
        questionType, points: maxMarks, evaluationConfig: question.evaluationConfig || {}, tenantId, userId,
        ...qualityRouting,
      });
      const confidence = composeConfidence(baseConfidence, general.confidence);
      return {
        evaluationMethod: 'AI_GENERAL_PROVISIONAL', scoringMode: 'AI_GENERAL_PROVISIONAL',
        aiEvaluationStatus: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE ? 'LOW_CONFIDENCE' : 'SUCCESS',
        aiProposedScore: general.proposedScore, aiConfidence: confidence, evaluatorDecision: 'PENDING',
        finalScore: null, scoreResolved: false, requiresReview: true,
        isCorrect: undefined, pointsEarned: null, confidence, needsReview: true, feedback: general.feedback,
        aiEvaluation: { ...general, pointsEarned: general.proposedScore, maxScore: maxMarks },
        reason: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE
          ? 'General AI assessment has low combined OCR/mapping/AI confidence; evaluator review is required.'
          : 'No rubric was configured. The AI score is a proposal and requires evaluator approval.',
      };
    } catch (error) {
      return evaluationFailure({ reason: 'General AI assessment could not be completed. Evaluate manually or retry the AI evaluation.', confidence: baseConfidence });
    }
  }

  if (strategy.scoringMode === 'RUBRIC_BASED' && SUBJECTIVE_AI_TYPES.includes(questionType)) {
    try {
      const aiResult = await evaluateAnswer({
        question: question.questionText, correctAnswer: question.correctAnswer, studentAnswer: extractedText,
        questionType: questionType.toLowerCase(), points: maxMarks, rubric: strategy.rubric.criteria,
        rubricScoringEnabled: true, evaluationConfig: { ...(question.evaluationConfig || {}), rubric: strategy.rubric.criteria },
        tenantId, userId, metadata: { source: 'offline_answer_script', examId, answerScriptId }, ...qualityRouting,
      });
      if (rubricEvaluationFailed(aiResult, strategy.rubric)) {
        return evaluationFailure({ reason: 'Rubric evaluation could not be completed. The configured rubric was not bypassed; retry it or evaluate manually.', confidence: baseConfidence, rubricConfigured: true });
      }
      const confidence = composeConfidence(baseConfidence, aiResult.confidence);
      const requiresReview = confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE || Boolean(aiResult.needsReview);
      const score = Number(aiResult.pointsEarned);
      return {
        evaluationMethod: 'AI_RUBRIC', scoringMode: 'RUBRIC_BASED',
        aiEvaluationStatus: requiresReview ? 'LOW_CONFIDENCE' : 'SUCCESS', aiProposedScore: score, aiConfidence: confidence,
        evaluatorDecision: requiresReview ? 'PENDING' : undefined, finalScore: requiresReview ? null : score,
        scoreResolved: !requiresReview, requiresReview, isCorrect: aiResult.isCorrect,
        pointsEarned: requiresReview ? null : score, confidence, rubricScores: aiResult.rubricScores || [],
        feedback: aiResult.feedback || '', aiEvaluation: aiResult, needsReview: requiresReview,
        reason: requiresReview ? 'Rubric assessment requires evaluator review.' : '',
      };
    } catch (error) {
      return evaluationFailure({ reason: 'Rubric evaluation could not be completed. The configured rubric was not bypassed; retry it or evaluate manually.', confidence: baseConfidence, rubricConfigured: true });
    }
  }

  return {
    evaluationMethod: 'MANUAL_REQUIRED', scoringMode: 'MANUAL', aiEvaluationStatus: 'NOT_RUN',
    finalScore: null, scoreResolved: false, requiresReview: true, isCorrect: false, pointsEarned: null,
    confidence: baseConfidence, needsReview: true,
    reason: `${questionType || 'This response type'} is not yet auto-evaluable offline — routed to mandatory human review.`,
  };
};
