import express from 'express';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import Question from '../models/Question.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { hasExamPermission } from '../middleware/examPermissions.js';

const router = express.Router();

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
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { ...req.tenantFilter };

    if (examId) filter.examId = examId;
    if (sessionId) filter.sessionId = sessionId;
    if (userId) filter.userId = userId;
    if (isCompleted !== undefined) filter.isCompleted = isCompleted === 'true';
    if (isDisqualified !== undefined) filter.isDisqualified = isDisqualified === 'true';

    const attempts = await ExamAttempt.find(filter)
      .populate('examId', 'title duration')
      .populate('sessionId', 'startTime endTime')
      .populate('userId', 'name email')
      .populate('questionPaperId', 'setName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Calculate scores for each attempt
    const results = await Promise.all(
      attempts.map(async (attempt) => {
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
        };
      })
    );

    // Count total (may differ from attempts.length if filtered by permissions)
    const total = req.user.role === 'SUPER_ADMIN' || req.user.role === 'EXAM_CREATOR'
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

