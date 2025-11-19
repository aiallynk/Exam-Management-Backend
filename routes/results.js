import express from 'express';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';

const router = express.Router();

// Get all results (DESIGNER/ADMIN only)
router.get('/', requireAuth, requireRole('DESIGNER', 'ADMIN'), async (req, res, next) => {
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

    const filter = {};

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
          .populate('questionId', 'points');
        const totalScore = answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
        const maxScore = answers.reduce((sum, a) => sum + (a.questionId?.points || 0), 0);
        const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

        return {
          attempt,
          score: {
            totalScore,
            maxScore,
            percentage,
          },
        };
      })
    );

    const total = await ExamAttempt.countDocuments(filter);

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

