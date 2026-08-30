import Answer from '../models/Answer.js';
import { isUnresolvedScore, resolveAuthoritativeScore, resolveProposedScore } from '../services/offlineEvaluation/scoreResolutionService.js';

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
  { includeAnswers = false, includeQuestionDetails = false, force = false } = {}
) => {
  if (!attempt) {
    throw new Error('Attempt is required to compute score summary');
  }

  const hasCachedSummary =
    !force &&
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
  let proposedTotal = 0;
  let maxScore = 0;
  let hasUnresolvedScore = false;

  answers.forEach((answer) => {
    const authoritativeScore = resolveAuthoritativeScore(answer);
    const proposedScore = resolveProposedScore(answer);
    if (isUnresolvedScore(answer) || authoritativeScore === null) {
      hasUnresolvedScore = true;
      proposedTotal += proposedScore ?? 0;
    } else {
      totalScore += authoritativeScore;
      proposedTotal += authoritativeScore;
    }
    const questionPoints = Number(answer.questionId?.points) || 0;
    maxScore += questionPoints;
  });

  const percentage = !hasUnresolvedScore && maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : null;

  attempt.scoreSummary = {
    totalScore: hasUnresolvedScore ? null : totalScore,
    maxScore,
    percentage,
    proposedTotal: hasUnresolvedScore ? proposedTotal : null,
    isFinal: !hasUnresolvedScore,
    computedAt: new Date(),
  };
  await attempt.save();

  return {
    summary: {
      totalScore: hasUnresolvedScore ? null : totalScore,
      maxScore,
      percentage,
      proposedTotal: hasUnresolvedScore ? proposedTotal : null,
      isFinal: !hasUnresolvedScore,
    },
    answers,
  };
};

