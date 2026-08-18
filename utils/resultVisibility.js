/**
 * Single source of truth for "can this candidate see their score/answers
 * yet". Previously duplicated (with drifted disqualification handling) across
 * routes/attempts.js, routes/candidates.js, and routes/results.js.
 */

export const isExamResultsReleased = (exam) => {
  if (!exam) return false;
  if (Boolean(exam.showResultsImmediately)) return true;
  if (!exam.resultsReleasedAt) return false;
  const releasedAt = new Date(exam.resultsReleasedAt);
  return !Number.isNaN(releasedAt.getTime()) && releasedAt <= new Date();
};

// Score visibility is never based on the disqualification reason — a
// disqualified candidate may see their disqualification status, but not
// their score/answers, until the exam's own release policy allows it (or a
// privileged/reviewer role is looking).
export const canCandidateViewScore = ({ exam, isPrivileged = false, canReviewAnswers = false }) => {
  if (isPrivileged || canReviewAnswers) return true;
  return isExamResultsReleased(exam);
};

// Minimal, safe-to-return status for a candidate's own attempt when the
// score/answers aren't visible yet (e.g. disqualified, results not
// released). Callers add their own extra fields (attemptedQuestions, etc).
export const buildAttemptStatusOnlyPayload = (attempt) => ({
  uniqueId: attempt.uniqueId,
  isCompleted: Boolean(attempt.isCompleted),
  isDisqualified: Boolean(attempt.isDisqualified),
  disqualifyReason: attempt.disqualifyReason || null,
  disqualifyStatus: attempt.disqualifyStatus || null,
  submitTime: attempt.submitTime || attempt.submittedAt || null,
});
