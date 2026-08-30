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
import { ContentLibraryError } from '../services/contentLibraryService.js';
import {
  createLibraryResource,
  listLibraryResources,
  getLibraryResourceDetail,
  updateLibraryResource,
  deleteLibraryResource,
  addFileToLibraryResource,
  addUrlToLibraryResource,
} from '../services/libraryResourceService.js';

// LibraryResource — the educator-facing Content Library domain (Blueprint
// section 7B / master brief Parts J-N). Gated on CONTENT_LIBRARY throughout
// (Part P: storage/organization is never coupled to AI generation) — see
// routes/contentLibrary.js for the same decoupling rationale on the
// underlying ContextSource endpoints this router's :id/sources routes
// delegate to.
const router = express.Router();

const canAccess = [requireAuth, requireTenant, requireRole('TEACHER', 'ACADEMIC_ADMIN', 'EXAM_CREATOR', 'TENANT_ADMIN'), requireTenantFeature('CONTENT_LIBRARY')];
const canWrite = [requireAuth, requireTenant, requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'), requireTenantFeature('CONTENT_LIBRARY')];

const respondError = (res, next, error) => {
  if (error instanceof ContentLibraryError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
};

const handleMulterUploadError = (err, req, res, next) => {
  if (!err) return next();
  if (err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
  }
  return res.status(400).json({ error: err.message || 'File upload failed' });
};

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

// Two independent arrays (not one shared/derived array) — express-validator's
// ValidationChain#optional() mutates the chain in place and returns `this`,
// so deriving the PATCH validators from the POST ones via `.map(v =>
// v.optional())` would silently make the POST route's required `title`
// check optional too, since both routes would hold the very same chain
// objects. Kept fully separate to avoid that footgun.
const createResourceValidators = [
  body('title').isString().isLength({ min: 1, max: 300 }),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('resourceType').optional().isString(),
  body('parentResourceId').optional({ nullable: true }).isMongoId(),
  body('visibility').optional().isIn(['PRIVATE', 'COURSE', 'ACADEMIC_SHARED']),
  body('academicScope').optional().isObject(),
  body('chapter').optional().isString().isLength({ max: 200 }),
  body('unit').optional().isString().isLength({ max: 200 }),
  body('topic').optional().isString().isLength({ max: 200 }),
  body('tags').optional().custom((value) => Array.isArray(value) || typeof value === 'string'),
  body('metadata').optional().isObject(),
];

const updateResourceValidators = [
  body('title').optional().isString().isLength({ min: 1, max: 300 }),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('resourceType').optional().isString(),
  body('parentResourceId').optional({ nullable: true }).isMongoId(),
  body('visibility').optional().isIn(['PRIVATE', 'COURSE', 'ACADEMIC_SHARED']),
  body('academicScope').optional().isObject(),
  body('chapter').optional().isString().isLength({ max: 200 }),
  body('unit').optional().isString().isLength({ max: 200 }),
  body('topic').optional().isString().isLength({ max: 200 }),
  body('tags').optional().custom((value) => Array.isArray(value) || typeof value === 'string'),
  body('metadata').optional().isObject(),
  body('approvalStatus').optional().isIn(['DRAFT', 'READY', 'APPROVED', 'ARCHIVED']),
];

router.get(
  '/',
  ...canAccess,
  [
    query('search').optional().isString().isLength({ max: 200 }),
    query('resourceType').optional().isString(),
    query('visibility').optional().isString(),
    query('approvalStatus').optional().isString(),
    query('parentResourceId').optional().isString(),
    query('scope').optional().isIn(['mine', 'all']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const resources = await listLibraryResources(req.user, req.query);
      return res.json({ resources });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.get('/:id', ...canAccess, async (req, res, next) => {
  try {
    const resource = await getLibraryResourceDetail(req.user, req.params.id);
    return res.json({ resource });
  } catch (error) {
    return respondError(res, next, error);
  }
});

router.post('/', ...canWrite, createResourceValidators, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const resource = await createLibraryResource(req.user, req.body);
    await logAuditEvent(AUDIT_ACTIONS.LIBRARY_RESOURCE_CREATED, {
      userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
      tenantId: req.user.tenantId, resourceType: 'LibraryResource', resourceId: resource._id,
    });
    return res.status(201).json({ resource });
  } catch (error) {
    return respondError(res, next, error);
  }
});

router.patch(
  '/:id',
  ...canWrite,
  updateResourceValidators,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const resource = await updateLibraryResource(req.user, req.params.id, req.body);
      await logAuditEvent(AUDIT_ACTIONS.LIBRARY_RESOURCE_UPDATED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'LibraryResource', resourceId: resource._id,
      });
      return res.json({ resource });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.delete('/:id', ...canWrite, async (req, res, next) => {
  try {
    await deleteLibraryResource(req.user, req.params.id);
    await logAuditEvent(AUDIT_ACTIONS.LIBRARY_RESOURCE_DELETED, {
      userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
      tenantId: req.user.tenantId, resourceType: 'LibraryResource', resourceId: req.params.id,
    });
    return res.json({ deleted: true });
  } catch (error) {
    return respondError(res, next, error);
  }
});

router.post(
  '/:id/sources',
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
    body('chapter').optional().isString().isLength({ max: 200 }),
    body('unit').optional().isString().isLength({ max: 200 }),
    body('topic').optional().isString().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const source = await addFileToLibraryResource(req.user, req.params.id, {
        file: req.file,
        contentType: req.body.contentType,
        chapter: req.body.chapter,
        unit: req.body.unit,
        topic: req.body.topic,
        batchId: req.body.batchId || null,
      });
      await logAuditEvent(AUDIT_ACTIONS.CONTENT_LIBRARY_SOURCE_UPLOADED, {
        userId: req.user._id, userEmail: req.user.email, userName: req.user.name, userRole: req.user.role,
        tenantId: req.user.tenantId, resourceType: 'ContextSource', resourceId: source._id,
        sourceType: 'FILE', contentType: source.contentType, visibility: source.visibility,
      });
      const accepted = ['PENDING', 'PROCESSING'].includes(String(source.status || '').toUpperCase())
        || ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EMBEDDING'].includes(String(source.processingStage || '').toUpperCase());
      if (accepted) {
        return res.status(202).json({
          source,
          processing: true,
          jobId: source.processingJobId || null,
          message: 'File stored. Indexing has been queued.',
        });
      }
      return res.status(source.status === 'FAILED' ? 200 : 201).json({ source });
    } catch (error) {
      return respondError(res, next, error);
    }
  }
);

router.post(
  '/:id/sources/url',
  uploadRateLimiter,
  requireAuth,
  requireTenant,
  requireRole('TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  requireTenantFeature('CONTENT_LIBRARY'),
  enforceContextSourceLimit,
  [
    body('url').isURL({ protocols: ['http', 'https'], require_protocol: true }).withMessage('A valid http(s) URL is required'),
    body('contentType').optional().isString(),
    body('chapter').optional().isString().isLength({ max: 200 }),
    body('unit').optional().isString().isLength({ max: 200 }),
    body('topic').optional().isString().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const source = await addUrlToLibraryResource(req.user, req.params.id, {
        url: req.body.url,
        contentType: req.body.contentType,
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

export default router;
