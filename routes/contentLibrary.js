// LEGACY COMPATIBILITY — prefer /api/library-resources for educator-facing
// Content Library product operations. This router remains for ad hoc
// ContextSource asset operations and backward-compatible clients until
// all consumers migrate (see docs/XAMIGO_KNOWLEDGE_INTELLIGENCE_COMPLETION_STATUS.md).
import express from 'express';
import multer from 'multer';
import path from 'path';
import { body, query, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { uploadRateLimiter } from '../middleware/rateLimiter.js';
import { enforceContextSourceLimit } from '../middleware/planLimits.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import {
  ContentLibraryError,
  uploadContentLibraryFile,
  uploadContentLibraryUrl,
  listContentLibrarySources,
  getContentLibrarySourceForRead,
  updateContentLibrarySourceMetadata,
  deleteContentLibrarySource,
  reprocessContentLibrarySource,
  getContentLibraryOriginalSignedUrl,
} from '../services/contentLibraryService.js';

const router = express.Router();

// Storage/organization of Content Library material is deliberately
// decoupled from AI generation (Part P): gated on CONTENT_LIBRARY, a
// capability every tenant has by default (see tenantFeatureService.js),
// NOT on SOURCE_GROUNDED_GENERATION. A tenant without AI generation can
// still store/browse/organize a Content Library — uploads there simply
// skip the embed/index step (services/contentLibraryService.js) and are
// marked "stored, AI indexing unavailable" rather than being blocked
// outright. Only POST /sources/:id/reprocess, which explicitly re-runs
// embedding, still requires SOURCE_GROUNDED_GENERATION below.
const canAccess = [requireAuth, requireTenant, requireRole('TEACHER', 'ACADEMIC_ADMIN', 'EXAM_CREATOR', 'TENANT_ADMIN'), requireTenantFeature('CONTENT_LIBRARY')];

const handleMulterUploadError = (err, req, res, next) => {
  if (!err) return next();
  if (err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
  }
  return res.status(400).json({ error: err.message || 'File upload failed' });
};

// Broader than the existing ad hoc contextSourceUpload allowlist (Part E:
// "allow storage if product policy permits" even for a type the current
// extractor cannot index) — an unsupported type is still stored and
// clearly labelled UNSUPPORTED_FOR_AI, never silently rejected outright.
const libraryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.csv', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Invalid file type. Allowed: PDF, TXT, CSV, XLSX, XLS, DOCX, DOC, PPTX, PPT, PNG, JPG, JPEG, SVG, GIF, WEBP'));
  },
});

