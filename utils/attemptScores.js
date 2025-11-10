import Answer from '../models/Answer.js';

const isFiniteNumber = (value) => Number.isFinite(Number(value));

const buildAnswersQuery = (attemptId, { includeQuestionDetails } = {}) => {
  const query = Answer.find({ attemptId });

  if (includeQuestionDetails) {
    query.populate(
      'questionId',
      'questionText questionType correctAnswer points order'
    );
  } else {
    query.populate('questionId', 'points order');
  }

  query.sort({ 'questionId.order': 1 });

  return query;
};

export const ensureScoreSummary = async (
  attempt,
  { includeAnswers = false, includeQuestionDetails = false } = {}
) => {
  if (!attempt) {
    throw new Error('Attempt is required to compute score summary');
  }

  const hasCachedSummary =
    attempt.scoreSummary &&
    isFiniteNumber(attempt.scoreSummary.totalScore) &&
    isFiniteNumber(attempt.scoreSummary.maxScore) &&
    isFiniteNumber(attempt.scoreSummary.percentage);

  let answers = null;

  if (includeAnswers) {
    answers = await buildAnswersQuery(attempt._id, {
      includeQuestionDetails,
    });
  }

  if (hasCachedSummary) {
    return {
      summary: {
        totalScore: Number(attempt.scoreSummary.totalScore) || 0,
        maxScore: Number(attempt.scoreSummary.maxScore) || 0,
        percentage: Number(attempt.scoreSummary.percentage) || 0,
      },
      answers,
    };
  }

  if (!answers) {
    answers = await buildAnswersQuery(attempt._id, {
      includeQuestionDetails,
    });
  }

  let totalScore = 0;
  let maxScore = 0;

  answers.forEach((answer) => {
    totalScore += Number(answer.pointsEarned) || 0;
    const questionPoints = Number(answer.questionId?.points) || 0;
    maxScore += questionPoints;
  });

  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  attempt.scoreSummary = {
    totalScore,
    maxScore,
    percentage,
    computedAt: new Date(),
  };
  await attempt.save();

  return {
    summary: {
      totalScore,
      maxScore,
      percentage,
    },
    answers,
  };
};


