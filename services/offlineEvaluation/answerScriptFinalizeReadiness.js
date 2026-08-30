import Answer from '../../models/Answer.js';
import AnswerSegment from '../../models/AnswerSegment.js';

export const FINALIZE_ELIGIBLE_STATUSES = ['EVALUATED', 'NEEDS_REVIEW', 'DERIVATIVE_FAILED'];
export const BLOCKING_EVALUATION_STATUSES = ['PENDING_REVIEW', 'UNDER_REVIEW', 'FLAGGED'];

export const resolvePostMaterializeStatus = (needsReviewCount = 0) => {
  const count = Number(needsReviewCount) || 0;
  if (count > 0) {
    return {
      status: 'NEEDS_REVIEW',
      statusReason: `${count} answer(s) require evaluator attention.`,
    };
  }
  return { status: 'EVALUATED', statusReason: '' };
};

export const buildFinalizeReadiness = ({
  scriptStatus,
  candidateId = null,
  materializedAttemptId = null,
  unmappedCount = 0,
  pendingReviewCount = 0,
} = {}) => {
  const blockers = [];
  if (!FINALIZE_ELIGIBLE_STATUSES.includes(scriptStatus)) {
    blockers.push({
      code: 'NOT_READY',
      message: `This sheet is still ${String(scriptStatus || 'processing').replace(/_/g, ' ').toLowerCase()}.`,
    });
  }
  if (!candidateId) {
    blockers.push({ code: 'NEEDS_MAPPING', message: 'Map this sheet to a candidate first.' });
  }
  if (Number(unmappedCount) > 0) {
    blockers.push({
      code: 'QUESTION_MAPPING',
      message: `${unmappedCount} answer region(s) still need question mapping on this page.`,
    });
  }
  if (!materializedAttemptId) {
    blockers.push({ code: 'NOT_MATERIALIZED', message: 'Answers have not been written through to the attempt yet.' });
  }
  if (Number(pendingReviewCount) > 0) {
    blockers.push({
      code: 'EVALUATOR_REVIEW',
      message: `${pendingReviewCount} answer(s) still need evaluator review before the evaluated paper can be created.`,
    });
  }
  return {
    canFinalize: blockers.length === 0,
    blockers,
    pendingReviewCount: Number(pendingReviewCount) || 0,
    unmappedCount: Number(unmappedCount) || 0,
  };
};

export const loadFinalizeReadiness = async (script) => {
  if (!script?._id) return buildFinalizeReadiness({ scriptStatus: '' });
  const [unmappedCount, pendingReviewCount] = await Promise.all([
    AnswerSegment.countDocuments({
      answerScriptId: script._id,
      $or: [{ questionId: null }, { mappingStatus: 'NEEDS_REVIEW' }],
    }),
    script.materializedAttemptId
      ? Answer.countDocuments({
        attemptId: script.materializedAttemptId,
        evaluationStatus: { $in: BLOCKING_EVALUATION_STATUSES },
      })
      : 0,
  ]);
  return buildFinalizeReadiness({
    scriptStatus: script.status,
    candidateId: script.candidateId,
    materializedAttemptId: script.materializedAttemptId,
    unmappedCount,
    pendingReviewCount,
  });
};
