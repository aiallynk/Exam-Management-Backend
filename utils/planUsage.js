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
  return User.findById(userId).select('_id planType examsCreated');
};

export const getExamByIdForPlan = async (examId) => {
  if (!examId) return null;
  return Exam.findById(examId).select('_id createdBy questionCount candidateCount');
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
  const count = asNonNegativeInt(await getQuestionCountForExam(examId));
  await Exam.updateOne({ _id: examId }, { $set: { questionCount: count } });
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

