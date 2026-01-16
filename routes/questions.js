import express from 'express';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Exam from '../models/Exam.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import { parseCSV, validateQuestionCSV } from '../utils/csv.js';

const router = express.Router();

// Get all questions for an exam (via question papers)
router.get('/:examId/questions', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const questionPapers = await QuestionPaper.find({ examId: req.params.examId });
    const questionPaperIds = questionPapers.map((qp) => qp._id);

    const questions = await Question.find({
      questionPaperId: { $in: questionPaperIds },
    })
      .populate('questionPaperId', 'setName')
      .sort({ order: 1 });

    res.json({ questions });
  } catch (error) {
    next(error);
  }
});

// Get questions for a specific question paper
router.get('/:examId/question-papers/:paperId/questions', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const { examId, paperId } = req.params;
    
    // Verify exam exists and user has access
    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // Check tenant boundaries - user must be in same tenant as exam (unless SUPER_ADMIN)
    if (req.user.role !== 'SUPER_ADMIN') {
      const userTenantId = req.user.tenantId;
      const examTenantId = exam.tenantId;
      
      if (userTenantId && examTenantId && userTenantId.toString() !== examTenantId.toString()) {
        return res.status(403).json({ error: 'Access denied - Exam belongs to different tenant' });
      }
    }

    // Verify question paper belongs to this exam
    const questionPaper = await QuestionPaper.findById(paperId);
    if (!questionPaper) {
      return res.status(404).json({ error: 'Question paper not found' });
    }
    
    if (questionPaper.examId.toString() !== examId) {
      return res.status(400).json({ error: 'Question paper does not belong to this exam' });
    }

    // Get questions for this question paper
    const questions = await Question.find({
      questionPaperId: paperId,
    })
      .populate('sectionId', 'name order duration') // Populate section info
      .sort({ order: 1 });

    res.json({ questions });
  } catch (error) {
    next(error);
  }
});

// Create question (requires CREATE_SESSION permission or EXAM_CREATOR)
router.post(
  '/:examId/questions',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can create questions
  requireOwnershipOrAdmin,
  [
    body('questionText').trim().notEmpty().withMessage('Question text is required'),
    body('questionType')
      .isIn(['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'SHORT_ANSWER', 'PARAGRAPH', 'NUMBER'])
      .withMessage('Invalid question type'),
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('order').isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
    body('imageUrl').optional({ nullable: true }).isString().withMessage('Image URL must be a string'),
    body('passage').optional({ nullable: true }).isString().withMessage('Passage must be a string'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { questionText, questionType, options, correctAnswer, points, order, questionPaperId, imageUrl, sectionId } =
        req.body;
      const { passage } = req.body;

      // Verify question paper belongs to exam
      const questionPaper = await QuestionPaper.findOne({
        _id: questionPaperId,
        examId: req.params.examId,
      });

      if (!questionPaper) {
        return res.status(404).json({ error: 'Question paper not found' });
      }

      // Verify exam belongs to user's tenant (for non-SUPER_ADMIN)
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      if (req.user.role !== 'SUPER_ADMIN') {
        const userTenantId = req.user.tenantId;
        const examTenantId = exam.tenantId;
        
        if (!examTenantId || examTenantId.toString() !== userTenantId?.toString()) {
          return res.status(403).json({ error: 'Access denied - Exam does not belong to your tenant' });
        }
      }

      // If sectionId is provided, verify it belongs to the question paper
      if (sectionId) {
        const Section = (await import('../models/Section.js')).default;
        const section = await Section.findOne({
          _id: sectionId,
          questionPaperId: questionPaperId,
        });
        if (!section) {
          return res.status(400).json({ error: 'Section does not belong to this question paper' });
        }
      }

      const question = new Question({
        questionPaperId,
        questionText,
        questionType,
        options,
        correctAnswer,
        imageUrl: typeof imageUrl === 'string' && imageUrl.trim().length ? imageUrl.trim() : undefined,
        passage: typeof passage === 'string' && passage.trim().length ? passage.trim() : undefined,
        points: points || 1,
        order: order || 0,
        sectionId: sectionId || undefined, // Include sectionId if provided
      });

      await question.save();
      await question.populate('questionPaperId', 'setName');

      res.status(201).json({ question });
    } catch (error) {
      next(error);
    }
  }
);

// Get single question
router.get('/:examId/questions/:questionId', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const question = await Question.findById(req.params.questionId).populate(
      'questionPaperId',
      'setName examId'
    );

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    // Verify question belongs to exam
    const questionPaper = await QuestionPaper.findById(question.questionPaperId._id);
    if (questionPaper.examId.toString() !== req.params.examId) {
      return res.status(404).json({ error: 'Question not found for this exam' });
    }

    res.json({ question });
  } catch (error) {
    next(error);
  }
});

