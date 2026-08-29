import ExamAttempt from '../../models/ExamAttempt.js';
import Answer from '../../models/Answer.js';
import AnswerScript from '../../models/AnswerScript.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import Question from '../../models/Question.js';
import { ensureScoreSummary } from '../../utils/attemptScores.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../../utils/auditLogger.js';
import { generateEvaluatedDerivative } from './evaluatedDerivativeService.js';

// Part N/O — writes evaluated AnswerSegments through to the EXISTING
// ExamAttempt/Answer/result-calculation contracts, rather than a separate
// offline results system. Idempotent: re-running against the same
// AnswerScript reuses its existing ExamAttempt and upserts Answers by the
// existing {attemptId, questionId} unique index — never a duplicate
// attempt or a duplicate answer for the same question.
export const materializeFromScript = async ({ answerScriptId, actorUserId }) => {
  const script = await AnswerScript.findById(answerScriptId);
  if (!script) throw new Error('Answer script not found.');
  if (!script.candidateId) throw new Error('Cannot materialize an answer script before candidate mapping is confirmed.');

  let attempt = script.materializedAttemptId ? await ExamAttempt.findById(script.materializedAttemptId) : null;
  if (!attempt) {
    attempt = await ExamAttempt.findOne({ examId: script.examId, tenantId: script.tenantId, sourceAnswerScriptId: script._id });
  }
  if (!attempt) {
    attempt = await ExamAttempt.create({
      examId: script.examId,
      tenantId: script.tenantId,
      userId: script.candidateId,
      questionPaperId: script.questionPaperId,
      sourceAnswerScriptId: script._id,
      isCompleted: true,
      startTime: script.createdAt,
      submitTime: new Date(),
      submittedAt: new Date(),
    });
    script.materializedAttemptId = attempt._id;
    await script.save();
  }

  const segments = await AnswerSegment.find({
    answerScriptId: script._id,
    questionId: { $ne: null },
    evaluationStatus: 'EVALUATED',
    evaluationResult: { $ne: null },
  });

  let materializedCount = 0;
  let needsReviewCount = 0;

  for (const segment of segments) {
    if (segment.materializedAnswerId) { materializedCount += 1; if (segment.evaluationResult?.needsReview) needsReviewCount += 1; continue; } // already written through — idempotent skip

    const question = await Question.findById(segment.questionId).select('points').lean();
    if (!question) continue;
    const result = segment.evaluationResult;

    const evaluationStatus = result.evaluationMethod === 'MANUAL_REQUIRED'
      ? 'PENDING_REVIEW'
      : result.needsReview ? 'AI_EVALUATED' : 'AUTO_EVALUATED';

    const payload = {
      attemptId: attempt._id,
      questionId: segment.questionId,
      answerText: segment.extractedText,
      isCorrect: Boolean(result.isCorrect),
      pointsEarned: Number(result.pointsEarned) || 0,
      aiEvaluation: result.aiEvaluation || (result.evaluationMethod === 'AI_VISION_RUBRIC' ? { rubricScores: result.rubricScores, confidence: result.confidence, method: 'vision_rubric' } : undefined),
      rubricEvaluation: result.rubricScores ? {
        aiScores: result.rubricScores,
        finalScores: result.rubricScores,
        finalMark: Number(result.pointsEarned) || 0,
        updatedAt: new Date(),
      } : undefined,
      needsReview: Boolean(result.needsReview),
      finalScoreSource: result.evaluationMethod === 'DETERMINISTIC' ? 'RULE_ENGINE' : 'AI',
      evaluationStatus,
      sourceAnswerSegmentId: segment._id,
    };

    let answer = await Answer.findOne({ attemptId: attempt._id, questionId: segment.questionId });
    if (answer) {
      Object.assign(answer, payload);
      await answer.save();
    } else {
      answer = await Answer.create(payload);
    }

    segment.materializedAnswerId = answer._id;
    await segment.save();
    materializedCount += 1;
    if (payload.needsReview) needsReviewCount += 1;
  }

  await ensureScoreSummary(attempt, { force: true });
  await attempt.save();

  script.evaluationSummary = {
    totalScore: attempt.scoreSummary?.totalScore ?? null,
    maxScore: attempt.scoreSummary?.maxScore ?? null,
    questionCount: segments.length,
    evaluatedCount: materializedCount,
    needsReviewCount,
    evaluatedAt: new Date(),
  };
  script.status = needsReviewCount > 0 ? 'NEEDS_REVIEW' : 'EVALUATED';
  await script.save();

  await logAuditEvent(AUDIT_ACTIONS.OFFLINE_RESULT_SYNCHRONIZED, {
    userId: actorUserId || null, tenantId: script.tenantId, resourceType: 'AnswerScript', resourceId: script._id,
    examId: script.examId, attemptId: attempt._id, materializedCount, needsReviewCount,
  });

  return { attempt, materializedCount, needsReviewCount };
};

// Part L — finalization is a distinct, human-triggered action (evaluator/
// tenant admin), never automatic. It does NOT release exam results itself
// — the existing exam-level result-release action is untouched and still
// governs when a candidate can see anything, preserving OF/FOR semantics.
export const finalizeAnswerScript = async ({ answerScriptId, actorUserId }) => {
  const script = await AnswerScript.findById(answerScriptId);
  if (!script) throw new Error('Answer script not found.');
  if (!['EVALUATED', 'NEEDS_REVIEW'].includes(script.status)) {
    throw new Error(`Cannot finalize a script in status ${script.status}.`);
  }
  const pendingReview = await Answer.countDocuments({ attemptId: script.materializedAttemptId, evaluationStatus: { $in: ['PENDING_REVIEW', 'UNDER_REVIEW', 'FLAGGED'] } });
  if (pendingReview > 0) {
    const error = new Error(`${pendingReview} answer(s) still need evaluator review before this script can be finalized.`);
    error.statusCode = 409;
    throw error;
  }
  script.status = 'FINALIZED';
  script.finalizedAt = new Date();
  script.finalizedBy = actorUserId || null;
  // Generate from the immutable original plus current effective Answer
  // values. Passing the unsaved FINALIZED document makes storage generation
  // the commit gate: a failed derivative cannot leave a falsely finalized
  // script behind.
  await generateEvaluatedDerivative({
    answerScriptId: script._id,
    actorUserId,
    scriptDocument: script,
  });
  await logAuditEvent(AUDIT_ACTIONS.OFFLINE_SCRIPT_FINALIZED, {
    userId: actorUserId || null, tenantId: script.tenantId, resourceType: 'AnswerScript', resourceId: script._id, examId: script.examId,
  });
  return script;
};
