import User from '../models/User.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import Submission from '../models/Submission.js';
import ExamParticipant from '../models/ExamParticipant.js';
import SessionAssignment from '../models/SessionAssignment.js';
import Notification from '../models/Notification.js';
import SystemConfig from '../models/SystemConfig.js';
import OMRResult from '../models/OMRResult.js';

const toObjectIdString = (value) => (value ? String(value) : '');

export const deleteUserAndCleanup = async (userId) => {
  const userIdString = toObjectIdString(userId);
  if (!userIdString) {
    return {
      deleted: false,
      reason: 'invalid_user_id',
    };
  }

  const attemptIds = await ExamAttempt.distinct('_id', { userId });
  const submissionIds = await Submission.distinct('_id', { userId });

  const cleanupOperations = [];

  if (attemptIds.length > 0) {
    cleanupOperations.push(
      Answer.deleteMany({ attemptId: { $in: attemptIds } })
    );
    cleanupOperations.push(
      Submission.deleteMany({ attemptId: { $in: attemptIds } })
    );
  }

  cleanupOperations.push(ExamAttempt.deleteMany({ userId }));
  cleanupOperations.push(ExamParticipant.deleteMany({ userId }));
  cleanupOperations.push(SessionAssignment.deleteMany({ userId }));
  cleanupOperations.push(Submission.deleteMany({ userId }));
  cleanupOperations.push(
    Submission.updateMany(
      { 'plagiarism.matchedUserId': userId },
      { $unset: { 'plagiarism.matchedUserId': '' } }
    )
  );
  cleanupOperations.push(Notification.deleteMany({ userId }));
  cleanupOperations.push(
    Notification.updateMany({ readBy: userId }, { $pull: { readBy: userId } })
  );
  cleanupOperations.push(OMRResult.deleteMany({ candidate_id: userId }));
  cleanupOperations.push(
    SystemConfig.deleteMany({
      key: { $in: [`blocked_user_${userIdString}`, `blocked_student_${userIdString}`] },
    })
  );
  // Preserve audit logs for compliance (immutable history)

  if (submissionIds.length > 0) {
    cleanupOperations.push(
      Submission.updateMany(
        { 'plagiarism.matchedSubmissionId': { $in: submissionIds } },
        { $unset: { 'plagiarism.matchedSubmissionId': '' } }
      )
    );
  }

  await Promise.all(cleanupOperations);
  const deleteResult = await User.deleteOne({ _id: userId });

  return {
    deleted: deleteResult?.deletedCount === 1,
  };
};
