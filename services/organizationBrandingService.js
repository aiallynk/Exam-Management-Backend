import mongoose from 'mongoose';
import OrganizationUnit from '../models/academic/OrganizationUnit.js';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import { putImage } from './storage/imageStorage.js';

// Institution branding lives on OrganizationUnit.metadata.branding (chosen in
// planning to avoid a new model). It is free-form Mixed; this service is the
// single validated read/write path. Logo bytes are stored via the existing
// image storage layer and referenced by a served `/uploads/...` URL — the
// same public-image pattern Question.imageUrl / Exam.omrTemplateImage use.

export class BrandingError extends Error {
  constructor(status, message, code = 'BRANDING_ERROR') {
    super(message);
    this.name = 'BrandingError';
    this.status = status;
    this.code = code;
  }
}

const BRANDING_KEYS = Object.freeze([
  'institutionName',
  'address',
  'addressLines',
  'documentNumberDefault',
  'revisionDefault',
  'documentDateDefault',
  'academicSessionDefault',
  'logoUrl',
  // additive: optional institutional fields a paper template may render
  'affiliation',
  'affiliationNumber',
  'tagline',
  'contactPhone',
  'contactEmail',
  'website',
]);

export const sanitizeBrandingInput = (raw = {}) => {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of BRANDING_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (key === 'addressLines') {
      out.addressLines = (Array.isArray(raw.addressLines) ? raw.addressLines : String(raw.addressLines).split('\n'))
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 6);
    } else {
      out[key] = String(raw[key]).trim().slice(0, 400);
    }
  }
  return out;
};

const loadUnit = async (tenantId, organizationUnitId) => {
  if (!mongoose.isValidObjectId(organizationUnitId)) {
    throw new BrandingError(400, 'A valid organizationUnitId is required.', 'BAD_ORG_UNIT');
  }
  const unit = await OrganizationUnit.findOne({ _id: organizationUnitId, tenantId });
  if (!unit) throw new BrandingError(404, 'Organization unit not found in this tenant.', 'ORG_UNIT_NOT_FOUND');
  return unit;
};

export const getOrganizationBranding = async (tenantId, organizationUnitId) => {
  const unit = await loadUnit(tenantId, organizationUnitId);
  return { organizationUnitId: String(unit._id), branding: (unit.metadata && unit.metadata.branding) || {} };
};

export const setOrganizationBranding = async (tenantId, organizationUnitId, brandingInput, { userId } = {}) => {
  const unit = await loadUnit(tenantId, organizationUnitId);
  const current = (unit.metadata && unit.metadata.branding) || {};
  const merged = { ...current, ...sanitizeBrandingInput(brandingInput) };
  unit.metadata = { ...(unit.metadata || {}), branding: merged, brandingUpdatedBy: userId ? String(userId) : undefined, brandingUpdatedAt: new Date().toISOString() };
  unit.markModified('metadata');
  await unit.save();
  return { organizationUnitId: String(unit._id), branding: merged };
};

export const uploadOrganizationLogo = async (tenantId, organizationUnitId, file, { userId } = {}) => {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    throw new BrandingError(400, 'No logo file uploaded.', 'NO_FILE');
  }
  const ext = (file.originalname || '').match(/\.[^.]+$/)?.[0]?.toLowerCase() || '.png';
  if (!['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) {
    throw new BrandingError(400, 'Logo must be PNG, JPG, SVG or WEBP.', 'BAD_TYPE');
  }
  const stored = await putImage({
    tenantId,
    category: 'branding',
    subpath: [String(organizationUnitId)],
    fileStem: 'logo',
    extension: ext.slice(1),
    buffer: file.buffer,
  });
  if (!stored?.url) {
    throw new BrandingError(503, 'Image storage is not configured on this deployment.', 'STORAGE_NOT_CONFIGURED');
  }
  return setOrganizationBranding(tenantId, organizationUnitId, { logoUrl: stored.url }, { userId });
};

// ---- Tenant-wide branding (Tenant.metadata.branding — no schema change) ----

export const getTenantBranding = async (tenantId) => {
  const tenant = await Tenant.findById(tenantId).select('metadata name').lean();
  if (!tenant) throw new BrandingError(404, 'Tenant not found.', 'TENANT_NOT_FOUND');
  return { branding: tenant.metadata?.branding || {}, tenantName: tenant.name };
};

