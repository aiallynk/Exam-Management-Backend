import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { body, validationResult } from 'express-validator';
import {
  getAllLanguages,
  getLanguageByCode,
  getDefaultLanguage,
  createLanguage,
  updateLanguage,
  deleteLanguage,
  getExamLanguages,
  updateExamLanguages,
  addQuestionTranslation,
  getQuestionTranslation,
  removeQuestionTranslation,
} from '../services/languageService.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';

const router = express.Router();

// Get all languages
router.get('/', async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const languages = await getAllLanguages(includeInactive);
    res.json({ languages });
  } catch (error) {
    next(error);
  }
});

// Get default language
router.get('/default', async (req, res, next) => {
  try {
    const language = await getDefaultLanguage();
    res.json({ language });
  } catch (error) {
    next(error);
  }
});

// Get language by code
router.get('/:code', async (req, res, next) => {
  try {
    const language = await getLanguageByCode(req.params.code);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }
    res.json({ language });
  } catch (error) {
    next(error);
  }
});

// Create language (admin only)
router.post(
  '/',
  requireAuth,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  [
    body('code').trim().isLength({ min: 2, max: 10 }).withMessage('Code must be 2-10 characters'),
    body('name').trim().notEmpty().withMessage('Name is required'),
  ],
  auditLog(AUDIT_ACTIONS.LANGUAGE_ADDED, (req) => ({
    resourceType: 'Language',
    code: req.body.code,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const language = await createLanguage({
        ...req.body,
        createdBy: req.user._id,
      });
      res.status(201).json({ language });
    } catch (error) {
      next(error);
    }
  }
);

// Update language (admin only)
router.put(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const language = await updateLanguage(req.params.id, req.body);
      res.json({ language });
    } catch (error) {
      next(error);
    }
  }
);

// Delete language (admin only)
router.delete(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      await deleteLanguage(req.params.id);
      res.json({ message: 'Language deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Get exam languages
router.get('/exam/:examId', requireAuth, async (req, res, next) => {
  try {
    const result = await getExamLanguages(req.params.examId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Update exam languages
router.put(
  '/exam/:examId',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const result = await updateExamLanguages(req.params.examId, req.body);
      res.json({ exam: result });
    } catch (error) {
      next(error);
    }
  }
);

// Add translation to question
router.post(
  '/question/:questionId/translation/:languageCode',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  [
    body('questionText').optional().trim(),
    body('options').optional(),
    body('passage').optional().trim(),
  ],
  auditLog(AUDIT_ACTIONS.TRANSLATION_ADDED, (req) => ({
    resourceType: 'Question',
    resourceId: req.params.questionId,
    languageCode: req.params.languageCode,
  })),
  async (req, res, next) => {
    try {
      const question = await addQuestionTranslation(
        req.params.questionId,
        req.params.languageCode,
        req.body
      );
      res.json({ question });
    } catch (error) {
      next(error);
    }
  }
);

// Get question translation
router.get('/question/:questionId/translation/:languageCode', async (req, res, next) => {
  try {
    const translation = await getQuestionTranslation(
      req.params.questionId,
      req.params.languageCode
    );
    res.json({ translation });
  } catch (error) {
    next(error);
  }
});

// Remove question translation
router.delete(
  '/question/:questionId/translation/:languageCode',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const question = await removeQuestionTranslation(
        req.params.questionId,
        req.params.languageCode
      );
      res.json({ question });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
