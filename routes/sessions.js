import express from 'express';
import ExamSession from '../models/ExamSession.js';
import Exam from '../models/Exam.js';
import QuestionPaper from '../models/QuestionPaper.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import { generateSessionQRCode } from '../services/qrService.js';

const router = express.Router();

const generateManualToken = async () => {
  let token;
  let exists = true;

  while (exists) {
    token = Math.floor(10000 + Math.random() * 90000).toString();
    exists = await ExamSession.exists({ manualToken: token });
  }

  return token;
};

const validateSessionAvailability = async (session, user) => {
  if (!session) {
    return { valid: false, message: 'Session not found' };
  }

  if (!session.isActive) {
    return { valid: false, message: 'Session is not active' };
  }

  const now = new Date();
  if (now < session.startTime) {
    return { valid: false, message: 'Session has not started yet' };
  }

  if (now > session.endTime) {
    return { valid: false, message: 'Session has ended' };
  }

  if (user.role === 'STUDENT') {
    const SystemConfig = (await import('../models/SystemConfig.js')).default;
    const blockedConfig = await SystemConfig.findOne({
      key: `blocked_student_${user._id}`,
    });

    if (blockedConfig && blockedConfig.value === 'true') {
      return { valid: false, message: 'Your account has been blocked' };
    }
  }

  return { valid: true };
};

// Get all sessions (role filtered)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId, isActive } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};

    if (examId) {
      filter.examId = examId;
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    // Students only see active sessions
    if (req.user.role === 'STUDENT') {
      filter.isActive = true;
      const now = new Date();
      filter.startTime = { $lte: now };
      filter.endTime = { $gte: now };
    } else if (req.user.role === 'DESIGNER') {
      // Designers see sessions for their exams
      const exams = await Exam.find({ createdBy: req.user._id });
      filter.examId = { $in: exams.map((e) => e._id) };
    }

    const sessions = await ExamSession.find(filter)
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await ExamSession.countDocuments(filter);

    res.json({
      sessions,
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

// Get single session
router.get('/:sessionId', requireAuth, async (req, res, next) => {
  try {
    const session = await ExamSession.findById(req.params.sessionId)
      .populate(
        'examId',
        'title description duration gracePeriod maxAttempts showResultsImmediately resultsReleasedAt'
      )
      .populate('questionPaperId', 'setName')
      .populate('createdBy', 'name email');

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // For students, only show if active and within time
    if (req.user.role === 'STUDENT') {
      const now = new Date();
      if (!session.isActive || now < session.startTime || now > session.endTime) {
        return res.status(403).json({ error: 'Session not available' });
      }
    }

    res.json({ session });
  } catch (error) {
    next(error);
  }
});

// Create session (DESIGNER/ADMIN)
router.post(
  '/',
  requireAuth,
  requireRole('DESIGNER', 'ADMIN'),
  [
    body('examId').notEmpty().withMessage('Exam ID is required'),
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('startTime').isISO8601().withMessage('Valid start time is required'),
    body('endTime').isISO8601().withMessage('Valid end time is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { examId, questionPaperId, startTime, endTime } = req.body;

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Verify question paper belongs to exam
      const questionPaper = await QuestionPaper.findOne({
        _id: questionPaperId,
        examId,
      });

      if (!questionPaper) {
        return res.status(404).json({ error: 'Question paper not found' });
      }

      // Verify times
      const start = new Date(startTime);
      const end = new Date(endTime);
      if (end <= start) {
        return res.status(400).json({ error: 'End time must be after start time' });
      }

      const manualToken = await generateManualToken();

      const session = new ExamSession({
        examId,
        questionPaperId,
        qrCode: 'placeholder',
        qrImage: '',
        manualToken,
        isActive: true,
        startTime: start,
        endTime: end,
        createdBy: req.user._id,
      });

      const requestOrigin =
        req.body.appBaseUrl ||
        req.get('origin') ||
        req.headers['x-forwarded-origin'] ||
        undefined;

      const { qrCode, qrImage } = await generateSessionQRCode(
        session._id,
        examId,
        manualToken,
        requestOrigin
      );
      session.qrCode = qrCode;
      session.qrImage = qrImage;

      await session.save();
      await session.populate(
        'examId',
        'title duration showResultsImmediately resultsReleasedAt'
      );
      await session.populate('questionPaperId', 'setName');

      res.status(201).json({
        session,
        qrImage,
        manualToken,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Validate QR code
router.get('/validate/:qrCode', requireAuth, async (req, res, next) => {
  try {
    const { qrCode } = req.params;

    const session = await ExamSession.findOne({ qrCode })
      .populate('examId', 'title duration maxAttempts showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName');

    const validation = await validateSessionAvailability(session, req.user);
    if (!validation.valid) {
      return res.json({ valid: false, message: validation.message });
    }

    res.json({
      valid: true,
      sessionId: session._id,
      session,
      manualToken: session.manualToken,
      message: 'QR code is valid',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/manual-token/:token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.params;

    const session = await ExamSession.findOne({ manualToken: token })
      .populate('examId', 'title duration maxAttempts showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName');

    const validation = await validateSessionAvailability(session, req.user);
    if (!validation.valid) {
      return res.json({ valid: false, message: validation.message });
    }

    res.json({
      valid: true,
      sessionId: session._id,
      session,
      message: 'Manual token is valid',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