export const setTenantBranding = async (tenantId, brandingInput, { userId } = {}) => {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new BrandingError(404, 'Tenant not found.', 'TENANT_NOT_FOUND');
  const current = tenant.metadata?.branding || {};
  const merged = { ...current, ...sanitizeBrandingInput(brandingInput) };
  tenant.metadata = {
    ...(tenant.metadata || {}),
    branding: merged,
    brandingUpdatedBy: userId ? String(userId) : undefined,
    brandingUpdatedAt: new Date().toISOString(),
  };
  tenant.markModified('metadata');
  await tenant.save();
  return { branding: merged };
};

export const uploadTenantLogo = async (tenantId, file, { userId } = {}) => {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    throw new BrandingError(400, 'No logo file uploaded.', 'NO_FILE');
  }
  const ext = (file.originalname || '').match(/\.[^.]+$/)?.[0]?.toLowerCase() || '.png';
  if (!['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) {
    throw new BrandingError(400, 'Logo must be PNG, JPG, SVG or WEBP.', 'BAD_TYPE');
  }
  const stored = await putImage({
    tenantId,
    category: 'branding',
    subpath: ['tenant'],
    fileStem: 'logo',
    extension: ext.slice(1),
    buffer: file.buffer,
  });
  if (!stored?.url) throw new BrandingError(503, 'Image storage is not configured on this deployment.', 'STORAGE_NOT_CONFIGURED');
  return setTenantBranding(tenantId, { logoUrl: stored.url }, { userId });
};

// ---- Effective branding for a paper (org unit → tenant merge) --------------
//
// Returns a merged branding object plus the resolved primary logo URL,
// honouring the template's chosen logo source. Deliberately tolerant — every
// missing value stays blank, never throws.
export const resolveBrandingForExam = async (exam, { logoSource = 'AUTO', templateLogoUrl = '' } = {}) => {
  if (!exam) return {};
  const tenantId = exam.tenantId;

  const explicitUnitId =
    exam.paperTemplateOverrides?.organizationUnitId ||
    exam.academicContext?.organizationUnitId ||
    exam.academicContext?.orgUnitId ||
    null;

  let orgBranding = {};
  if (explicitUnitId && mongoose.isValidObjectId(explicitUnitId)) {
    const unit = await OrganizationUnit.findOne({ _id: explicitUnitId, tenantId }).select('metadata').lean();
    orgBranding = unit?.metadata?.branding || {};
  }
  if (!Object.keys(orgBranding).length) {
    const branded = await OrganizationUnit.find({ tenantId, 'metadata.branding': { $exists: true } })
      .select('metadata parentOrganizationUnitId')
      .lean();
    if (branded.length) {
      const root = branded.find((u) => !u.parentOrganizationUnitId) || branded[0];
      orgBranding = root.metadata?.branding || {};
    }
  }

  const { branding: tenantBranding } = await getTenantBranding(tenantId).catch(() => ({ branding: {} }));

  // A Tenant Admin's profile picture is the last-resort logo source.
  let adminAvatarUrl = '';
  if (logoSource === 'PROFILE' || logoSource === 'AUTO') {
    const admin = await User.findOne({ tenantId, roles: 'TENANT_ADMIN', profilePictureUrl: { $ne: '' } })
      .select('profilePictureUrl')
      .sort({ createdAt: 1 })
      .lean();
    adminAvatarUrl = admin?.profilePictureUrl || '';
  }

  // Field-level merge: org unit wins over tenant.
  const merged = { ...(tenantBranding || {}), ...(orgBranding || {}) };

  const bySource = {
    TEMPLATE: templateLogoUrl,
    ORGANIZATION: orgBranding?.logoUrl,
    TENANT: tenantBranding?.logoUrl,
    PROFILE: adminAvatarUrl,
    NONE: '',
  };
  const resolvedLogoUrl =
    logoSource === 'AUTO'
      ? templateLogoUrl || orgBranding?.logoUrl || tenantBranding?.logoUrl || adminAvatarUrl || ''
      : bySource[logoSource] || '';

  return { ...merged, logoUrl: resolvedLogoUrl, _sources: { org: !!orgBranding?.logoUrl, tenant: !!tenantBranding?.logoUrl, profile: !!adminAvatarUrl } };
};

export const _testables = { BRANDING_KEYS };
