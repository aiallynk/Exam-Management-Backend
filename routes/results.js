import express from 'express';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import Exam from '../models/Exam.js';
import Question from '../models/Question.js';
import Submission from '../models/Submission.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { hasExamPermission } from '../middleware/examPermissions.js';

const router = express.Router();
const PRIVILEGED_ROLES = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'EXAM_CREATOR']);
const isResultsReleased = (exam) => {
  if (!exam) return false;
  if (exam.showResultsImmediately) return true;
  if (!exam.resultsReleasedAt) return false;
  return new Date(exam.resultsReleasedAt) <= new Date();
};

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const resolveExamStatusFromViolationCount = (violationCount, requestedStatus = '') => {
  const normalizedRequested = String(requestedStatus || '').trim().toUpperCase();
  if (normalizedRequested === 'FAIR' || normalizedRequested === 'SUSPICIOUS' || normalizedRequested === 'CHEATING') {
    return normalizedRequested;
  }
  if (violationCount <= 0) return 'FAIR';
  if (violationCount <= 2) return 'SUSPICIOUS';
  return 'CHEATING';
};

const buildIntegritySummary = (attempt) => {
  const violationDetails = Array.isArray(attempt?.violationLogs) ? attempt.violationLogs : [];
  const countFromField = toNonNegativeInt(attempt?.violationCount, violationDetails.length);
  const totalViolations = Math.max(countFromField, violationDetails.length);
  return {
    totalViolations,
    violationDetails,
    examStatus: resolveExamStatusFromViolationCount(totalViolations, attempt?.examStatus || ''),
  };
};

