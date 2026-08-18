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
import { resolveTenantSnapshot } from '../utils/tenantResolver.js';
import { canCandidateViewScore } from '../utils/resultVisibility.js';

const router = express.Router();

// Get own profile (universal: all authenticated users)
router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const tenant = await resolveTenantSnapshot(user.tenantId, 'name code type');

    res.json({
      user: {
        ...user,
        tenantId: tenant?._id || null,
        tenant: tenant || null,
      },
    });
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
      examId: { $type: 'objectId' },
      $or: [
        { sessionId: { $type: 'objectId' } },
        { sessionId: null },
        { sessionId: { $exists: false } },
      ],
    })
      .populate(
        'examId',
        'title duration showResultsImmediately resultsReleasedAt certificatesSentAt allowCertification passingPercentage'
      )
      .populate('sessionId', 'startTime endTime')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Filter attempts based on release windows.
    // Candidates should see their own results only after release.
    // Reviewers/admins may see results immediately.
    const filteredAttempts = [];
    const scoreVisibleByAttemptId = new Map();
    const privilegedRoles = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'EXAM_CREATOR']);
    const userIsPrivileged = privilegedRoles.has(req.user.role);
    for (const attempt of attempts) {
      if (!attempt.examId) {
        // Exam deleted, skip
        continue;
      }

      const canReviewAnswers = userIsPrivileged
        ? true
        : await hasExamPermission(req.user._id, attempt.examId._id, 'REVIEW_ANSWERS');
      const certificatesReleased =
        Boolean(attempt.examId.certificatesSentAt) &&
        new Date(attempt.examId.certificatesSentAt) <= new Date();
      // Score visibility never depends on the disqualification reason — see
      // resultVisibility.js. A disqualified candidate still sees the row
      // (with its status), just not the score, until release.
      const scoreVisible = canCandidateViewScore({
        exam: attempt.examId,
        isPrivileged: userIsPrivileged,
        canReviewAnswers,
      });

      if (canReviewAnswers || scoreVisible || certificatesReleased || Boolean(attempt.isDisqualified)) {
        filteredAttempts.push(attempt);
        scoreVisibleByAttemptId.set(String(attempt._id), scoreVisible || canReviewAnswers);
      }
    }

    const results = await Promise.all(
      filteredAttempts.map(async (attempt) => {
        const { summary } = await ensureScoreSummary(attempt);
        const scoreVisible = scoreVisibleByAttemptId.get(String(attempt._id));
        return {
          attempt,
          score: scoreVisible ? summary : null,
          // Include results release info for frontend
          resultsReleasedAt: attempt.examId?.resultsReleasedAt || null,
          showResultsImmediately: attempt.examId?.showResultsImmediately || false,
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

