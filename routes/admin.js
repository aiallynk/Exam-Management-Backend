import express from 'express';
import User from '../models/User.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import SystemConfig from '../models/SystemConfig.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';

const router = express.Router();

// Get all students
router.get('/students', requireAuth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { role: 'STUDENT' };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const students = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Check blocked status for each student
    const studentsWithStatus = await Promise.all(
      students.map(async (student) => {
        const blockedConfig = await SystemConfig.findOne({
          key: `blocked_student_${student._id}`,
        });

        return {
          ...student.toObject(),
          isBlocked: blockedConfig?.value === 'true',
        };
      })
    );

    const total = await User.countDocuments(filter);

    res.json({
      students: studentsWithStatus,
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

// Block/Unblock student
router.post(
  '/students/:studentId/block',
  requireAuth,
  requireRole('ADMIN'),
  [
    body('blocked').isBoolean().withMessage('Blocked status must be a boolean'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const student = await User.findById(req.params.studentId);
      if (!student || student.role !== 'STUDENT') {
        return res.status(404).json({ error: 'Student not found' });
      }

      const { blocked } = req.body;
      const configKey = `blocked_student_${student._id}`;

      let config = await SystemConfig.findOne({ key: configKey });

      if (config) {
        config.value = blocked ? 'true' : 'false';
        config.updatedBy = req.user._id;
        await config.save();
      } else {
        config = new SystemConfig({
          key: configKey,
          value: blocked ? 'true' : 'false',
          description: `Block status for student ${student.email}`,
          updatedBy: req.user._id,
        });
        await config.save();
      }

      res.json({
        message: `Student ${blocked ? 'blocked' : 'unblocked'} successfully`,
        isBlocked: blocked,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Reset student password
router.post(
  '/students/:studentId/reset-password',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    try {
      const student = await User.findById(req.params.studentId);
      if (!student || student.role !== 'STUDENT') {
        return res.status(404).json({ error: 'Student not found' });
      }

      // Generate random password
      const newPassword = crypto.randomBytes(8).toString('hex');
      student.password = newPassword;
      await student.save();

      res.json({
        message: 'Password reset successfully',
        newPassword, // In production, send via email instead
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get student results
router.get(
  '/students/:studentId/results',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    try {
      const student = await User.findById(req.params.studentId);
      if (!student || student.role !== 'STUDENT') {
        return res.status(404).json({ error: 'Student not found' });
      }

      const { page = 1, limit = 20 } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const attempts = await ExamAttempt.find({
        userId: student._id,
        isCompleted: true,
      })
        .populate('examId', 'title duration')
        .populate('sessionId', 'startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

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

      const total = await ExamAttempt.countDocuments({
        userId: student._id,
        isCompleted: true,
      });

      res.json({
        student,
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
  }
);

// Create user (any role)
router.post(
  '/create-user',
  requireAuth,
  requireRole('ADMIN'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('role')
      .isIn(['STUDENT', 'DESIGNER', 'ADMIN'])
      .withMessage('Invalid role'),
    body('password')
      .optional()
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, role, password, ...otherFields } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Generate random password if not provided
      const userPassword = password || crypto.randomBytes(8).toString('hex');

      const user = new User({
        name,
        email,
        password: userPassword,
        role,
        ...otherFields,
      });

      await user.save();

      res.status(201).json({
        user: user.toJSON(),
        password: password ? undefined : userPassword, // Only return if auto-generated
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