router.get(
  '/leaderboard/:examId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  async (req, res, next) => {
    try {
      const { examId } = req.params;
      const limit = Math.max(parseInt(req.query.limit || '50', 10) || 50, 1);
      const isPrivilegedUser = PRIVILEGED_ROLES.has(req.user.role);

      if (!/^[a-fA-F0-9]{24}$/.test(String(examId || ''))) {
        return res.status(400).json({ error: 'Invalid exam ID.' });
      }

      const exam = await Exam.findOne({
        _id: examId,
        ...req.tenantFilter,
      }).select('title showResultsImmediately resultsReleasedAt');

      if (!exam) {
        return res.status(404).json({ error: 'Exam not found.' });
      }

      if (!isPrivilegedUser) {
        const hasOwnAttempt = await ExamAttempt.exists({
          ...req.tenantFilter,
          examId,
          userId: req.user._id,
        });
        if (!hasOwnAttempt) {
          return res.status(403).json({ error: 'Forbidden - You can only view leaderboards for your own exams.' });
        }
      }

      const attempts = await ExamAttempt.find({
        ...req.tenantFilter,
        examId,
        isCompleted: true,
        isDisqualified: false,
      })
        .populate('userId', 'name email')
        .select('userId startTime submitTime submittedAt scoreSummary')
        .lean();

      if (!attempts.length) {
        return res.json({
          exam: {
            _id: exam._id,
            title: exam.title,
          },
          leaderboard: [],
          totalEntries: 0,
        });
      }

      const submissionRows = await Submission.find({
        examId,
        attemptId: { $in: attempts.map((attempt) => attempt._id) },
        isDraft: false,
      })
        .select('attemptId executionTimeMs timeTaken')
        .lean();

      const runtimeByAttempt = new Map();
      submissionRows.forEach((submission) => {
        const key = submission.attemptId?.toString();
        if (!key) return;

        const previous = runtimeByAttempt.get(key) || {
          executionTimeMs: 0,
          timeTaken: 0,
        };

        runtimeByAttempt.set(key, {
          executionTimeMs: previous.executionTimeMs + Math.max(Number(submission.executionTimeMs) || 0, 0),
          timeTaken: Math.max(previous.timeTaken, Math.max(Number(submission.timeTaken) || 0, 0)),
        });
      });

      const leaderboard = attempts
        .map((attempt) => {
          const runtime = runtimeByAttempt.get(attempt._id.toString()) || {};
          const attemptDurationSeconds = Math.max(
            Math.floor(
              ((new Date(attempt.submitTime || attempt.submittedAt || Date.now()).getTime() || Date.now()) -
                (new Date(attempt.startTime || Date.now()).getTime() || Date.now())) /
                1000
            ),
            0
          );

          return {
            attemptId: attempt._id,
            userId: attempt.userId,
            score: Number(attempt.scoreSummary?.totalScore) || 0,
            totalMarks: Number(attempt.scoreSummary?.maxScore) || 0,
            percentage: Number(attempt.scoreSummary?.percentage) || 0,
            timeTaken: Number(runtime.timeTaken) || attemptDurationSeconds,
            executionTimeMs: Number(runtime.executionTimeMs) || 0,
            submittedAt: attempt.submitTime || attempt.submittedAt || null,
          };
        })
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          if (left.executionTimeMs !== right.executionTimeMs) {
            return left.executionTimeMs - right.executionTimeMs;
          }
          if (left.timeTaken !== right.timeTaken) return left.timeTaken - right.timeTaken;
          return new Date(left.submittedAt || 0).getTime() - new Date(right.submittedAt || 0).getTime();
        })
        .map((entry, index) => ({
          ...entry,
          rank: index + 1,
        }));

      const visibleLeaderboard =
        !isPrivilegedUser && !isResultsReleased(exam)
          ? leaderboard.filter(
              (entry) => String(entry.userId?._id || entry.userId) === String(req.user._id)
            )
          : leaderboard;

      return res.json({
        exam: {
          _id: exam._id,
          title: exam.title,
        },
        leaderboard: visibleLeaderboard.slice(0, limit),
        totalEntries: !isPrivilegedUser && !isResultsReleased(exam)
          ? visibleLeaderboard.length
          : leaderboard.length,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get all results (universal: based on VIEW_RESULTS and REVIEW_ANSWERS permissions)
router.get('/', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      examId,
      sessionId,
      userId,
      isCompleted,
      isDisqualified,
      productModule,
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { ...req.tenantFilter };
    const isPrivilegedUser = PRIVILEGED_ROLES.has(req.user.role);

    if (examId) filter.examId = examId;
    if (sessionId) filter.sessionId = sessionId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';
    if (isDisqualified !== undefined) filter.isDisqualified = isDisqualified === 'true';
    if (productModule !== undefined) {
      const normalizedProduct = String(productModule).trim().toUpperCase();
      if (!['STANDARD', 'WIZKIDS'].includes(normalizedProduct)) {
        return res.status(400).json({ error: 'productModule must be STANDARD or WIZKIDS.' });
      }
      const productExamIds = await Exam.find({ tenantId: req.user.tenantId, productModule: normalizedProduct }).distinct('_id');
      if (examId && !productExamIds.some((id) => String(id) === String(examId))) {
        filter.examId = { $in: [] };
      } else if (!examId) {
        filter.examId = { $in: productExamIds };
      }
    }

    // Candidates/non-privileged users can only query their own results.
    if (!isPrivilegedUser) {
      filter.userId = req.user._id;
    }

    const attempts = await ExamAttempt.find(filter)
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt productModule')
      .populate('sessionId', 'startTime endTime')
      .populate('userId', 'name email')
      .populate('questionPaperId', 'setName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const visibleAttempts = isPrivilegedUser
      ? attempts
      : attempts.filter((attempt) => {
        const exam = attempt.examId;
        if (!exam) return false;
        if (exam.showResultsImmediately) return true;
        if (!exam.resultsReleasedAt) return false;
        return new Date(exam.resultsReleasedAt) <= new Date();
      });

    // Calculate scores for each attempt
    const results = await Promise.all(
      visibleAttempts.map(async (attempt) => {
        const answers = await Answer.find({ attemptId: attempt._id })
          .populate('questionId', 'points sectionId');
        const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
        const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
        const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

        // Get total questions for this attempt's question paper
        let totalQuestions = 0;
        let attemptedQuestions = 0;

        if (attempt.questionPaperId) {
          const questionPaperId = attempt.questionPaperId._id || attempt.questionPaperId;
          totalQuestions = await Question.countDocuments({ questionPaperId });

          // Count attempted questions (questions with non-empty answers)
          attemptedQuestions = await Answer.countDocuments({
            attemptId: attempt._id,
            $or: [
              { answerText: { $exists: true, $ne: '' } },
              { answerText: { $exists: true, $ne: null } }
            ]
          });
        }

        // Get section-wise breakdown
        const sectionBreakdown = {};
        answers.forEach(answer => {
          if (answer.questionId?.sectionId) {
            const sectionId = answer.questionId.sectionId.toString();
            if (!sectionBreakdown[sectionId]) {
              sectionBreakdown[sectionId] = {
                totalScore: 0,
                maxScore: 0,
                questionCount: 0,
              };
            }
            sectionBreakdown[sectionId].totalScore += answer.pointsEarned || 0;
            sectionBreakdown[sectionId].maxScore += answer.questionId.points || 0;
            sectionBreakdown[sectionId].questionCount += 1;
          }
        });

        // Calculate section percentages
        Object.keys(sectionBreakdown).forEach(sectionId => {
          const section = sectionBreakdown[sectionId];
          section.percentage = section.maxScore > 0
            ? Math.round((section.totalScore / section.maxScore) * 100)
            : 0;
        });
        const integrity = buildIntegritySummary(attempt);

        return {
          attempt,
          score: {
            totalScore,
            maxScore,
            percentage,
            normalizedScore: attempt.normalizedScore || null,
            percentile: attempt.percentile || null,
            sessionPercentile: attempt.sessionPercentile || null,
          },
          sectionBreakdown,
          attemptedQuestions,
          totalQuestions,
          progressPercentage: totalQuestions > 0
            ? Math.round((attemptedQuestions / totalQuestions) * 100)
            : 0,
          totalViolations: integrity.totalViolations,
          violationDetails: integrity.violationDetails,
          examStatus: integrity.examStatus,
          integrity,
        };
      })
    );

    // Count total (may differ from attempts.length if filtered by permissions)
    const total = isPrivilegedUser
      ? await ExamAttempt.countDocuments(filter)
      : results.length; // Use filtered count for regular users

    res.json({
      results,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
