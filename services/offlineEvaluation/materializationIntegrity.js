import AnswerSegment from '../../models/AnswerSegment.js';
import Answer from '../../models/Answer.js';
import Question from '../../models/Question.js';
import { buildExpectedQuestionSequence } from './answerMappingService.js';
import { buildRubricEvaluationPayload } from './rubricScoreNormalization.js';
import { resolveEvaluationStrategy } from './evaluationStrategyResolver.js';

export class MaterializationIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MaterializationIntegrityError';
    this.code = 'MATERIALIZATION_INTEGRITY';
    this.details = details;
  }
}

const parseDetectedNumber = (label) => {
  const match = String(label || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
};

export const findSegmentForQuestion = (segments = [], { questionId, displayNumber }) => {
  const questionKey = String(questionId || '');
  const byQuestion = segments.find((segment) => String(segment.questionId || '') === questionKey);
  if (byQuestion) return byQuestion;
  return segments.find((segment) => parseDetectedNumber(segment.detectedQuestionNumber) === displayNumber) || null;
};

export const validateMaterializationIntegrity = ({ expectedQuestions = [], answers = [] }) => {
  if (!expectedQuestions.length) return true;
  const answerByQuestion = new Map(answers.map((answer) => [String(answer.questionId?._id || answer.questionId), answer]));
  for (const expected of expectedQuestions) {
    const key = String(expected.questionId);
    const answer = answerByQuestion.get(key);
    if (!answer) {
      throw new MaterializationIntegrityError(
        `Missing answer record for question ${expected.displayNumber}.`,
        { questionId: key, displayNumber: expected.displayNumber },
      );
    }
    const maxMarks = Number(expected.points || answer.questionId?.points || 0);
    const awarded = Number(answer.pointsEarned || 0);
    if (awarded > maxMarks) {
      throw new MaterializationIntegrityError(
        `Question ${expected.displayNumber} awarded marks exceed maximum.`,
        { questionId: key, awarded, maxMarks },
      );
    }
  }
  const expectedMax = expectedQuestions.reduce((sum, item) => sum + Number(item.points || 0), 0);
  const actualMax = answers.reduce((sum, answer) => sum + Number(answer.questionId?.points || 0), 0);
  if (Math.abs(expectedMax - actualMax) > 0.001) {
    throw new MaterializationIntegrityError(
      'Assessment maximum marks do not include every applicable question.',
      { expectedMax, actualMax },
    );
  }
  return true;
};

export const buildNotAttemptedPayload = ({ attemptId, question, segment = null }) => ({
  ...(() => {
    const strategy = resolveEvaluationStrategy(question);
    const rubricEvaluationFailed = strategy.scoringMode === 'EVALUATION_FAILED';
    const needsConfirmation = rubricEvaluationFailed
      || ['AI_GENERAL_PROVISIONAL', 'RUBRIC_BASED'].includes(strategy.scoringMode);
    const hasZeroProposal = !rubricEvaluationFailed && needsConfirmation;
    return {
      attemptId,
      questionId: question._id,
      answerText: segment?.extractedText || '',
      isCorrect: false,
      pointsEarned: needsConfirmation ? null : 0,
      scoringMode: needsConfirmation ? strategy.scoringMode : 'DETERMINISTIC',
      aiEvaluationStatus: rubricEvaluationFailed ? 'FAILED' : 'NOT_RUN',
      aiProposedScore: hasZeroProposal ? 0 : null,
      aiConfidence: null,
      evaluatorDecision: needsConfirmation ? 'PENDING' : undefined,
      finalScore: needsConfirmation ? null : 0,
      scoreResolved: !needsConfirmation,
      requiresReview: needsConfirmation,
      answerStatus: 'NOT_ATTEMPTED',
      aiEvaluation: {
        feedback: rubricEvaluationFailed
          ? 'The configured rubric could not be evaluated. An evaluator must resolve this answer manually or after a rubric retry.'
          : needsConfirmation
          ? 'No response was detected. Proposed score: 0; evaluator confirmation is required.'
          : 'Not attempted',
        notAttempted: true,
        maxScore: Number(question.points) || 0,
        proposedScore: hasZeroProposal ? 0 : undefined,
        failureReason: rubricEvaluationFailed ? strategy.reason || 'RUBRIC_CONFIGURATION_ERROR' : undefined,
        method: rubricEvaluationFailed
          ? 'RUBRIC_REVIEW_REQUIRED'
          : needsConfirmation ? 'NOT_ATTEMPTED_REVIEW_REQUIRED' : 'NOT_ATTEMPTED',
      },
      needsReview: needsConfirmation,
      finalScoreSource: needsConfirmation ? undefined : 'RULE_ENGINE',
      evaluationStatus: needsConfirmation ? 'PENDING_REVIEW' : 'NOT_ATTEMPTED',
      sourceAnswerSegmentId: segment?._id || null,
    };
  })(),
});

export const buildMaterializedAnswerPayload = async ({ attempt, segment, result }) => {
  const question = await Question.findById(segment.questionId).select('points evaluationConfig rubricSnapshot').lean();
  if (!question) return null;
  const requiresReview = Boolean(result.requiresReview || result.needsReview || result.scoreResolved === false);
  const evaluationStatus = requiresReview
    ? 'PENDING_REVIEW'
    : result.evaluationMethod === 'DETERMINISTIC' ? 'AUTO_EVALUATED' : 'AI_EVALUATED';
  const resolved = result.scoreResolved !== false && result.finalScore !== null && result.finalScore !== undefined;
  const finalScore = resolved ? Number(result.finalScore) : null;
  const rubricEvaluation = buildRubricEvaluationPayload({
    rubricScores: result.rubricScores || result.aiEvaluation?.rubricScores,
    questionRubric: question.rubricSnapshot?.criteria || question.rubricSnapshot || question.evaluationConfig?.rubric || [],
    pointsEarned: finalScore,
    finalized: resolved,
  });
  return {
    attemptId: attempt._id,
    questionId: segment.questionId,
    answerText: segment.extractedText,
    isCorrect: result.isCorrect,
    pointsEarned: finalScore,
    scoringMode: result.scoringMode,
    aiEvaluationStatus: result.aiEvaluationStatus,
    aiProposedScore: result.aiProposedScore ?? null,
    aiConfidence: result.aiConfidence ?? result.confidence ?? null,
    evaluatorDecision: result.evaluatorDecision,
    evaluatorOverrideScore: null,
    finalScore,
    scoreResolved: Boolean(resolved),
    requiresReview,
    answerStatus: result.answerStatus || 'ATTEMPTED',
    aiEvaluation: {
      ...(result.aiEvaluation && typeof result.aiEvaluation === 'object' ? result.aiEvaluation : {}),
      proposedScore: result.aiProposedScore ?? result.aiEvaluation?.proposedScore ?? null,
      maxScore: Number(question.points) || 0,
      confidence: result.confidence,
      feedback: result.feedback || result.aiEvaluation?.feedback || result.reason || '',
      failureReason: result.scoringMode === 'EVALUATION_FAILED' ? result.reason : '',
      rubricConfigured: ['RUBRIC_BASED', 'EVALUATION_FAILED'].includes(result.scoringMode),
      method: result.evaluationMethod,
      rubricScores: rubricEvaluation?.aiScores || result.rubricScores || result.aiEvaluation?.rubricScores,
    },
    rubricEvaluation,
    needsReview: requiresReview,
    finalScoreSource: resolved ? (result.evaluationMethod === 'DETERMINISTIC' ? 'RULE_ENGINE' : 'AI') : undefined,
    evaluationStatus,
    sourceAnswerSegmentId: segment._id,
  };
};

export const loadExpectedQuestionsWithDetails = async ({ questionPaperId }) => {
  const sequence = await buildExpectedQuestionSequence({ questionPaperId });
  if (!sequence.length) return [];
  const questionIds = sequence.map((entry) => entry.questionId);
  const questions = await Question.find({ _id: { $in: questionIds } })
    .select('points questionText questionType order evaluationConfig rubricSnapshot')
    .lean();
  const byId = new Map(questions.map((question) => [String(question._id), question]));
  return sequence.map((entry) => ({
    ...entry,
    question: byId.get(String(entry.questionId)) || null,
  })).filter((entry) => entry.question);
};
