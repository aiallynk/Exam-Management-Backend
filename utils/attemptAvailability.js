import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';

export const resolveAttemptExhaustedExamIds = async ({ userId, tenantId }) => {
  if (!userId) return [];
  const attemptFilter = {
    userId,
    isCompleted: true,
  };
  if (tenantId) {
    attemptFilter.tenantId = tenantId;
  }

  const summaries = await ExamAttempt.aggregate([
    { $match: attemptFilter },
    {
      $group: {
        _id: '$examId',
        completedCount: { $sum: 1 },
        reAttemptAllowedCount: {
          $sum: { $cond: ['$reAttemptAllowed', 1, 0] },
        },
      },
    },
  ]);

  const examIds = summaries.map((summary) => summary._id).filter(Boolean);
  if (!examIds.length) return [];

  const exams = await Exam.find({ _id: { $in: examIds } })
    .select('_id maxAttempts')
    .lean();
  const maxAttemptsByExam = new Map(
    exams.map((exam) => [String(exam._id), Number(exam.maxAttempts) || 1])
  );

  return summaries
    .filter((summary) => {
      const maxAttempts = maxAttemptsByExam.get(String(summary._id));
      return (
        maxAttempts &&
        summary.completedCount >= maxAttempts &&
        summary.reAttemptAllowedCount <= 0
      );
    })
    .map((summary) => summary._id);
};
