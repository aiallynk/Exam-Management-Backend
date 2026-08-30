import { evaluateAnswer } from '../aiService.js';
import { canScoreDeterministically, scoreDeterministic } from './deterministicOfflineScorer.js';
import { evaluateDiagramResponse } from './documentVisionProvider.js';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';

const VISION_RUBRIC_TYPES = ['DIAGRAM', 'IMAGE_BASED', 'IMAGE_RESPONSE'];

// Part I — THE ONE evaluation router. Input: a frozen Question, the
// extracted answer text, its extraction/mapping confidence, and (for
// subjective types) the question's evaluationConfig/rubric. Output: a
// normalized evaluation result plus the chosen path, for
// attemptMaterializationService to write into a real Answer document.
//
// This module owns ROUTING only — it never re-implements scoring. It
// dispatches to deterministicOfflineScorer.js (existing-pattern objective
// scoring) or aiService.evaluateAnswer (the existing, unmodified semantic/
// rubric grader) exactly as both already work for online answers.

const NON_AI_HUMAN_ONLY_TYPES = ['CODING', 'PRACTICAL', 'VIVA'];
const SUBJECTIVE_AI_TYPES = ['SHORT_ANSWER', 'PARAGRAPH', 'ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY', 'FILL_IN_THE_BLANK_LONG'];

const composeConfidence = (...values) => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return Number(finite.reduce((min, value) => Math.min(min, value), 1).toFixed(3)); // the weakest link, not an average — one bad signal should pull the whole thing down
};

export const routeAndEvaluate = async ({ question, extractedText, extractionConfidence, mappingConfidence, pageImageUrl, tenantId, userId, examId, answerScriptId }) => {
  const questionType = String(question?.questionType || '').toUpperCase();
  const baseConfidence = composeConfidence(extractionConfidence, mappingConfidence);

  if (VISION_RUBRIC_TYPES.includes(questionType)) {
    const rubric = Array.isArray(question?.evaluationConfig?.rubric) ? question.evaluationConfig.rubric : [];
    if (!pageImageUrl || !rubric.length) {
      return { evaluationMethod: 'MANUAL_REQUIRED', isCorrect: false, pointsEarned: 0, confidence: baseConfidence, needsReview: true, reason: !rubric.length ? 'No rubric is attached to this diagram question — cannot auto-score.' : 'Source page image unavailable for vision scoring.' };
    }
    const visionResult = await evaluateDiagramResponse({ imageUrl: pageImageUrl, questionText: question.questionText, rubric, maxMarks: question.points, tenantId, userId, examId, answerScriptId });
    if (!visionResult.available || visionResult.error) {
      return { evaluationMethod: 'MANUAL_REQUIRED', isCorrect: false, pointsEarned: 0, confidence: 0, needsReview: true, reason: visionResult.error || 'Vision rubric scoring unavailable.' };
    }
    const confidence = composeConfidence(baseConfidence, visionResult.confidence);
    return {
      evaluationMethod: 'AI_VISION_RUBRIC',
      isCorrect: visionResult.pointsEarned >= (Number(question.points) || 0),
      pointsEarned: visionResult.pointsEarned,
      confidence,
      rubricScores: visionResult.rubricScores,
      needsReview: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE,
      reason: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE ? 'Vision rubric scoring confidence below the review threshold.' : '',
    };
  }

  if (!String(extractedText || '').trim()) {
    return { evaluationMethod: 'MANUAL_REQUIRED', isCorrect: false, pointsEarned: 0, confidence: 0, needsReview: true, reason: 'No text was extracted for this answer.' };
  }

  if (NON_AI_HUMAN_ONLY_TYPES.includes(questionType)) {
    return { evaluationMethod: 'MANUAL_REQUIRED', isCorrect: false, pointsEarned: 0, confidence: baseConfidence, needsReview: true, reason: `${questionType} responses require human evaluation — not auto-evaluable from a scanned page.` };
  }

  if (canScoreDeterministically(questionType)) {
    const result = scoreDeterministic({ question, extractedText });
    const confidence = composeConfidence(baseConfidence, result.confidence);
    return {
      ...result,
      confidence,
      needsReview: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE,
      reason: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE ? 'Low OCR/mapping confidence on an otherwise deterministic answer type.' : '',
    };
  }

  if (SUBJECTIVE_AI_TYPES.includes(questionType) || questionType === 'SHORT_ANSWER') {
    const rubric = Array.isArray(question?.evaluationConfig?.rubric) ? question.evaluationConfig.rubric : [];
    try {
      const aiResult = await evaluateAnswer({
        question: question.questionText,
        correctAnswer: question.correctAnswer,
        studentAnswer: extractedText,
        questionType: questionType.toLowerCase(),
        points: question.points,
        rubric,
        rubricScoringEnabled: rubric.length > 0,
        evaluationConfig: question.evaluationConfig || {},
        tenantId,
        userId,
        metadata: { source: 'offline_answer_script', examId, answerScriptId },
      });
      if (aiResult?.provider === 'fallback' && aiResult?.fallbackReason === 'OPENAI_EVALUATION_ERROR') {
        throw Object.assign(new Error('The configured AI evaluation provider failed temporarily.'), { code: 'AI_PROVIDER_TRANSIENT' });
      }
      const confidence = composeConfidence(baseConfidence, aiResult.confidence);
      return {
        evaluationMethod: 'AI_SEMANTIC',
        isCorrect: aiResult.isCorrect,
        pointsEarned: aiResult.pointsEarned,
        confidence,
        rubricScores: aiResult.rubricScores || null,
        feedback: aiResult.feedback || '',
        aiEvaluation: aiResult,
        needsReview: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE || Boolean(aiResult.needsReview),
        reason: confidence < offlineEvaluationConfig.EVALUATION_MEDIUM_CONFIDENCE ? 'Combined OCR/mapping/AI confidence below the review threshold.' : '',
      };
    } catch (error) {
      if (error?.code === 'AI_PROVIDER_TRANSIENT') throw error;
      if (/quota|429|rate-limit|rate limit/i.test(String(error?.message || ''))) {
        throw Object.assign(new Error('The evaluation provider is temporarily rate-limited.'), { code: 'AI_PROVIDER_TRANSIENT' });
      }
      return { evaluationMethod: 'MANUAL_REQUIRED', isCorrect: false, pointsEarned: 0, confidence: 0, needsReview: true, reason: 'Subjective evaluation could not be completed automatically. An evaluator can mark this answer.' };
    }
  }

  // Anything else unrecognized (mathematical proofs/derivations, novel
  // question types): no vetted evaluator exists for it — mandatory human
  // review rather than a fabricated score, per the brief's explicit
  // prohibition on claiming symbolic/mathematical equivalence capability
  // that isn't real.
  return { evaluationMethod: 'MANUAL_REQUIRED', isCorrect: false, pointsEarned: 0, confidence: baseConfidence, needsReview: true, reason: `${questionType || 'This response type'} is not yet auto-evaluable offline — routed to mandatory human review.` };
};
