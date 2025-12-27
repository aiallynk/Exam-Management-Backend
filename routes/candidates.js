/**
 * Candidates Route (Universal)
 * 
 * Renamed from student.js to candidates.js for universal exam platform.
 * These endpoints are available to all users, not just "students".
 * 
 * Profile and password management: Available to all authenticated users
 * Results: Based on exam permissions, not user role
 */

import express from 'express';
import User from '../models/User.js';
import ExamAttempt from '../models/ExamAttempt.js';
import { requireAuth } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { ensureScoreSummary } from '../utils/attemptScores.js';
import { hasExamPermission } from '../middleware/examPermissions.js';

const router = express.Router();

// Get own profile (universal: all authenticated users)
router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password')
      .populate('tenantId', 'name code type');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Update profile (universal: all authenticated users)
router.put(
  '/profile',
  requireAuth,
  [
    body('name').optional().trim().notEmpty(),
    body('mobile').optional().trim(),
    body('college').optional().trim(), // Deprecated but kept for backward compatibility
    body('degree').optional().trim(), // Deprecated but kept for backward compatibility
    body('branch').optional().trim(), // Deprecated but kept for backward compatibility
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

      const { name, mobile } = req.body;

      if (name) user.name = name;
      if (mobile !== undefined) user.mobile = mobile;

      await user.save();

      res.json({ user });
    } catch (error) {
      next(error);
    }
  }
);

// Change password (universal: all authenticated users)
router.post(
  '/change-password',
  requireAuth,
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

// Get own results (universal: based on exam permissions)
// Users can see their own results for exams they attempted
router.get('/results', requireAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get all attempts by this user
    const attempts = await ExamAttempt.find({
      userId: req.user._id,
      isCompleted: true,
    })
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt certificatesSentAt')
      .populate('sessionId', 'startTime endTime')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Filter attempts based on exam permissions
    // Users can only see results for exams where:
    // 1. Results are shown immediately, OR
    // 2. Results have been released, OR
    // 3. User has VIEW_RESULTS permission
    const filteredAttempts = [];
    for (const attempt of attempts) {
      if (!attempt.examId) {
        // Exam deleted, skip
        continue;
      }

      const canViewResults = await hasExamPermission(req.user._id, attempt.examId._id, 'VIEW_RESULTS');
      const resultsReleased = attempt.examId.showResultsImmediately || attempt.examId.resultsReleasedAt;

      if (canViewResults || resultsReleased) {
        filteredAttempts.push(attempt);
      }
    }

    const results = await Promise.all(
      filteredAttempts.map(async (attempt) => {
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
        total: filteredAttempts.length, // Return filtered count
        pages: Math.ceil(filteredAttempts.length / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

