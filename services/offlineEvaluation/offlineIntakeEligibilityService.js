import Exam from '../../models/Exam.js';
import ExamParticipant from '../../models/ExamParticipant.js';
import QuestionPaper from '../../models/QuestionPaper.js';
import AnswerScript from '../../models/AnswerScript.js';
import { canOperateExam, resolveAcademicVisibility } from '../academicAccessService.js';
import { hasRole, hasAnyRole } from '../../utils/userRoles.js';

export const OFFLINE_INTAKE_BLOCKERS = Object.freeze({
  ONLINE_ONLY: 'ONLINE_ONLY',
  NO_QUESTION_PAPER: 'NO_QUESTION_PAPER',
  NO_CANDIDATES_ASSIGNED: 'NO_CANDIDATES_ASSIGNED',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  INVALID_ASSESSMENT_STATE: 'INVALID_ASSESSMENT_STATE',
  RESULTS_ALREADY_RELEASED: 'RESULTS_ALREADY_RELEASED',
});

export const evaluateOfflineIntakeEligibility = ({
  exam,
  authorized = true,
  questionPaperCount = 0,
  candidateCount = 0,
} = {}) => {
  const blockers = [];
  if (!authorized) {
    blockers.push({
      code: OFFLINE_INTAKE_BLOCKERS.NOT_AUTHORIZED,
      message: 'This assessment is outside your assigned academic or assessment scope.',
    });
  }
  if (exam?.isActive === false) {
    blockers.push({
      code: OFFLINE_INTAKE_BLOCKERS.INVALID_ASSESSMENT_STATE,
      message: 'This assessment is inactive.',
    });
  }
  const deliveryMode = exam?.deliveryMode || 'ONLINE';
  if (deliveryMode === 'ONLINE') {
    blockers.push({
      code: OFFLINE_INTAKE_BLOCKERS.ONLINE_ONLY,
      message: 'This assessment currently accepts online answers only.',
    });
  }
  if (Number(questionPaperCount) < 1) {
    blockers.push({
      code: OFFLINE_INTAKE_BLOCKERS.NO_QUESTION_PAPER,
      message: 'A question paper is required before answer sheets can be uploaded.',
    });
  }
  if (Number(candidateCount) < 1) {
    blockers.push({
      code: OFFLINE_INTAKE_BLOCKERS.NO_CANDIDATES_ASSIGNED,
      message: 'No students are assigned to this assessment.',
    });
  }
  return {
    eligibleForOfflineIntake: blockers.length === 0,
    blockers,
  };
};

export const canChangeExamDeliveryMode = ({ exam, answerScriptCount = 0 } = {}) => {
  if (!exam) return { allowed: false, code: OFFLINE_INTAKE_BLOCKERS.INVALID_ASSESSMENT_STATE, message: 'Assessment not found.' };
  if (exam.resultsReleasedAt) {
    return {
      allowed: false,
      code: OFFLINE_INTAKE_BLOCKERS.RESULTS_ALREADY_RELEASED,
      message: 'Delivery mode cannot change after results have been released.',
    };
  }
  if (exam.certificatesSentAt) {
    return {
      allowed: false,
      code: OFFLINE_INTAKE_BLOCKERS.RESULTS_ALREADY_RELEASED,
      message: 'Delivery mode cannot change after certificates have been sent.',
    };
  }
  const current = exam.deliveryMode || 'ONLINE';
  if (['OFFLINE', 'HYBRID'].includes(current) && Number(answerScriptCount) > 0) {
    return {
      allowed: true,
      restrictTo: ['OFFLINE', 'HYBRID'],
      message: 'Paper answer sheets already exist — this assessment can stay Offline or Hybrid only.',
    };
  }
  return { allowed: true, restrictTo: ['ONLINE', 'OFFLINE', 'HYBRID'] };
};

const academicLocationSummary = (exam = {}) => {
  const context = exam.academicContext || {};
  return {
    organizationUnitId: context.organizationUnitId || null,
    courseOfferingId: context.courseOfferingId || null,
    academicSectionId: context.academicSectionId || context.sectionId || null,
    programId: context.programId || null,
    courseId: context.courseId || null,
  };
};

