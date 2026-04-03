import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import QuestionPaper from '../models/QuestionPaper.js';
import {
  getSectionsByQuestionPaper,
  getSectionById,
  createSection,
  updateSection,
  deleteSection,
  reorderSections,
  getSectionsWithStats,
  startSectionTimer,
  getSectionTimerStatus,
  lockSection,
  updateSectionTimeSpent,
  validateSectionNavigation,
} from '../services/sectionService.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import { queueExamPackageRegeneration } from '../services/examPackageRegenerationService.js';

const router = express.Router();

const queueRegenerationForQuestionPaper = async (questionPaperId, userId, reason) => {
  try {
    const questionPaper = await QuestionPaper.findById(questionPaperId)
      .populate('examId', '_id examType');

    const exam = questionPaper?.examId;
    if (!exam?._id || exam.examType === 'OMR') {
      return;
    }

    queueExamPackageRegeneration({
      examId: exam._id,
      userId,
      reason,
      forceRegenerate: true,
      questionPaperIds: [questionPaperId],
    });
  } catch (error) {
    console.error(
      `[Package Regeneration] Failed to enqueue for questionPaper ${questionPaperId}:`,
      error?.message || error
    );
  }
};

// Get sections for question paper
router.get('/question-paper/:questionPaperId', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const { questionPaperId } = req.params;
    
    // Verify question paper exists
    const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
    const Exam = (await import('../models/Exam.js')).default;
    
    const questionPaper = await QuestionPaper.findById(questionPaperId).populate('examId', 'tenantId');
    if (!questionPaper) {
      return res.status(404).json({ error: 'Question paper not found' });
    }

    // Check tenant boundaries - user must be in same tenant as exam (unless SUPER_ADMIN)
    if (req.user.role !== 'SUPER_ADMIN') {
      const userTenantId = req.user.tenantId;
      const examTenantId = questionPaper.examId?.tenantId;
      
      if (userTenantId && examTenantId && userTenantId.toString() !== examTenantId.toString()) {
        return res.status(403).json({ error: 'Access denied - Question paper belongs to different tenant' });
      }
    }

    const sections = await getSectionsByQuestionPaper(questionPaperId);
    res.json({ sections });
  } catch (error) {
    next(error);
  }
});

// Get sections with stats
router.get('/question-paper/:questionPaperId/stats', requireAuth, async (req, res, next) => {
  try {
    const sections = await getSectionsWithStats(req.params.questionPaperId);
    res.json({ sections });
  } catch (error) {
    next(error);
  }
});

// Get section by ID
router.get('/:sectionId', requireAuth, async (req, res, next) => {
  try {
    const section = await getSectionById(req.params.sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }
    res.json({ section });
  } catch (error) {
    next(error);
  }
});

// Create section
router.post(
  '/',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  [
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('duration').isInt({ min: 1 }).withMessage('Duration must be at least 1 minute'),
  ],
  auditLog(AUDIT_ACTIONS.SECTION_CREATED, (req) => ({
    resourceType: 'Section',
    questionPaperId: req.body.questionPaperId,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const section = await createSection(req.body);
      void queueRegenerationForQuestionPaper(
        section.questionPaperId,
        req.user._id,
        'SECTION_CREATED'
      );
      res.status(201).json({ section });
    } catch (error) {
      next(error);
    }
  }
);

// Update section
router.put(
  '/:sectionId',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.SECTION_UPDATED, (req) => ({
    resourceType: 'Section',
    resourceId: req.params.sectionId,
  })),
  async (req, res, next) => {
    try {
      const section = await updateSection(req.params.sectionId, req.body);
      void queueRegenerationForQuestionPaper(
        section.questionPaperId,
        req.user._id,
        'SECTION_UPDATED'
      );
      res.json({ section });
    } catch (error) {
      next(error);
    }
  }
);

// Delete section
router.delete(
  '/:sectionId',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.SECTION_DELETED, (req) => ({
    resourceType: 'Section',
    resourceId: req.params.sectionId,
  })),
  async (req, res, next) => {
    try {
      const deletedSection = await deleteSection(req.params.sectionId);
      void queueRegenerationForQuestionPaper(
        deletedSection.questionPaperId,
        req.user._id,
        'SECTION_DELETED'
      );
      res.json({ message: 'Section deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Reorder sections
router.put(
  '/question-paper/:questionPaperId/reorder',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const sections = await reorderSections(req.params.questionPaperId, req.body.sectionOrders);
      void queueRegenerationForQuestionPaper(
        req.params.questionPaperId,
        req.user._id,
        'SECTION_REORDERED'
      );
      res.json({ sections });
    } catch (error) {
      next(error);
    }
  }
);

// Start section timer
router.post(
  '/attempt/:attemptId/start/:sectionId',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await startSectionTimer(req.params.attemptId, req.params.sectionId);
      res.json({
        attempt: result.attempt,
        status: result.status,
        sectionState: result.sectionState,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get section timer status
router.get('/attempt/:attemptId/section/:sectionId/timer', requireAuth, async (req, res, next) => {
  try {
    const result = await getSectionTimerStatus(req.params.attemptId, req.params.sectionId);
    res.json({
      status: result.status,
      sectionState: result.sectionState,
      nextSectionId: result.nextSectionId || null,
    });
  } catch (error) {
    next(error);
  }
});

// Lock section
router.post(
  '/attempt/:attemptId/lock/:sectionId',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await lockSection(req.params.attemptId, req.params.sectionId);
      res.json({
        attempt: result.attempt,
        status: result.status,
        sectionState: result.sectionState,
        nextSectionId: result.nextSectionId || null,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Update section time spent
router.put(
  '/attempt/:attemptId/section/:sectionId/time',
  requireAuth,
  [
    body('timeSpentSeconds').isInt({ min: 0 }).withMessage('Time spent must be non-negative'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const result = await updateSectionTimeSpent(
        req.params.attemptId,
        req.params.sectionId,
        req.body.timeSpentSeconds
      );
      res.json({
        attempt: result.attempt,
        status: result.status || null,
        sectionState: result.sectionState || null,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Validate section navigation
router.post(
  '/attempt/:attemptId/validate-navigation',
  requireAuth,
  [
    body('fromSectionId').notEmpty().withMessage('From section ID is required'),
    body('toSectionId').notEmpty().withMessage('To section ID is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      await validateSectionNavigation(
        req.params.attemptId,
        req.body.fromSectionId,
        req.body.toSectionId
      );
      res.json({ valid: true });
    } catch (error) {
      res.status(400).json({ error: error.message, valid: false });
    }
  }
);

export default router;
