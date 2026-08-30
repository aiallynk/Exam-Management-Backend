import express from 'express';
import multer from 'multer';
import { body, query, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { uploadRateLimiter } from '../middleware/rateLimiter.js';
import {
  listPaperTemplates,
  listAvailableTemplates,
  getPaperTemplate,
  createPaperTemplate,
  updatePaperTemplate,
  setPaperTemplateApproval,
  deletePaperTemplate,
  previewPaperTemplate,
  PaperTemplateError,
} from '../services/paperTemplateService.js';
import {
  getOrganizationBranding,
  setOrganizationBranding,
  uploadOrganizationLogo,
  getTenantBranding,
  setTenantBranding,
  uploadTenantLogo,
  BrandingError,
} from '../services/organizationBrandingService.js';
import { putImage } from '../services/storage/imageStorage.js';

const router = express.Router();

// Governance mirrors RubricTemplate / guideline routes: Tenant Admin owns it;
// Academic Admin may manage within delegated scope. Exam Creator only reads
// the APPROVED list + previews.
const canGovern = [requireAuth, requireTenant, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN')];
const canConsume = [requireAuth, requireTenant, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'EXAM_CREATOR', 'TEACHER')];

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const respondError = (res, next, error) => {
  if (error instanceof PaperTemplateError || error instanceof BrandingError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return next(error);
};

const validationGuard = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ---------- Templates ----------

router.get(
  '/',
  ...canConsume,
  query('approvalStatus').optional().isIn(['DRAFT', 'APPROVED', 'ARCHIVED']),
  query('organizationUnitId').optional().isMongoId(),
  async (req, res, next) => {
    try {
      // A non-governing consumer only ever gets APPROVED templates.
      const governs = req.user.roles?.some?.((r) => ['TENANT_ADMIN', 'ACADEMIC_ADMIN'].includes(r))
        || ['TENANT_ADMIN', 'ACADEMIC_ADMIN'].includes(req.user.role);
      const rows = await listPaperTemplates(req.user.tenantId, {
        approvalStatus: governs ? req.query.approvalStatus : 'APPROVED',
        organizationUnitId: req.query.organizationUnitId,
      });
      res.json({ templates: rows });
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

router.get('/available', ...canConsume, async (req, res, next) => {
  try {
    const rows = await listAvailableTemplates(req.user.tenantId, {
      organizationUnitId: req.query.organizationUnitId,
    });
    res.json({ templates: rows });
  } catch (error) {
    respondError(res, next, error);
  }
});

// Reserved sub-paths ('tenant-branding', 'branding', 'available') are handled
// by their own routes — never treat them as a template id.
const RESERVED_ID_SEGMENTS = new Set(['tenant-branding', 'branding', 'available']);
router.get('/:id', ...canConsume, async (req, res, next) => {
  if (RESERVED_ID_SEGMENTS.has(req.params.id)) return next();
  try {
    res.json({ template: await getPaperTemplate(req.user.tenantId, req.params.id) });
  } catch (error) {
    respondError(res, next, error);
  }
});

router.post(
  '/',
  ...canGovern,
  body('name').isString().trim().isLength({ min: 1, max: 200 }),
  body('marksNotation').optional().isIn(['BRACKET_SQUARE', 'BRACKET_ROUND', 'DASH', 'PLAIN']),
  validationGuard,
  async (req, res, next) => {
    try {
      const created = await createPaperTemplate(req.user.tenantId, req.user._id, req.body);
      res.status(201).json({ template: created });
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

router.patch(
  '/:id',
  ...canGovern,
  body('name').optional().isString().trim().isLength({ min: 1, max: 200 }),
  body('marksNotation').optional().isIn(['BRACKET_SQUARE', 'BRACKET_ROUND', 'DASH', 'PLAIN']),
  validationGuard,
  async (req, res, next) => {
    try {
      res.json({ template: await updatePaperTemplate(req.user.tenantId, req.params.id, req.body) });
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

router.post(
  '/:id/approval',
  ...canGovern,
  body('approvalStatus').isIn(['DRAFT', 'APPROVED', 'ARCHIVED']),
  validationGuard,
  async (req, res, next) => {
    try {
      const t = await setPaperTemplateApproval(req.user.tenantId, req.params.id, req.body.approvalStatus, {
        userId: req.user._id,
      });
      res.json({ template: t });
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

router.delete('/:id', ...canGovern, async (req, res, next) => {
  try {
    res.json(await deletePaperTemplate(req.user.tenantId, req.params.id));
  } catch (error) {
    respondError(res, next, error);
  }
});

// Live resolve (no freeze) for the create-flow preview.
router.post(
  '/:id/preview',
  ...canConsume,
  body('overrides').optional().isObject(),
  body('subject').optional().isString(),
  body('grade').optional().isString(),
  body('exam').optional().isObject(),
  validationGuard,
  async (req, res, next) => {
    try {
      const snapshot = await previewPaperTemplate({
        tenantId: req.user.tenantId,
        templateId: req.params.id,
        exam: req.body.exam || {},
        overrides: req.body.overrides || {},
        subject: req.body.subject || '',
        grade: req.body.grade || '',
      });
      res.json({ snapshot });
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

// ---------- Per-template logo uploads ----------
// Stored into template.branding.logo.templateLogoUrl / secondaryLogo.url.

const uploadTemplateLogoField = async (req, res, next, field) => {
  try {
    if (!req.file?.buffer?.length) throw new PaperTemplateError(400, 'No logo file uploaded.', 'NO_FILE');
    const ext = (req.file.originalname || '').match(/\.[^.]+$/)?.[0]?.toLowerCase() || '.png';
    if (!['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) {
      throw new PaperTemplateError(400, 'Logo must be PNG, JPG, SVG or WEBP.', 'BAD_TYPE');
    }
    const existing = await getPaperTemplate(req.user.tenantId, req.params.id);
    const stored = await putImage({
      tenantId: req.user.tenantId,
      category: 'branding',
      subpath: ['paper-template', String(req.params.id)],
      fileStem: field === 'secondary' ? 'secondary-logo' : 'logo',
      extension: ext.slice(1),
      buffer: req.file.buffer,
    });
    if (!stored?.url) throw new PaperTemplateError(503, 'Image storage is not configured on this deployment.', 'STORAGE_NOT_CONFIGURED');
    const branding = { ...(existing.branding || {}) };
    if (field === 'secondary') {
      branding.secondaryLogo = { ...(branding.secondaryLogo || {}), enabled: true, url: stored.url };
    } else {
      branding.logo = { ...(branding.logo || {}), enabled: true, source: 'TEMPLATE', templateLogoUrl: stored.url };
    }
    const template = await updatePaperTemplate(req.user.tenantId, req.params.id, { branding });
    res.status(201).json({ template, url: stored.url });
  } catch (error) {
    respondError(res, next, error);
  }
};

router.post('/:id/logo', ...canGovern, uploadRateLimiter, logoUpload.single('logo'), (req, res, next) =>
  uploadTemplateLogoField(req, res, next, 'primary'));
router.post('/:id/secondary-logo', ...canGovern, uploadRateLimiter, logoUpload.single('logo'), (req, res, next) =>
  uploadTemplateLogoField(req, res, next, 'secondary'));

// ---------- Tenant-wide branding (Tenant.metadata.branding) ----------

router.get('/tenant-branding', ...canConsume, async (req, res, next) => {
  try {
    res.json(await getTenantBranding(req.user.tenantId));
  } catch (error) {
    respondError(res, next, error);
  }
});

router.put('/tenant-branding', ...canGovern, body('branding').isObject(), validationGuard, async (req, res, next) => {
  try {
    res.json(await setTenantBranding(req.user.tenantId, req.body.branding, { userId: req.user._id }));
  } catch (error) {
    respondError(res, next, error);
  }
});

router.post(
  '/tenant-branding/logo',
  requireAuth,
  requireTenant,
  requireRole('TENANT_ADMIN'),
  uploadRateLimiter,
  logoUpload.single('logo'),
  async (req, res, next) => {
    try {
      res.status(201).json(await uploadTenantLogo(req.user.tenantId, req.file, { userId: req.user._id }));
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

// ---------- Institution branding (OrganizationUnit.metadata.branding) ----------

router.get('/branding/:organizationUnitId', ...canConsume, async (req, res, next) => {
  try {
    res.json(await getOrganizationBranding(req.user.tenantId, req.params.organizationUnitId));
  } catch (error) {
    respondError(res, next, error);
  }
});

router.put(
  '/branding/:organizationUnitId',
  ...canGovern,
  body('branding').isObject(),
  validationGuard,
  async (req, res, next) => {
    try {
      const result = await setOrganizationBranding(
        req.user.tenantId,
        req.params.organizationUnitId,
        req.body.branding,
        { userId: req.user._id }
      );
      res.json(result);
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

router.post(
  '/branding/:organizationUnitId/logo',
  requireAuth,
  requireTenant,
  requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN'),
  uploadRateLimiter,
  logoUpload.single('logo'),
  async (req, res, next) => {
    try {
      const result = await uploadOrganizationLogo(
        req.user.tenantId,
        req.params.organizationUnitId,
        req.file,
        { userId: req.user._id }
      );
      res.status(201).json(result);
    } catch (error) {
      respondError(res, next, error);
    }
  }
);

export default router;