const respondError = (res, next, error) => {
  if (error instanceof ContentLibraryError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
};

router.get(
  '/sources',
  ...canAccess,
  [
    query('contentType').optional().isString(),
    query('status').optional().isString(),
    query('uploadedBy').optional().isMongoId(),
    query('search').optional().isString().isLength({ max: 200 }),
    query('scope').optional().isIn(['mine', 'all']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const sources = await listContentLibrarySources(req.user, req.query);
      return res.json({ sources });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.get('/sources/:id', ...canAccess, async (req, res, next) => {
  try {
    const source = await getContentLibrarySourceForRead(req.user, req.params.id);
    return res.json({ source });
  } catch (error) {
    return respondError(res, next, error);
  }
});

router.get('/sources/:id/original', ...canAccess, async (req, res, next) => {
  try {
    const result = await getContentLibraryOriginalSignedUrl(req.user, req.params.id);
    return res.json(result);
  } catch (error) {
    return respondError(res, next, error);
  }
});

router.post(
  '/sources',
  uploadRateLimiter,
  requireAuth,
  requireTenant,
  requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  requireTenantFeature('CONTENT_LIBRARY'),
  enforceContextSourceLimit,
  libraryUpload.single('file'),
  handleMulterUploadError,
  [
    body('contentType').optional().isString(),
    body('visibility').optional().isIn(['PRIVATE', 'COURSE', 'SHARED']),
    // multipart/form-data has no nested-object field type — the frontend
    // sends this as a JSON string (FormData.append('academicScope',
    // JSON.stringify(...))), which the handler below parses. isObject()
    // here would reject every real request (req.body.academicScope is
    // always a string for a multipart body), unlike the JSON-bodied
    // /sources/url route below where isObject() is correct.
    body('academicScope').optional().isString(),
    body('chapter').optional().isString().isLength({ max: 200 }),
    body('unit').optional().isString().isLength({ max: 200 }),
    body('topic').optional().isString().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

      let academicScope = {};
      if (req.body.academicScope) {
        try { academicScope = typeof req.body.academicScope === 'string' ? JSON.parse(req.body.academicScope) : req.body.academicScope; } catch { academicScope = {}; }
      }

      const source = await uploadContentLibraryFile(req.user, {
        file: req.file,
        contentType: req.body.contentType,
        visibility: req.body.visibility,
        academicScope,
        chapter: req.body.chapter,
        unit: req.body.unit,
        topic: req.body.topic,
      });

      await logAuditEvent(AUDIT_ACTIONS.CONTENT_LIBRARY_SOURCE_UPLOADED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'ContextSource', resourceId: source._id,
        sourceType: 'FILE', contentType: source.contentType, visibility: source.visibility,
      });

      return res.status(source.status === 'FAILED' ? 200 : 201).json({ source });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.post(
  '/sources/url',
  uploadRateLimiter,
  requireAuth,
  requireTenant,
  requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  requireTenantFeature('CONTENT_LIBRARY'),
  enforceContextSourceLimit,
  [
    body('url').isURL({ protocols: ['http', 'https'], require_protocol: true }).withMessage('A valid http(s) URL is required'),
    body('contentType').optional().isString(),
    body('visibility').optional().isIn(['PRIVATE', 'COURSE', 'SHARED']),
    body('academicScope').optional().isObject(),
    body('chapter').optional().isString().isLength({ max: 200 }),
    body('unit').optional().isString().isLength({ max: 200 }),
    body('topic').optional().isString().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const source = await uploadContentLibraryUrl(req.user, {
        url: req.body.url,
        contentType: req.body.contentType,
        visibility: req.body.visibility,
        academicScope: req.body.academicScope || {},
        chapter: req.body.chapter,
        unit: req.body.unit,
        topic: req.body.topic,
      });

      await logAuditEvent(AUDIT_ACTIONS.CONTENT_LIBRARY_SOURCE_UPLOADED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'ContextSource', resourceId: source._id,
        sourceType: 'URL', contentType: source.contentType, visibility: source.visibility,
      });

      return res.status(source.status === 'FAILED' ? 200 : 201).json({ source });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.patch(
  '/sources/:id',
  requireAuth,
  requireTenant,
  requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  requireTenantFeature('CONTENT_LIBRARY'),
  [
    body('contentType').optional().isString(),
    body('visibility').optional().isIn(['PRIVATE', 'COURSE', 'SHARED']),
    body('academicScope').optional().isObject(),
    body('chapter').optional().isString().isLength({ max: 200 }),
    body('unit').optional().isString().isLength({ max: 200 }),
    body('topic').optional().isString().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const source = await updateContentLibrarySourceMetadata(req.user, req.params.id, req.body);
      await logAuditEvent(AUDIT_ACTIONS.CONTENT_LIBRARY_SOURCE_UPDATED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'ContextSource', resourceId: source._id,
      });
      return res.json({ source });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.post(
  '/sources/:id/reprocess',
  requireAuth,
  requireTenant,
  requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  requireTenantFeature('SOURCE_GROUNDED_GENERATION'),
  async (req, res, next) => {
    try {
      const source = await reprocessContentLibrarySource(req.user, req.params.id);
      await logAuditEvent(AUDIT_ACTIONS.CONTENT_LIBRARY_SOURCE_REPROCESSED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'ContextSource', resourceId: source._id,
      });
      return res.json({ source });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.delete(
  '/sources/:id',
  requireAuth,
  requireTenant,
  requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  requireTenantFeature('CONTENT_LIBRARY'),
  async (req, res, next) => {
    try {
      await deleteContentLibrarySource(req.user, req.params.id);
      await logAuditEvent(AUDIT_ACTIONS.CONTENT_LIBRARY_SOURCE_DELETED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'ContextSource', resourceId: req.params.id,
      });
      return res.json({ deleted: true });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

export default router;
