import express from 'express';
import QuestionPaper from '../models/QuestionPaper.js';
import Exam from '../models/Exam.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import { queueExamPackageRegeneration } from '../services/examPackageRegenerationService.js';

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

// Create question paper (requires CREATE_SESSION permission or EXAM_CREATOR)
router.post(
  '/:examId/question-papers/create',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can create question papers
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

      // Verify tenant access (exam must belong to user's tenant)
      if (req.user.role !== 'SUPER_ADMIN') {
        const userTenantId = req.user.tenantId;
        const examTenantId = exam.tenantId;
        
        if (!examTenantId || examTenantId.toString() !== userTenantId?.toString()) {
          return res.status(403).json({ error: 'Access denied - Exam does not belong to your tenant' });
        }
      }

      const { setName } = req.body;

      // Set tenant IDs from exam (question paper belongs to same tenant as exam)
      // Question papers inherit tenant from exam (examId is the link)
      // No need to store organizationId/instituteId separately as they're accessed via examId
      const questionPaper = new QuestionPaper({
        examId: req.params.examId,
        setName,
        isActive: true,
        createdBy: req.user._id,
      });

      await questionPaper.save();
      await questionPaper.populate('createdBy', 'name email');

      if (exam.examType !== 'OMR') {
        queueExamPackageRegeneration({
          examId: exam._id,
          userId: req.user._id,
          reason: 'QUESTION_PAPER_CREATED',
          forceRegenerate: true,
          questionPaperIds: [questionPaper._id],
        });
      }

      res.status(201).json({ questionPaper });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

