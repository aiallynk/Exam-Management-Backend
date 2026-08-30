import ExamAttempt from '../../models/ExamAttempt.js';
import Answer from '../../models/Answer.js';
import AnswerScript from '../../models/AnswerScript.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import AnswerAnnotation from '../../models/AnswerAnnotation.js';
import Question from '../../models/Question.js';
import { ensureScoreSummary } from '../../utils/attemptScores.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../../utils/auditLogger.js';
import { generateEvaluatedDerivative } from './evaluatedDerivativeService.js';
import { loadFinalizeReadiness, resolvePostMaterializeStatus } from './answerScriptFinalizeReadiness.js';
import {
  buildMaterializedAnswerPayload,
  buildNotAttemptedPayload,
  findSegmentForQuestion,
  loadExpectedQuestionsWithDetails,
  validateMaterializationIntegrity,
} from './materializationIntegrity.js';

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
    try {
      attempt = await ExamAttempt.create({
        examId: script.examId,
        tenantId: script.tenantId,
        userId: script.candidateId,
        questionPaperId: script.questionPaperId,
        sourceAnswerScriptId: script._id,
        sessionId: script.examSessionId || null,
        isCompleted: true,
        startTime: script.createdAt,
        submitTime: new Date(),
        submittedAt: new Date(),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      attempt = await ExamAttempt.findOne({ sourceAnswerScriptId: script._id });
      if (!attempt) throw error;
    }
    script.materializedAttemptId = attempt._id;
    await script.save();
  }

  const allSegments = await AnswerSegment.find({ answerScriptId: script._id });
  const segments = allSegments.filter((segment) => (
    segment.questionId
    && segment.evaluationStatus === 'EVALUATED'
    && segment.evaluationResult
  ));
  const expectedQuestions = await loadExpectedQuestionsWithDetails({ questionPaperId: script.questionPaperId });

  let materializedCount = 0;
  let needsReviewCount = 0;
  const materializedQuestionIds = new Set();

  for (const segment of segments) {
    if (segment.materializedAnswerId) {
      const existing = await Answer.findById(segment.materializedAnswerId);
      const humanLocked = existing && (
        existing.examinerReviewedAt
        || existing.moderatorReviewedAt
        || ['REVIEWED', 'FINALIZED', 'MODERATED'].includes(existing.evaluationStatus)
      );
      if (humanLocked) {
        materializedCount += 1;
        if (segment.evaluationResult?.needsReview) needsReviewCount += 1;
        continue;
      }
      segment.materializedAnswerId = null;
    }

    const question = await Question.findById(segment.questionId).select('points').lean();
    if (!question) continue;
    const result = segment.evaluationResult;

    const payload = await buildMaterializedAnswerPayload({ attempt, segment, result });
    if (!payload) continue;

    let answer = await Answer.findOne({ attemptId: attempt._id, questionId: segment.questionId });
    if (answer) {
      const humanLocked = answer.examinerReviewedAt
        || answer.moderatorReviewedAt
        || ['REVIEWED', 'FINALIZED', 'MODERATED'].includes(answer.evaluationStatus);
      if (humanLocked) {
        segment.materializedAnswerId = answer._id;
        await segment.save();
        materializedCount += 1;
        continue;
      }
      answer.set(payload);
      await answer.save();
    } else {
      try {
        answer = await Answer.create(payload);
      } catch (error) {
        if (error?.code !== 11000) throw error;
        answer = await Answer.findOne({ attemptId: attempt._id, questionId: segment.questionId });
        if (!answer) throw error;
      }
    }

    segment.materializedAnswerId = answer._id;
    await segment.save();
    await AnswerAnnotation.updateMany(
      { answerSegmentId: segment._id, answerId: null },
      { $set: { answerId: answer._id } },
    );
    materializedQuestionIds.add(String(segment.questionId));
    materializedCount += 1;
    if (payload.needsReview) needsReviewCount += 1;
  }

  for (const expected of expectedQuestions) {
    const questionKey = String(expected.questionId);
    if (materializedQuestionIds.has(questionKey)) continue;
    const existing = await Answer.findOne({ attemptId: attempt._id, questionId: expected.questionId });
    if (existing) {
      materializedQuestionIds.add(questionKey);
      materializedCount += 1;
      continue;
    }
    const segment = findSegmentForQuestion(allSegments, {
      questionId: expected.questionId,
      displayNumber: expected.displayNumber,
    });
    const payload = buildNotAttemptedPayload({
      attemptId: attempt._id,
      question: expected.question,
      segment,
    });
    let answer;
    try {
      answer = await Answer.create(payload);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      answer = await Answer.findOne({ attemptId: attempt._id, questionId: expected.questionId });
      if (!answer) throw error;
    }
    if (segment && !segment.materializedAnswerId) {
      segment.materializedAnswerId = answer._id;
      await AnswerSegment.updateOne({ _id: segment._id }, { $set: { materializedAnswerId: answer._id } });
    }
    materializedQuestionIds.add(questionKey);
    materializedCount += 1;
    if (payload.needsReview) needsReviewCount += 1;
  }

  const populatedAnswers = await Answer.find({ attemptId: attempt._id })
    .populate('questionId', 'points order')
    .lean();
  validateMaterializationIntegrity({ expectedQuestions, answers: populatedAnswers });

  await ensureScoreSummary(attempt, { force: true });
  await attempt.save();

  script.evaluationSummary = {
    totalScore: attempt.scoreSummary?.totalScore ?? null,
    maxScore: attempt.scoreSummary?.maxScore ?? null,
    questionCount: expectedQuestions.length || populatedAnswers.length,
    evaluatedCount: materializedCount,
    needsReviewCount,
    evaluatedAt: new Date(),
  };
  const next = resolvePostMaterializeStatus(needsReviewCount);
  script.status = next.status;
  script.statusReason = next.statusReason;
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
  const readiness = await loadFinalizeReadiness(script);
  if (!readiness.canFinalize) {
    const error = new Error(readiness.blockers[0]?.message || `Cannot finalize a script in status ${script.status}.`);
    error.statusCode = 409;
    error.code = readiness.blockers[0]?.code || 'NOT_READY';
    throw error;
  }
  script.finalizedAt = new Date();
  script.finalizedBy = actorUserId || null;
  try {
    await generateEvaluatedDerivative({
      answerScriptId: script._id,
      actorUserId,
      scriptDocument: script,
    });
    script.status = 'COMPLETED';
    script.errorCode = '';
    script.failureStage = '';
    script.safeMessage = '';
    script.statusReason = '';
  } catch (error) {
    script.status = 'DERIVATIVE_FAILED';
    script.errorCode = 'DERIVATIVE_FAILED';
    script.failureStage = 'RENDERING_EVALUATED_PAPER';
    script.safeMessage = 'Review is complete, but the evaluated paper could not be generated.';
    script.statusReason = script.safeMessage;
    script.evaluatedDerivative = { ...(script.evaluatedDerivative || {}), status: 'FAILED' };
    script.processingMeta = { ...script.processingMeta, lastError: error.message };
    await script.save();
    return script;
  }
  await script.save();
  await logAuditEvent(AUDIT_ACTIONS.OFFLINE_SCRIPT_FINALIZED, {
    userId: actorUserId || null, tenantId: script.tenantId, resourceType: 'AnswerScript', resourceId: script._id, examId: script.examId,
  });
  return script;
};
