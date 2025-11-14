import express from 'express';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import {
  loadCertificateTemplate,
  applyCertificateTemplate,
  MIN_CERTIFICATION_PERCENTAGE,
} from '../utils/certificateTemplate.js';
import { ensureScoreSummary } from '../utils/attemptScores.js';

const router = express.Router();

// Get all exams (filtered by role)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    
    // Students only see active exams
    if (req.user.role === 'STUDENT') {
      filter.isActive = true;
    } else if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    // Designers see their own exams, Admins see all
    if (req.user.role === 'DESIGNER') {
      filter.createdBy = req.user._id;
    }

    const exams = await Exam.find(filter)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Exam.countDocuments(filter);

    res.json({
      exams,
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

// Get single exam
router.get('/:examId', requireAuth, async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId).populate(
      'createdBy',
      'name email'
    );

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // Students can only see active exams
    if (req.user.role === 'STUDENT' && !exam.isActive) {
      return res.status(403).json({ error: 'Exam not available' });
    }

    res.json({ exam });
  } catch (error) {
    next(error);
  }
});

// Create exam (DESIGNER/ADMIN only)
router.post(
  '/',
  requireAuth,
  requireRole('DESIGNER', 'ADMIN'),
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('duration').isInt({ min: 1 }).withMessage('Duration must be a positive number'),
    body('gracePeriod').optional().isInt({ min: 0 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
    body('showResultsImmediately').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        title,
        description,
        duration,
        gracePeriod,
        maxAttempts,
        isActive,
        showResultsImmediately,
      } =
        req.body;

      const exam = new Exam({
        title,
        description,
        duration,
        gracePeriod: gracePeriod || 0,
        maxAttempts: maxAttempts || 1,
        isActive: isActive !== undefined ? isActive : true,
        showResultsImmediately: Boolean(showResultsImmediately),
        createdBy: req.user._id,
      });

      await exam.save();
      await exam.populate('createdBy', 'name email');

      res.status(201).json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Update exam (DESIGNER own/ADMIN)
router.put(
  '/:examId',
  requireAuth,
  requireOwnershipOrAdmin,
  [
    body('title').optional().trim().notEmpty(),
    body('duration').optional().isInt({ min: 1 }),
    body('gracePeriod').optional().isInt({ min: 0 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
    body('showResultsImmediately').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const {
        title,
        description,
        duration,
        gracePeriod,
        maxAttempts,
        isActive,
        showResultsImmediately,
        resultsReleasedAt,
      } =
        req.body;

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (duration) exam.duration = duration;
      if (gracePeriod !== undefined) exam.gracePeriod = gracePeriod;
      if (maxAttempts !== undefined) exam.maxAttempts = maxAttempts;
      if (isActive !== undefined) exam.isActive = isActive;
      if (showResultsImmediately !== undefined) {
        exam.showResultsImmediately = showResultsImmediately;
        if (showResultsImmediately) {
          exam.resultsReleasedAt = null;
        }
      }
      if (resultsReleasedAt !== undefined) {
        exam.resultsReleasedAt = resultsReleasedAt ? new Date(resultsReleasedAt) : null;
      }

      await exam.save();
      await exam.populate('createdBy', 'name email');

      res.json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Delete exam (DESIGNER own/ADMIN)
router.delete(
  '/:examId',
  requireAuth,
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      await Exam.findByIdAndDelete(req.params.examId);
      res.json({ message: 'Exam deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Release results
router.post(
  '/:examId/release-results',
  requireAuth,
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      exam.resultsReleasedAt = new Date();
      await exam.save();
      await exam.populate('createdBy', 'name email');

      res.json({ exam });
    } catch (error) {
      next(error);
    }
  }
);

// Send certificates separately (for students who passed >= 60%)
router.post(
  '/:examId/send-certificates',
  requireAuth,
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Find all completed attempts for this exam
      const attempts = await ExamAttempt.find({
        examId: exam._id,
        isCompleted: true,
        isDisqualified: false,
      })
        .populate('userId', 'name email')
        .populate('examId', 'title')
        .populate('questionPaperId', '_id');

      const certificateResults = [];
      const template = await loadCertificateTemplate();

      // Process each attempt to check if they qualify for certificate
      for (const attempt of attempts) {
        const { summary } = await ensureScoreSummary(attempt);
        const percentage = summary?.percentage ?? 0;

        // Only send certificates to students who scored >= 60%
        if (percentage >= MIN_CERTIFICATION_PERCENTAGE) {
          const examTitle = attempt.examId?.title || attempt.examSnapshot?.title || 'Exam';
          const attemptDate = attempt.submitTime ? new Date(attempt.submitTime) : null;
          const issuedTimestamp = attemptDate ? attemptDate : new Date();

          const context = {
            studentName: attempt.userId?.name || 'Student',
            examTitle,
            attemptDate: attemptDate ? attemptDate.toLocaleDateString() : '',
            issuedOn: issuedTimestamp.toLocaleDateString(),
            percentage,
            score: summary?.totalScore ?? 0,
            maxScore: summary?.maxScore ?? 0,
            attemptId: attempt._id.toString(),
          };

          const renderedTemplate = applyCertificateTemplate(template, context);

          // TODO: Implement actual email sending service here
          // For now, we'll just mark that certificates were sent
          // In production, you would:
          // 1. Generate PDF certificate
          // 2. Send email with certificate attachment
          // 3. Use a service like nodemailer, SendGrid, etc.

          certificateResults.push({
            attemptId: attempt._id,
            studentName: attempt.userId?.name,
            studentEmail: attempt.userId?.email,
            percentage,
            certificateGenerated: true,
            // certificateSent: true, // Set when email is actually sent
          });
        }
      }

      // Mark exam with certificate sent timestamp
      exam.certificatesSentAt = new Date();
      await exam.save();

      res.json({
        success: true,
        message: `Certificates processed for ${certificateResults.length} student(s)`,
        count: certificateResults.length,
        certificates: certificateResults,
        exam: {
          _id: exam._id,
          title: exam.title,
          certificatesSentAt: exam.certificatesSentAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

