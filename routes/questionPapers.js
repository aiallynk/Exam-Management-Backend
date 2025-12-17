import express from 'express';
import QuestionPaper from '../models/QuestionPaper.js';
import Exam from '../models/Exam.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();

// Get all question papers for an exam
router.get('/:examId/question-papers', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const questionPapers = await QuestionPaper.find({
      examId: req.params.examId,
    })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ questionPapers });
  } catch (error) {
    next(error);
  }
});

// Create question paper (DESIGNER/ADMIN/TEACHER)
router.post(
  '/:examId/question-papers/create',
  requireAuth,
  requireTenant,
  requireRole('DESIGNER', 'ADMIN', 'TEACHER', 'INSTITUTE_ADMIN'),
  requireOwnershipOrAdmin,
  [
    body('setName').trim().notEmpty().withMessage('Set name is required'),
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

      const { setName } = req.body;

      const questionPaper = new QuestionPaper({
        examId: req.params.examId,
        setName,
        isActive: true,
        createdBy: req.user._id,
      });

      await questionPaper.save();
      await questionPaper.populate('createdBy', 'name email');

      res.status(201).json({ questionPaper });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

