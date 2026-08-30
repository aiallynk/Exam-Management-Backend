import AnswerSegment from '../../models/AnswerSegment.js';
import Answer from '../../models/Answer.js';
import Question from '../../models/Question.js';
import { buildExpectedQuestionSequence } from './answerMappingService.js';
import { buildRubricEvaluationPayload } from './rubricScoreNormalization.js';

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
  attemptId,
  questionId: question._id,
  answerText: segment?.extractedText || '',
  isCorrect: false,
  pointsEarned: 0,
  aiEvaluation: {
    feedback: 'Not attempted',
    notAttempted: true,
    maxScore: Number(question.points) || 0,
    pointsEarned: 0,
    method: 'NOT_ATTEMPTED',
  },
  needsReview: false,
  finalScoreSource: 'AI',
  evaluationStatus: 'NOT_ATTEMPTED',
  sourceAnswerSegmentId: segment?._id || null,
});

export const buildMaterializedAnswerPayload = async ({ attempt, segment, result }) => {
  const question = await Question.findById(segment.questionId).select('points evaluationConfig').lean();
  if (!question) return null;
  const evaluationStatus = result.evaluationMethod === 'MANUAL_REQUIRED'
    ? 'PENDING_REVIEW'
    : result.needsReview ? 'AI_EVALUATED' : 'AUTO_EVALUATED';
  const rubricEvaluation = buildRubricEvaluationPayload({
    rubricScores: result.rubricScores || result.aiEvaluation?.rubricScores,
    questionRubric: question.evaluationConfig?.rubric || [],
    pointsEarned: Number(result.pointsEarned) || 0,
  });
  return {
    attemptId: attempt._id,
    questionId: segment.questionId,
    answerText: segment.extractedText,
    isCorrect: Boolean(result.isCorrect),
    pointsEarned: Number(result.pointsEarned) || 0,
    aiEvaluation: {
      ...(result.aiEvaluation && typeof result.aiEvaluation === 'object' ? result.aiEvaluation : {}),
      pointsEarned: Number(result.pointsEarned) || 0,
      maxScore: Number(question.points) || 0,
      confidence: result.confidence,
      feedback: result.feedback || result.aiEvaluation?.feedback || '',
      method: result.evaluationMethod,
      rubricScores: rubricEvaluation?.finalScores || result.rubricScores || result.aiEvaluation?.rubricScores,
    },
    rubricEvaluation,
    needsReview: Boolean(result.needsReview),
    finalScoreSource: result.evaluationMethod === 'DETERMINISTIC' ? 'RULE_ENGINE' : 'AI',
    evaluationStatus,
    sourceAnswerSegmentId: segment._id,
  };
};

export const loadExpectedQuestionsWithDetails = async ({ questionPaperId }) => {
  const sequence = await buildExpectedQuestionSequence({ questionPaperId });
  if (!sequence.length) return [];
  const questionIds = sequence.map((entry) => entry.questionId);
  const questions = await Question.find({ _id: { $in: questionIds } })
    .select('points questionText questionType order evaluationConfig')
    .lean();
  const byId = new Map(questions.map((question) => [String(question._id), question]));
  return sequence.map((entry) => ({
    ...entry,
    question: byId.get(String(entry.questionId)) || null,
  })).filter((entry) => entry.question);
};
