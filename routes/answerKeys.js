import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import {
  getAnswerKey,
  getAllAnswerKeys,
  createManualAnswerKey,
  importAnswerKey,
  detectMismatches,
  applyAnswerKey,
  mapAnswerKeyToQuestions,
} from '../services/answerKeyService.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

const router = express.Router();

// Get answer key
router.get('/exam/:examId', requireAuth, async (req, res, next) => {
  try {
    const answerKey = await getAnswerKey(req.params.examId, req.query.questionPaperId);
    if (!answerKey) {
      return res.status(404).json({ error: 'Answer key not found' });
    }
    res.json({ answerKey });
  } catch (error) {
    next(error);
  }
});

// Get all answer keys for exam
router.get('/exam/:examId/all', requireAuth, async (req, res, next) => {
  try {
    const answerKeys = await getAllAnswerKeys(req.params.examId);
    res.json({ answerKeys });
  } catch (error) {
    next(error);
  }
});

// Create manual answer key
router.post(
  '/manual',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.ANSWER_KEY_IMPORTED, (req) => ({
    resourceType: 'AnswerKey',
    examId: req.body.examId,
    source: 'MANUAL',
  })),
  async (req, res, next) => {
    try {
      const answerKey = await createManualAnswerKey(req.body, req.user._id);
      res.status(201).json({ answerKey });
    } catch (error) {
      next(error);
    }
  }
);

// Import answer key from file
router.post(
  '/import',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  upload.single('file'),
  auditLog(AUDIT_ACTIONS.ANSWER_KEY_IMPORTED, (req) => ({
    resourceType: 'AnswerKey',
    examId: req.body.examId,
    source: req.file ? req.file.originalname : 'UNKNOWN',
  })),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { examId, questionPaperId, source } = req.body;
      if (!examId) {
        return res.status(400).json({ error: 'Exam ID is required' });
      }

      const result = await importAnswerKey(
        examId,
        questionPaperId || null,
        req.file,
        source || 'IMPORTED',
        req.user._id
      );

      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Map answer key to questions
router.post(
  '/map',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const { examId, questionPaperId, answers } = req.body;
      const mapping = await mapAnswerKeyToQuestions(examId, questionPaperId, answers);
      res.json(mapping);
    } catch (error) {
      next(error);
    }
  }
);

// Detect mismatches
router.get('/:answerKeyId/mismatches', requireAuth, async (req, res, next) => {
  try {
    const result = await detectMismatches(req.params.answerKeyId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Apply answer key to questions
router.post(
  '/:answerKeyId/apply',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  auditLog(AUDIT_ACTIONS.ANSWER_KEY_APPLIED, (req) => ({
    resourceType: 'AnswerKey',
    resourceId: req.params.answerKeyId,
  })),
  async (req, res, next) => {
    try {
      const result = await applyAnswerKey(
        req.params.answerKeyId,
        req.body.questionIds || null
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