// Update question
router.put(
  '/:examId/questions/:questionId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR'), // Only EXAM_CREATOR can modify questions
  requireOwnershipOrAdmin,
  [
    body('questionText').optional().trim().notEmpty(),
    body('questionType').optional().isIn(['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'SHORT_ANSWER', 'PARAGRAPH', 'NUMBER']),
    body('imageUrl').optional({ nullable: true }).isString().withMessage('Image URL must be a string'),
    body('passage').optional({ nullable: true }).isString().withMessage('Passage must be a string'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const question = await Question.findById(req.params.questionId);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      // Verify question belongs to exam
      const questionPaper = await QuestionPaper.findById(question.questionPaperId);
      if (questionPaper.examId.toString() !== req.params.examId) {
        return res.status(404).json({ error: 'Question not found for this exam' });
      }

      const { questionText, questionType, options, correctAnswer, points, order, imageUrl, passage } =
        req.body;

      if (questionText) question.questionText = questionText;
      if (questionType) question.questionType = questionType;
      if (options !== undefined) question.options = options;
      if (correctAnswer !== undefined) question.correctAnswer = correctAnswer;
      if (points !== undefined) question.points = points;
      if (order !== undefined) question.order = order;
      if (imageUrl !== undefined) {
        const normalized = typeof imageUrl === 'string' ? imageUrl.trim() : '';
        question.imageUrl = normalized.length ? normalized : null;
      }
      if (passage !== undefined) {
        const normalizedPassage = typeof passage === 'string' ? passage.trim() : '';
        question.passage = normalizedPassage.length ? normalizedPassage : null;
      }

      await question.save();
      await question.populate('questionPaperId', 'setName');

      res.json({ question });
    } catch (error) {
      next(error);
    }
  }
);

// Delete question
router.delete(
  '/:examId/questions/:questionId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR'), // Only EXAM_CREATOR can modify questions
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const question = await Question.findById(req.params.questionId);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      // Verify question belongs to exam
      const questionPaper = await QuestionPaper.findById(question.questionPaperId);
      if (questionPaper.examId.toString() !== req.params.examId) {
        return res.status(404).json({ error: 'Question not found for this exam' });
      }

      await Question.findByIdAndDelete(req.params.questionId);
      res.json({ message: 'Question deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Import questions from CSV
router.post(
  '/:examId/questions/import',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR'), // Only EXAM_CREATOR can modify questions
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const { csvContent, questionPaperId } = req.body;

      if (!csvContent || !questionPaperId) {
        return res.status(400).json({
          error: 'CSV content and question paper ID are required',
        });
      }

      // Verify question paper belongs to exam
      const questionPaper = await QuestionPaper.findOne({
        _id: questionPaperId,
        examId: req.params.examId,
      });

      if (!questionPaper) {
        return res.status(404).json({ error: 'Question paper not found' });
      }

      const records = parseCSV(csvContent);
      validateQuestionCSV(records);

      const questions = records.map((record, index) => ({
        questionPaperId,
        questionText: record.questionText,
        questionType: record.questionType,
        options: record.options ? JSON.parse(record.options) : undefined,
        correctAnswer: record.correctAnswer || '',
        points: parseInt(record.points) || 1,
        order: parseInt(record.order) || index,
      }));

      const createdQuestions = await Question.insertMany(questions);

      res.status(201).json({
        message: `Imported ${createdQuestions.length} questions`,
        questions: createdQuestions,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

