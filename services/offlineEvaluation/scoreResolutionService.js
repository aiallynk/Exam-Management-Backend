const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const hasHumanResolvedFailure = (answer = {}) => (
  answer?.scoreResolved === true
  && finite(answer?.finalScore) !== null
  && ['OVERRIDE', 'MANUAL_SCORE'].includes(answer?.evaluatorDecision)
);

export const isUnresolvedScore = (answer = {}) => (
  answer?.scoreResolved === false
  // An AI/rubric failure has no score of its own, but it is no longer a
  // blocker after an evaluator has explicitly supplied an authoritative
  // manual score. This also keeps already-reviewed historic attempts
  // finalizable while new overrides are recorded as MANUAL below.
  || (answer?.scoringMode === 'EVALUATION_FAILED' && !hasHumanResolvedFailure(answer))
  || (answer?.scoringMode === 'AI_GENERAL_PROVISIONAL' && answer?.evaluatorDecision === 'PENDING')
  || (answer?.requiresReview === true && !['REVIEWED', 'FINALIZED', 'MODERATED'].includes(answer?.evaluationStatus))
);

export const resolveAuthoritativeScore = (answer = {}) => {
  if (isUnresolvedScore(answer)) return null;
  const finalScore = finite(answer.finalScore);
  if (finalScore !== null) return finalScore;
  return finite(answer.pointsEarned);
};

export const resolveProposedScore = (answer = {}) => {
  const explicit = finite(answer.aiProposedScore);
  if (explicit !== null) return explicit;
  return finite(answer?.aiEvaluation?.proposedScore ?? answer?.aiEvaluation?.pointsEarned);
};

export const applyEvaluatorApproval = ({ answer, evaluatorId, maximumMarks }) => {
  const proposed = resolveProposedScore(answer);
  const existing = finite(answer.finalScore) ?? finite(answer.pointsEarned);
  const score = answer.scoringMode === 'AI_GENERAL_PROVISIONAL' ? proposed : (proposed ?? existing);
  if (score === null || score < 0 || score > maximumMarks) {
    const error = new Error('There is no valid AI score to approve. Evaluate this answer manually or retry the AI evaluation.');
    error.statusCode = 409;
    error.code = 'NO_APPROVABLE_AI_SCORE';
    throw error;
  }
  answer.evaluatorDecision = 'APPROVE_AI';
  answer.evaluatorOverrideScore = null;
  answer.finalScore = score;
  answer.scoreResolved = true;
  answer.requiresReview = false;
  answer.pointsEarned = score;
  answer.examinerScore = score;
  answer.examinerId = evaluatorId;
  answer.examinerReviewedAt = new Date();
  answer.finalScoreSource = 'EXAMINER';
  answer.evaluationStatus = 'REVIEWED';
  answer.needsReview = false;
  return score;
};

export const applyEvaluatorOverride = ({ answer, evaluatorId, score }) => {
  if (answer.scoringMode === 'EVALUATION_FAILED') {
    // Preserve the failed AI attempt in aiEvaluation/audit data, but make
    // clear that the authoritative mark now came from a person.
    answer.scoringMode = 'MANUAL';
  }
  answer.evaluatorDecision = 'OVERRIDE';
  answer.evaluatorOverrideScore = score;
  answer.finalScore = score;
  answer.scoreResolved = true;
  answer.requiresReview = false;
  answer.pointsEarned = score;
  answer.examinerScore = score;
  answer.examinerId = evaluatorId;
  answer.examinerReviewedAt = new Date();
  answer.finalScoreSource = 'EXAMINER';
  answer.evaluationStatus = 'REVIEWED';
  answer.needsReview = false;
  return score;
};

export const applyManualScore = ({ answer, evaluatorId, score }) => {
  answer.scoringMode = answer.scoringMode === 'EVALUATION_FAILED' ? 'MANUAL' : (answer.scoringMode || 'MANUAL');
  answer.evaluatorDecision = 'MANUAL_SCORE';
  answer.evaluatorOverrideScore = score;
  answer.finalScore = score;
  answer.scoreResolved = true;
  answer.requiresReview = false;
  answer.pointsEarned = score;
  answer.examinerScore = score;
  answer.examinerId = evaluatorId;
  answer.examinerReviewedAt = new Date();
  answer.finalScoreSource = 'EXAMINER';
  answer.evaluationStatus = 'REVIEWED';
  answer.needsReview = false;
  return score;
};
