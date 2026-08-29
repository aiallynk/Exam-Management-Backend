import express from 'express';
import multer from 'multer';
import path from 'path';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { uploadRateLimiter } from '../middleware/rateLimiter.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import {
  interpretGuidelineText,
  interpretGuidelineFile,
  saveGuidelineProposalAsFrameworkDraft,
  getGuidelineDocument,
  GuidelineError,
} from '../services/guidelineInterpretationService.js';
import { getJobStatus } from '../services/jobs/jobDispatcherService.js';

const router = express.Router();
const canManage = [requireAuth, requireTenant, requireRole('ACADEMIC_ADMIN', 'TENANT_ADMIN'), requireTenantFeature('AI_GUIDELINE_INTERPRETATION')];

const guidelineUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.docx', '.doc'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Invalid file type. Allowed: PDF, TXT, DOCX, DOC'));
  },
});

const respondError = (res, next, error) => {
  if (error instanceof GuidelineError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
};

router.post(
  '/interpret/text',
  ...canManage,
  body('text').isString().isLength({ min: 10, max: 50000 }),
  body('title').optional().isString().isLength({ max: 300 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const result = await interpretGuidelineText({
        tenantId: req.user.tenantId,
        userId: req.user._id,
        text: req.body.text,
        title: req.body.title,
      });
      return res.status(202).json(result);
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.post(
  '/interpret/file',
  ...canManage,
  uploadRateLimiter,
  guidelineUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'A guideline file is required.' });
      const result = await interpretGuidelineFile({
        tenantId: req.user.tenantId,
        userId: req.user._id,
        file: req.file,
        title: req.body?.title,
      });
      return res.status(202).json(result);
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.get('/:id', ...canManage, async (req, res, next) => {
  try {
    const item = await getGuidelineDocument({ tenantId: req.user.tenantId, userId: req.user._id, guidelineDocumentId: req.params.id });
    const job = item.jobId ? getJobStatus(item.jobId) : null;
    return res.json({ item, job });
  } catch (error) {
    return respondError(res, next, error);
  }
});

router.post(
  '/:id/save-draft',
  ...canManage,
  body('frameworkId').optional().isMongoId(),
  body('frameworkName').optional().isString().isLength({ max: 300 }),
  body('reviewedProposal').optional().isObject(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const result = await saveGuidelineProposalAsFrameworkDraft({
        tenantId: req.user.tenantId,
        userId: req.user._id,
        guidelineDocumentId: req.params.id,
        frameworkId: req.body.frameworkId,
        frameworkName: req.body.frameworkName,
        reviewedProposal: req.body.reviewedProposal,
      });
      return res.status(201).json(result);
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

export default router;