export const listOfflineIntakeAssessments = async ({ user, tenantId, monitorOnly = false }) => {
  const filter = { tenantId };
  const clauses = [];
  let tenantWide = Boolean(hasRole(user, 'TENANT_ADMIN') && monitorOnly);

  if (!tenantWide) {
    if (hasAnyRole(user, ['EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER'])) {
      const creatorExamIds = await ExamParticipant.find({
        userId: user._id,
        examRole: 'CREATOR',
        tenantId,
      }).distinct('examId');
      clauses.push({ createdBy: user._id }, { _id: { $in: creatorExamIds } });
    }
    if (hasRole(user, 'TEACHER') || hasRole(user, 'ACADEMIC_ADMIN')) {
      try {
        const visibility = await resolveAcademicVisibility(user);
        if (visibility.all) tenantWide = true;
        else {
          clauses.push({
            'academicContext.courseOfferingId': { $in: visibility.ids['course-offerings'] || [] },
          });
        }
      } catch {
        // Owned assessments from createdBy / CREATOR participant must still appear.
      }
    }
    if (!tenantWide) {
      if (clauses.length) filter.$or = clauses;
      else return [];
    }
  }

  const exams = await Exam.find(filter)
    .select('title creationMode deliveryMode isActive academicContext createdBy resultsReleasedAt status')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const examIds = exams.map((exam) => exam._id);
  const [papers, participants, authorizedFlags] = await Promise.all([
    QuestionPaper.find({ examId: { $in: examIds } }).select('_id examId setName').lean(),
    ExamParticipant.find({ examId: { $in: examIds }, examRole: 'CANDIDATE' }).select('examId').lean(),
    Promise.all(exams.map(async (exam) => {
      if (monitorOnly && hasRole(user, 'TENANT_ADMIN')) return true;
      return canOperateExam(user, exam);
    })),
  ]);

  const papersByExam = new Map();
  papers.forEach((paper) => {
    const key = String(paper.examId);
    if (!papersByExam.has(key)) papersByExam.set(key, []);
    papersByExam.get(key).push(paper);
  });
  const candidateCountByExam = new Map();
  participants.forEach((participant) => {
    const key = String(participant.examId);
    candidateCountByExam.set(key, (candidateCountByExam.get(key) || 0) + 1);
  });

  return exams.map((exam, index) => {
    const examPapers = papersByExam.get(String(exam._id)) || [];
    const candidateCount = candidateCountByExam.get(String(exam._id)) || 0;
    const authorized = Boolean(authorizedFlags[index]);
    const eligibility = evaluateOfflineIntakeEligibility({
      exam,
      authorized,
      questionPaperCount: examPapers.length,
      candidateCount,
    });
    return {
      examId: exam._id,
      title: exam.title,
      creationMode: exam.creationMode || 'QUICK',
      deliveryMode: exam.deliveryMode || 'ONLINE',
      status: exam.isActive === false ? 'INACTIVE' : 'ACTIVE',
      questionPaperId: examPapers.length === 1 ? examPapers[0]._id : null,
      questionPaperCount: examPapers.length,
      questionPapers: examPapers.map((paper) => ({
        _id: paper._id,
        setName: paper.setName || 'Default set',
      })),
      candidateCount,
      academicContext: academicLocationSummary(exam),
      canChangeDeliveryMode: canChangeExamDeliveryMode({ exam }).allowed && authorized && !monitorOnly,
      ...eligibility,
    };
  }).filter((item) => item.blockers.every((blocker) => blocker.code !== OFFLINE_INTAKE_BLOCKERS.NOT_AUTHORIZED) || monitorOnly);
};

export const assertCandidateOnAssessmentRoster = async ({ tenantId, examId, candidateId }) => {
  const rosterCount = await ExamParticipant.countDocuments({ examId, examRole: 'CANDIDATE', tenantId });
  if (!rosterCount) return { rosterExists: false, onRoster: false };
  const onRoster = await ExamParticipant.exists({
    examId,
    tenantId,
    userId: candidateId,
    examRole: 'CANDIDATE',
  });
  return { rosterExists: true, onRoster: Boolean(onRoster) };
};

export const countAnswerScriptsForExam = async ({ tenantId, examId }) =>
  AnswerScript.countDocuments({ tenantId, examId, status: { $nin: ['CANCELLED'] } });
