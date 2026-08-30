import ExamAttempt from '../models/ExamAttempt.js';
import Exam from '../models/Exam.js';
import AnswerScript from '../models/AnswerScript.js';
import Enrollment from '../models/academic/Enrollment.js';
import { buildAcademicListFilter, canOperateExam } from './academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { isExamResultsReleased } from '../utils/resultVisibility.js';

// Staff must be authorized for THIS specific candidate, not merely hold a
// role that resolves to *some* non-empty academic scope — resolveAcademicVisibility()
// always returns a truthy object (or throws), so a bare Boolean(visibility)
// check was a full tenant-wide bypass for every ACADEMIC_ADMIN/TEACHER/EXAM_CREATOR.
export const canReadCandidateHistory = async (actor, candidateId) => {
  if (!actor || !candidateId) return false;
  if (String(actor._id) === String(candidateId)) return true;
  if (hasRole(actor, 'TENANT_ADMIN')) return true;
  if (hasRole(actor, 'ACADEMIC_ADMIN') || hasRole(actor, 'TEACHER') || hasRole(actor, 'EXAM_CREATOR')) {
    const enrollmentFilter = await buildAcademicListFilter(actor, 'enrollments');
    const hasScopedEnrollment = await Enrollment.exists({ ...enrollmentFilter, userId: candidateId, status: 'ACTIVE' });
    if (hasScopedEnrollment) return true;

    // Quick Assessment candidates may have no Enrollment at all — fall back to
    // whether the actor legitimately owns/operates at least one exam this
    // candidate has actually attempted (covers hierarchy-free rosters).
    const attemptExamIds = await ExamAttempt.distinct('examId', { tenantId: actor.tenantId, userId: candidateId });
    if (attemptExamIds.length) {
      const exams = await Exam.find({ _id: { $in: attemptExamIds }, tenantId: actor.tenantId }).lean();
      for (const exam of exams) {
        if (await canOperateExam(actor, exam)) return true;
      }
    }
    return false;
  }
  return false;
};

export const getCandidateAssessmentHistory = async (actor, candidateId, {
  academicSessionId = null,
  courseId = null,
  deliveryMode = null,
  limit = 100,
} = {}) => {
  if (!(await canReadCandidateHistory(actor, candidateId))) {
    const error = new Error('You are not authorized to view this candidate history.');
    error.statusCode = 403;
    throw error;
  }

  const tenantId = actor.tenantId;
  const attemptFilter = { tenantId, userId: candidateId };
  const attempts = await ExamAttempt.find(attemptFilter)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();

  const examIds = [...new Set(attempts.map((a) => String(a.examId)))];
  const exams = await Exam.find({ _id: { $in: examIds }, tenantId }).lean();
  const examById = new Map(exams.map((exam) => [String(exam._id), exam]));

  const scripts = await AnswerScript.find({ tenantId, candidateId, examId: { $in: examIds } })
    .select('_id examId status evaluationSummary materializedAttemptId finalizedAt evaluatedDerivative')
    .lean();
  const scriptByExamAttempt = new Map(
    scripts
      .filter((script) => script.materializedAttemptId)
      .map((script) => [String(script.materializedAttemptId), script])
  );

  const isSelf = String(actor._id) === String(candidateId);

  const items = [];
  for (const attempt of attempts) {
    const exam = examById.get(String(attempt.examId));
    if (!exam) continue;
    if (academicSessionId && String(exam.academicContext?.academicSessionId || '') !== String(academicSessionId)) continue;
    if (courseId && String(exam.academicContext?.courseId || '') !== String(courseId)) continue;
    if (deliveryMode && String(exam.deliveryMode || '') !== String(deliveryMode)) continue;

    const released = isExamResultsReleased(exam);
    if (isSelf && !released) continue;

    const script = scriptByExamAttempt.get(String(attempt._id)) || scripts.find((s) => String(s.examId) === String(exam._id));
    items.push({
      examId: exam._id,
      attemptId: attempt._id,
      answerScriptId: script?._id || null,
      title: exam.title,
      subject: exam.subject || exam.academicContext?.subject || '',
      assessmentPurpose: exam.assessmentPurpose || null,
      deliveryMode: exam.deliveryMode || 'ONLINE',
      attemptedAt: attempt.submittedAt || attempt.createdAt,
      score: attempt.scoreSummary?.totalScore ?? script?.evaluationSummary?.totalScore ?? null,
      maxScore: attempt.scoreSummary?.maxScore ?? script?.evaluationSummary?.maxScore ?? null,
      percentage: attempt.scoreSummary?.percentage ?? null,
      resultStatus: released ? 'RELEASED' : 'PENDING',
      evaluationStatus: script?.status || attempt.status || 'UNKNOWN',
      hasAnswerBook: Boolean(script?._id),
      hasEvaluatedReport: Boolean(script?.evaluatedDerivative?.key),
    });
  }

  return { candidateId, items, total: items.length };
};
