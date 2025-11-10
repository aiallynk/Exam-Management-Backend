import express from 'express';
import User from '../models/User.js';
import ExamAttempt from '../models/ExamAttempt.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { ensureScoreSummary } from '../utils/attemptScores.js';

const router = express.Router();

// Get own profile
router.get('/profile', requireAuth, requireRole('STUDENT'), async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Update profile
router.put(
  '/profile',
  requireAuth,
  requireRole('STUDENT'),
  [
    body('name').optional().trim().notEmpty(),
    body('mobile').optional().trim(),
    body('college').optional().trim(),
    body('degree').optional().trim(),
    body('branch').optional().trim(),
    body('hometown').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findById(req.user._id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { name, mobile, college, degree, branch, hometown } = req.body;

      if (name) user.name = name;
      if (mobile !== undefined) user.mobile = mobile;
      if (college !== undefined) user.college = college;
      if (degree !== undefined) user.degree = degree;
      if (branch !== undefined) user.branch = branch;
      if (hometown !== undefined) user.hometown = hometown;

      await user.save();

      res.json({ user });
    } catch (error) {
      next(error);
    }
  }
);

// Change password
router.post(
  '/change-password',
  requireAuth,
  requireRole('STUDENT'),
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = await User.findById(req.user._id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { currentPassword, newPassword } = req.body;

      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      user.password = newPassword;
      await user.save();

      res.json({ message: 'Password changed successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Get own results
router.get('/results', requireAuth, requireRole('STUDENT'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const attempts = await ExamAttempt.find({
      userId: req.user._id,
      isCompleted: true,
    })
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName')
      .populate('sessionId', 'startTime endTime')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const results = await Promise.all(
      attempts.map(async (attempt) => {
        const { summary } = await ensureScoreSummary(attempt);
        return {
          attempt,
          score: summary,
        };
      })
    );

    const total = await ExamAttempt.countDocuments({
      userId: req.user._id,
      isCompleted: true,
    });

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

