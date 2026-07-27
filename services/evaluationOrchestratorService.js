import Answer from '../models/Answer.js';

// Question types whose grading today comes from evaluateAnswer() (semantic
// AI) rather than exact/rule matching. Kept in sync with services/aiService.js.
const SUBJECTIVE_QUESTION_TYPES = new Set([
  'SHORT_ANSWER',
  'FILL_IN_THE_BLANK',
  'PARAGRAPH',
  'ESSAY',
  'ESSAY_LETTER',
  'ESSAY_STORY',
  'NUMBER',
]);

/**
 * Classify each answer of a just-submitted attempt according to the exam's
 * evaluationMode, so the AI/rule score either finalizes immediately (today's
 * behavior) or stays provisional pending examiner verification.
 *
 * Deliberately a no-op when evaluationMode is missing or 'AUTOMATIC' — every
 * exam that existed before this feature (and every exam that doesn't opt in)
 * keeps behaving exactly as it does today; nothing here changes
 * pointsEarned/isCorrect/aiEvaluation, only the new evaluationStatus/
 * finalScoreSource bookkeeping fields.
 *
 * @param {ObjectId|string} attemptId
 * @param {{ evaluationMode?: string }} exam
 */
export const classifySubmissionEvaluations = async (attemptId, exam) => {
  const evaluationMode = exam?.evaluationMode;
  if (!evaluationMode || evaluationMode === 'AUTOMATIC') {
    return;
  }

  const answers = await Answer.find({ attemptId }).populate('questionId', 'questionType');
  if (!answers.length) return;

  const bulkOps = answers.map((answer) => {
    const questionType = answer.questionId?.questionType;
    const isSubjective = SUBJECTIVE_QUESTION_TYPES.has(questionType);

    let evaluationStatus;
    let finalScoreSource;

    switch (evaluationMode) {
      case 'MANUAL':
        // Every answer awaits a human; nothing finalizes automatically.
        evaluationStatus = 'PENDING_REVIEW';
        break;
      case 'HYBRID':
      case 'AI_MANDATORY_REVIEW':
        if (isSubjective) {
          evaluationStatus = 'PENDING_REVIEW';
        } else {
          evaluationStatus = 'FINALIZED';
          finalScoreSource = 'RULE_ENGINE';
        }
        break;
      case 'AI_OPTIONAL_REVIEW':
        // AI/rule score is already usable as final; review is optional and
        // never blocks publication (see routes/exams.js release-results gate).
        evaluationStatus = isSubjective ? 'AI_EVALUATED' : 'AUTO_EVALUATED';
        finalScoreSource = isSubjective ? 'AI' : 'RULE_ENGINE';
        break;
      default:
        return null;
    }

    return {
      updateOne: {
        filter: { _id: answer._id },
        update: {
          $set: {
            evaluationStatus,
            ...(finalScoreSource ? { finalScoreSource } : {}),
          },
        },
      },
    };
  }).filter(Boolean);

  if (bulkOps.length) {
    await Answer.bulkWrite(bulkOps, { ordered: false });
  }
};
