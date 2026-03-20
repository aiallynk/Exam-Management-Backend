import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import User from '../models/User.js';

const asNonNegativeInt = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

export const getPlanOwnerUser = async (userId) => {
  if (!userId) return null;
  return User.findById(userId).select('_id planType examsCreated tenantId role');
};

export const getExamByIdForPlan = async (examId) => {
  if (!examId) return null;
  return Exam.findById(examId).select('_id createdBy questionCount candidateCount tenantId examType');
};

export const getExamCountByCreator = async (userId) => {
  if (!userId) return 0;
  return Exam.countDocuments({ createdBy: userId });
};

export const getQuestionCountForExam = async (examId) => {
  if (!examId) return 0;
  const paperIds = await QuestionPaper.find({ examId }).distinct('_id');
  if (!paperIds.length) return 0;
  return Question.countDocuments({ questionPaperId: { $in: paperIds } });
};

export const getCandidateCountForExam = async (examId) => {
  if (!examId) return 0;
  const candidateIds = await ExamAttempt.distinct('userId', { examId });
  return candidateIds.length;
};

export const getExamUsageSnapshot = async (exam) => {
  if (!exam?._id) {
    return { questionCount: 0, candidateCount: 0 };
  }

  const storedQuestionCount = asNonNegativeInt(exam.questionCount);
  const storedCandidateCount = asNonNegativeInt(exam.candidateCount);

  const [questionCount, candidateCount] = await Promise.all([
    getQuestionCountForExam(exam._id),
    getCandidateCountForExam(exam._id),
  ]);

  return {
    questionCount: Math.max(storedQuestionCount, asNonNegativeInt(questionCount)),
    candidateCount: Math.max(storedCandidateCount, asNonNegativeInt(candidateCount)),
  };
};

export const syncExamQuestionCount = async (examId) => {
  if (!examId) return 0;
  const paperIds = await QuestionPaper.find({ examId }).distinct('_id');
  const count = paperIds.length
    ? asNonNegativeInt(await Question.countDocuments({ questionPaperId: { $in: paperIds } }))
    : 0;
  const marksAggregation = paperIds.length
    ? await Question.aggregate([
        { $match: { questionPaperId: { $in: paperIds } } },
        {
          $group: {
            _id: null,
            totalMarks: { $sum: { $ifNull: ['$points', 0] } },
          },
        },
      ])
    : [];
  const totalMarks = Number.isFinite(Number(marksAggregation?.[0]?.totalMarks))
    ? Math.max(0, Number(marksAggregation[0].totalMarks))
    : 0;
  await Exam.updateOne(
    { _id: examId },
    { $set: { questionCount: count, totalMarks } }
  );
  return count;
};

export const syncExamCandidateCount = async (examId) => {
  if (!examId) return 0;
  const count = asNonNegativeInt(await getCandidateCountForExam(examId));
  await Exam.updateOne({ _id: examId }, { $set: { candidateCount: count } });
  return count;
};

export const syncUserExamCount = async (userId) => {
  if (!userId) return 0;
  const count = asNonNegativeInt(await getExamCountByCreator(userId));
  await User.updateOne({ _id: userId }, { $set: { examsCreated: count } });
  return count;
};

export const getCurrentMonthRange = (referenceDate = new Date()) => {
  const safeDate =
    referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
  const start = new Date(safeDate.getFullYear(), safeDate.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(safeDate.getFullYear(), safeDate.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
};

export const getExamCountForTenantByMonth = async (tenantId, referenceDate) => {
  if (!tenantId) return 0;
  const { start, end } = getCurrentMonthRange(referenceDate);
  return Exam.countDocuments({
    tenantId,
    createdAt: { $gte: start, $lt: end },
  });
};

export const getAttemptCountForTenantByMonth = async (tenantId, referenceDate) => {
  if (!tenantId) return 0;
  const { start, end } = getCurrentMonthRange(referenceDate);
  return ExamAttempt.countDocuments({
    tenantId,
    createdAt: { $gte: start, $lt: end },
  });
};

export const getExamCountForTenantByWindow = async (tenantId, start, end) => {
  if (!tenantId) return 0;
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;
  return Exam.countDocuments({
    tenantId,
    createdAt: { $gte: start, $lt: end },
  });
};

export const getAttemptCountForTenantByWindow = async (tenantId, start, end) => {
  if (!tenantId) return 0;
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;
  return ExamAttempt.countDocuments({
    tenantId,
    createdAt: { $gte: start, $lt: end },
  });
};
