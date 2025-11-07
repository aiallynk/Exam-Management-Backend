import express from 'express';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import ExamSession from '../models/ExamSession.js';
import Exam from '../models/Exam.js';
import Question from '../models/Question.js';
import SystemConfig from '../models/SystemConfig.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import { evaluateAnswer } from '../services/aiService.js';

const parseArrayAnswer = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
      .filter(Boolean);
  }

  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
          .filter(Boolean);
      }
    } catch (error) {
      // Ignore parse error and fall back to delimiter splitting
    }

    return trimmed
      .split(/[,;|\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [String(value)];
};

const arrayEqualsIgnoreOrder = (a, b) => {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a.map((item) => item.toLowerCase()));
  const setB = new Set(b.map((item) => item.toLowerCase()));
  if (setA.size !== setB.size) {
    return false;
  }
  for (const value of setA) {
    if (!setB.has(value)) {
      return false;
    }
  }
  return true;
};

const normalizeAnswerForStorage = (questionType, value) => {
  if (questionType === 'MULTIPLE_OPTIONS') {
    const answers = parseArrayAnswer(value);
    return answers.length ? JSON.stringify(answers) : '';
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
};

const router = express.Router();

// Get all attempts (own for students, all for designers/admin)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId, sessionId, userId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};

    if (examId) filter.examId = examId;
    if (sessionId) filter.sessionId = sessionId;

    // Students only see their own attempts
    if (req.user.role === 'STUDENT') {
      filter.userId = req.user._id;
    } else if (userId) {
      filter.userId = userId;
    }

    const attempts = await ExamAttempt.find(filter)
      .populate('examId', 'title duration')
      .populate('sessionId', 'qrCode startTime endTime')
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await ExamAttempt.countDocuments(filter);

    res.json({
      attempts,
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

// Start attempt (STUDENT only)
router.post(
  '/',
  requireAuth,
  requireRole('STUDENT'),
  [
    body('sessionId').notEmpty().withMessage('Session ID is required'),
    body('examId').notEmpty().withMessage('Exam ID is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { sessionId, examId } = req.body;

      // Check if user is blocked
      const blockedConfig = await SystemConfig.findOne({
        key: `blocked_student_${req.user._id}`,
      });

      if (blockedConfig && blockedConfig.value === 'true') {
        return res.status(403).json({ error: 'Your account has been blocked' });
      }

      // Verify session
      const session = await ExamSession.findById(sessionId).populate('examId');
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.examId._id.toString() !== examId) {
        return res.status(400).json({ error: 'Session does not belong to this exam' });
      }

      if (!session.isActive) {
        return res.status(403).json({ error: 'Session is not active' });
      }

      const now = new Date();
      if (now < session.startTime || now > session.endTime) {
        return res.status(403).json({ error: 'Session is not available at this time' });
      }

      // Check max attempts
      const exam = await Exam.findById(examId);
      const existingAttempts = await ExamAttempt.countDocuments({
        userId: req.user._id,
        examId,
        isCompleted: true,
      });

      if (existingAttempts >= exam.maxAttempts) {
        return res.status(403).json({
          error: `Maximum attempts (${exam.maxAttempts}) reached for this exam`,
        });
      }

      // Check if there's an active attempt
      const activeAttempt = await ExamAttempt.findOne({
        userId: req.user._id,
        sessionId,
        isCompleted: false,
      });

      if (activeAttempt) {
        return res.json({ attempt: activeAttempt });
      }

      // Create new attempt
      const attempt = new ExamAttempt({
        examId,
        sessionId,
        userId: req.user._id,
        startTime: now,
        isCompleted: false,
      });

      await attempt.save();
      await attempt.populate('examId', 'title duration');
      await attempt.populate('sessionId', 'startTime endTime');

      res.status(201).json({ attempt });
    } catch (error) {
      next(error);
    }
  }
);

// Submit attempt
router.post(
  '/:attemptId/submit',
  requireAuth,
  [
    body('answers').isObject().withMessage('Answers must be an object'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId)
        .populate('examId')
        .populate('sessionId');

      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      // Verify ownership (students can only submit their own)
      if (req.user.role === 'STUDENT' && attempt.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (attempt.isCompleted) {
        return res.status(400).json({ error: 'Attempt already submitted' });
      }

      const { answers, isDisqualified, disqualifyReason } = req.body;

      // Get all questions for this session's question paper
      const questions = await Question.find({
        questionPaperId: attempt.sessionId.questionPaperId,
      }).sort({ order: 1 });

      const answerDocs = [];
      let totalScore = 0;
      let maxScore = 0;

      // Process each question
      for (const question of questions) {
        maxScore += question.points;
        const rawAnswer = answers[question._id.toString()];
        const studentAnswer = rawAnswer === undefined || rawAnswer === null ? '' : rawAnswer;

        let normalizedAnswerText = normalizeAnswerForStorage(
          question.questionType,
          studentAnswer
        );

        let isCorrect = false;
        let pointsEarned = 0;
        let aiEvaluation = null;

        // Auto-grade objective questions
        if (
          ['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'NUMBER'].includes(
            question.questionType
          )
        ) {
          if (question.questionType === 'MULTIPLE_OPTIONS') {
            const expected = parseArrayAnswer(question.correctAnswer);
            const received = parseArrayAnswer(studentAnswer);
            isCorrect = expected.length > 0 && arrayEqualsIgnoreOrder(expected, received);
            normalizedAnswerText = received.length ? JSON.stringify(received) : '';
            pointsEarned = isCorrect ? question.points : 0;
          } else if (question.questionType === 'NUMBER') {
            isCorrect = String(studentAnswer).trim() === String(question.correctAnswer ?? '').trim();
            pointsEarned = isCorrect ? question.points : 0;
          } else {
            isCorrect = String(studentAnswer).trim() === String(question.correctAnswer ?? '').trim();
            pointsEarned = isCorrect ? question.points : 0;
          }
        } else if (['SHORT_ANSWER', 'PARAGRAPH'].includes(question.questionType)) {
          // AI evaluation for subjective questions
          try {
            aiEvaluation = await evaluateAnswer({
              question: question.questionText,
              correctAnswer: question.correctAnswer,
              studentAnswer,
              questionType: question.questionType,
              points: question.points,
            });

            isCorrect = aiEvaluation.isCorrect;
            pointsEarned = aiEvaluation.pointsEarned;
          } catch (error) {
            console.error('AI evaluation error:', error);
            // Fallback: no points if AI fails
            pointsEarned = 0;
            aiEvaluation = {
              error: 'Evaluation failed',
              needsReview: true,
            };
          }
        }

        totalScore += pointsEarned;

        const answerDoc = new Answer({
          attemptId: attempt._id,
          questionId: question._id,
          answerText: normalizedAnswerText,
          isCorrect,
          pointsEarned,
          aiEvaluation,
          needsReview: aiEvaluation?.needsReview || false,
        });

        answerDocs.push(answerDoc);
      }

      // Save all answers
      await Answer.insertMany(answerDocs);

      // Update attempt
      attempt.isCompleted = true;
      attempt.submitTime = new Date();
      attempt.isDisqualified = isDisqualified || false;
      attempt.disqualifyReason = disqualifyReason || '';

      await attempt.save();

      const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

      res.json({
        success: true,
        attempt,
        score: {
          totalScore,
          maxScore,
          percentage,
        },
        answers: answerDocs,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get attempt results
router.get('/:attemptId/results', requireAuth, async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate('examId', 'title duration')
      .populate('sessionId', 'startTime endTime')
      .populate('userId', 'name email');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Verify ownership (students can only see their own)
    if (req.user.role === 'STUDENT' && attempt.userId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const answers = await Answer.find({ attemptId: attempt._id })
      .populate('questionId')
      .sort({ 'questionId.order': 1 });

    let totalScore = 0;
    let maxScore = 0;

    answers.forEach((answer) => {
      totalScore += answer.pointsEarned;
      maxScore += answer.questionId.points;
    });

    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

    res.json({
      attempt,
      answers,
      score: {
        totalScore,
        maxScore,
        percentage,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Update attempt (for proctoring violations)
router.patch('/:attemptId', requireAuth, async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findById(req.params.attemptId);

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Verify ownership
    if (attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { tabSwitchCount, isDisqualified, disqualifyReason, lastActivity } = req.body;

    if (tabSwitchCount !== undefined) attempt.tabSwitchCount = tabSwitchCount;
    if (isDisqualified !== undefined) attempt.isDisqualified = isDisqualified;
    if (disqualifyReason !== undefined) attempt.disqualifyReason = disqualifyReason;
    if (lastActivity !== undefined) attempt.lastActivity = new Date(lastActivity);

    await attempt.save();

    res.json({ attempt });
  } catch (error) {
    next(error);
  }
});

export default router;

