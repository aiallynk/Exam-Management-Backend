import ExamAttempt from '../../models/ExamAttempt.js';
import Answer from '../../models/Answer.js';
import Question from '../../models/Question.js';
import QuestionPaper from '../../models/QuestionPaper.js';
import OMRResult from '../../models/OMRResult.js';
import { ensureScoreSummary } from '../../utils/attemptScores.js';

const normalizeOption = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === 'SKIPPED' || raw === 'INVALID') return raw || 'SKIPPED';
  return raw.charAt(0);
};

/**
 * OMR is an input/extraction mechanism. Authoritative scores live on ExamAttempt/Answer.
 * OMRResult remains a processing artifact; canonical truth is materialized here.
 */
export const materializeFromOmrResult = async ({ omrResultId, actorUserId = null }) => {
  const result = await OMRResult.findById(omrResultId);
  if (!result) throw new Error('OMR result not found.');

  const examId = result.exam_id || result.examId;
  const tenantId = result.tenant_id;
  const candidateId = result.candidate_id;
  if (!examId || !tenantId) throw new Error('OMR result is missing exam or tenant context.');
  if (!candidateId) throw new Error('Cannot materialize OMR before candidate mapping is confirmed.');

  let attempt = await ExamAttempt.findOne({ sourceOmrResultId: result._id });
  if (!attempt) {
    try {
      attempt = await ExamAttempt.findOneAndUpdate(
        { sourceOmrResultId: result._id },
        {
          $setOnInsert: {
            examId,
            tenantId,
            userId: candidateId,
            sourceOmrResultId: result._id,
            isCompleted: true,
            startTime: result.processed_at || result.evaluatedAt || result.created_at || new Date(),
            submitTime: result.processed_at || result.evaluatedAt || new Date(),
            submittedAt: result.processed_at || result.evaluatedAt || new Date(),
            submitMeta: { submissionSource: 'OMR' },
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      attempt = await ExamAttempt.findOne({ sourceOmrResultId: result._id });
      if (!attempt) throw error;
    }
  }

  if (!attempt.questionPaperId) {
    const paper = await QuestionPaper.findOne({ examId }).sort({ createdAt: 1 }).select('_id').lean();
    if (paper?._id) {
      attempt.questionPaperId = paper._id;
      await attempt.save();
    }
  }

  const questions = attempt.questionPaperId
    ? await Question.find({ questionPaperId: attempt.questionPaperId, isIncludedInExam: { $ne: false } })
        .sort({ order: 1, createdAt: 1 })
        .select('_id questionType options correctAnswer points')
        .lean()
    : [];

  const detected = result.detected_answers?.length
    ? result.detected_answers
    : result.detectedAnswers || [];
  const markingRules = {
    marksPerQuestion: 1,
    negativeMarking: Number(result.negative_marks || 0) > 0,
    negativeMarks: Number(result.negative_marks || 0),
  };

  let materializedCount = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const detectedAnswer = normalizeOption(detected[index]);
    const correctLabel = normalizeOption(
      Array.isArray(question.correctAnswer)
        ? question.correctAnswer[0]
        : question.correctAnswer,
    );
    const isSkipped = detectedAnswer === 'SKIPPED' || detectedAnswer === 'INVALID' || !detectedAnswer;
    const isCorrect = !isSkipped && detectedAnswer === correctLabel;
    let pointsEarned = 0;
    if (isCorrect) {
      pointsEarned = Number(question.points) || markingRules.marksPerQuestion;
    } else if (!isSkipped && markingRules.negativeMarking) {
      pointsEarned = -Math.abs(markingRules.negativeMarks);
    }

    const payload = {
      attemptId: attempt._id,
      questionId: question._id,
      answerText: isSkipped ? '' : detectedAnswer,
      selectedOption: isSkipped ? null : detectedAnswer,
      isCorrect,
      pointsEarned,
      evaluationStatus: 'AUTO_EVALUATED',
      finalScoreSource: 'RULE_ENGINE',
      needsReview: Boolean(result.manualReviewRequired),
    };

    try {
      await Answer.findOneAndUpdate(
        { attemptId: attempt._id, questionId: question._id },
        { $setOnInsert: payload },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      );
      materializedCount += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  const { summary } = await ensureScoreSummary(attempt, { force: true });
  result.materializedAttemptId = attempt._id;
  result.materializedBy = actorUserId || result.created_by;
  result.materializedAt = new Date();
  await result.save();

  return {
    attemptId: attempt._id,
    materializedCount,
    scoreSummary: summary,
    canonicalScore: summary.totalScore,
    omrDiagnosticScore: Number(result.final_score ?? result.score ?? 0),
  };
};
