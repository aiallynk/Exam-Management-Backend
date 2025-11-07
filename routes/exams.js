import express from 'express';
import Exam from '../models/Exam.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';

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
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { title, description, duration, gracePeriod, maxAttempts, isActive } =
        req.body;

      const exam = new Exam({
        title,
        description,
        duration,
        gracePeriod: gracePeriod || 0,
        maxAttempts: maxAttempts || 1,
        isActive: isActive !== undefined ? isActive : true,
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

      const { title, description, duration, gracePeriod, maxAttempts, isActive } =
        req.body;

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (duration) exam.duration = duration;
      if (gracePeriod !== undefined) exam.gracePeriod = gracePeriod;
      if (maxAttempts !== undefined) exam.maxAttempts = maxAttempts;
      if (isActive !== undefined) exam.isActive = isActive;

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

export default router;

