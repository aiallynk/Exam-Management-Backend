import mongoose from 'mongoose';
import QuestionPaperTemplate from '../models/QuestionPaperTemplate.js';
import Exam from '../models/Exam.js';
import { resolveBrandingForExam } from './organizationBrandingService.js';
import {
  resolvePaperTemplateSnapshot,
  resolveInstructionLinesForSubject,
  sanitizePaperTemplateOverrides,
} from './paperTemplateResolver.js';

export class PaperTemplateError extends Error {
  constructor(status, message, code = 'PAPER_TEMPLATE_ERROR') {
    super(message);
    this.name = 'PaperTemplateError';
    this.status = status;
    this.code = code;
  }
}

const oid = (v) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null);

// ---- CRUD (governed by the route: TENANT_ADMIN / scoped ACADEMIC_ADMIN) ----

export const listPaperTemplates = async (tenantId, { approvalStatus, organizationUnitId } = {}) => {
  const filter = { tenantId };
  if (approvalStatus) filter.approvalStatus = approvalStatus;
  if (organizationUnitId) filter.organizationUnitId = oid(organizationUnitId);
  return QuestionPaperTemplate.find(filter).sort({ approvalStatus: 1, name: 1 }).lean();
};

export const listAvailableTemplates = (tenantId, { organizationUnitId } = {}) => {
  const filter = { tenantId, approvalStatus: 'APPROVED' };
  if (organizationUnitId) {
    // A creator sees tenant-wide templates plus any scoped to their unit.
    filter.$or = [{ organizationUnitId: null }, { organizationUnitId: oid(organizationUnitId) }];
  }
  return QuestionPaperTemplate.find(filter).sort({ name: 1 }).lean();
};

export const getPaperTemplate = async (tenantId, id) => {
  const doc = await QuestionPaperTemplate.findOne({ _id: id, tenantId }).lean();
  if (!doc) throw new PaperTemplateError(404, 'Paper template not found.', 'NOT_FOUND');
  return doc;
};

export const createPaperTemplate = async (tenantId, userId, payload = {}) => {
  const doc = await QuestionPaperTemplate.create({
    ...pickTemplateFields(payload),
    tenantId,
    createdBy: userId || null,
    approvalStatus: 'DRAFT',
  });
  return doc.toObject();
};

export const updatePaperTemplate = async (tenantId, id, payload = {}) => {
  const doc = await QuestionPaperTemplate.findOne({ _id: id, tenantId });
  if (!doc) throw new PaperTemplateError(404, 'Paper template not found.', 'NOT_FOUND');
  Object.assign(doc, pickTemplateFields(payload));
  // Any content edit sends an APPROVED template back to DRAFT — an approved
  // template is a frozen governance artifact; re-approval is explicit.
  if (doc.approvalStatus === 'APPROVED' && Object.keys(pickTemplateFields(payload)).length) {
    doc.approvalStatus = 'DRAFT';
    doc.approvedBy = null;
    doc.approvedAt = null;
  }
  await doc.save();
  return doc.toObject();
};

export const setPaperTemplateApproval = async (tenantId, id, approvalStatus, { userId } = {}) => {
  if (!['DRAFT', 'APPROVED', 'ARCHIVED'].includes(approvalStatus)) {
    throw new PaperTemplateError(400, 'Invalid approvalStatus.', 'BAD_STATUS');
  }
  const doc = await QuestionPaperTemplate.findOne({ _id: id, tenantId });
  if (!doc) throw new PaperTemplateError(404, 'Paper template not found.', 'NOT_FOUND');
  doc.approvalStatus = approvalStatus;
  doc.approvedBy = approvalStatus === 'APPROVED' ? userId || null : null;
  doc.approvedAt = approvalStatus === 'APPROVED' ? new Date() : null;
  await doc.save();
  return doc.toObject();
};

export const deletePaperTemplate = async (tenantId, id) => {
  // Never break an already-frozen assessment: a template that has been frozen
  // onto any exam can only be archived, not deleted.
  const inUse = await Exam.exists({ tenantId, paperTemplateId: id });
  if (inUse) {
    throw new PaperTemplateError(
      409,
      'This template is in use by one or more assessments and can only be archived.',
      'IN_USE'
    );
  }
  const res = await QuestionPaperTemplate.deleteOne({ _id: id, tenantId });
  if (!res.deletedCount) throw new PaperTemplateError(404, 'Paper template not found.', 'NOT_FOUND');
  return { deleted: true };
};

const TEMPLATE_FIELDS = [
  'name', 'description', 'organizationUnitId',
  'branding',
  'header', 'instructionBlock', 'instructionPresets',
  'sectionHeading', 'marksNotation', 'footer',
];
const pickTemplateFields = (payload) => {
  const out = {};
  for (const k of TEMPLATE_FIELDS) if (payload[k] !== undefined) out[k] = payload[k];
  if (out.organizationUnitId !== undefined) out.organizationUnitId = oid(out.organizationUnitId);
  return out;
};

// ---- Live preview (resolve without freezing) ----

export const previewPaperTemplate = async ({ tenantId, templateId, exam = {}, overrides = {}, subject = '', grade = '' }) => {
  const template = await getPaperTemplate(tenantId, templateId);
  const logoOpts = {
    logoSource: template.branding?.logo?.source || 'AUTO',
    templateLogoUrl: template.branding?.logo?.templateLogoUrl || '',
  };
  const branding = exam?._id
    ? await resolveBrandingForExam(exam, logoOpts)
    : await resolveBrandingForExam({ tenantId, ...exam }, logoOpts).catch(() => (exam?.branding || {}));
  const cleanOverrides = sanitizePaperTemplateOverrides(overrides);
  const instructionLines = resolveInstructionLinesForSubject(template, subject, cleanOverrides);
  return resolvePaperTemplateSnapshot({
    template, branding, exam, overrides: cleanOverrides, instructionLines, subject, grade,
  });
};

// ---- Freeze onto an assessment (called from the exam create/finalize path) ----
//
// Idempotent + write-once: if the exam already carries a frozen snapshot this
// is a no-op, so later branding/template edits can never alter an already-
// created paper (same contract as resolvedSpecificationSnapshot).

export const freezePaperTemplateOntoExam = async (exam, { templateId, overrides = {} } = {}) => {
  if (!exam) return exam;
  if (exam.paperTemplateSnapshot) return exam; // already frozen — never re-freeze
  if (!templateId || !mongoose.isValidObjectId(templateId)) return exam;

  const template = await QuestionPaperTemplate.findOne({
    _id: templateId,
    tenantId: exam.tenantId,
    approvalStatus: 'APPROVED',
  }).lean();
  if (!template) {
    throw new PaperTemplateError(
      400,
      'The selected paper template is not an approved template in this tenant.',
      'TEMPLATE_NOT_APPROVED'
    );
  }

  const branding = await resolveBrandingForExam(exam, {
    logoSource: template.branding?.logo?.source || 'AUTO',
    templateLogoUrl: template.branding?.logo?.templateLogoUrl || '',
  });
  const cleanOverrides = sanitizePaperTemplateOverrides(overrides);
  const subject = exam?.academicContext?.subject || '';
  const grade = exam?.academicContext?.grade || exam?.academicContext?.className || '';
  const instructionLines = resolveInstructionLinesForSubject(template, subject, cleanOverrides);

  exam.paperTemplateId = template._id;
  exam.paperTemplateOverrides = cleanOverrides;
  exam.paperTemplateSnapshot = resolvePaperTemplateSnapshot({
    template, branding, exam, overrides: cleanOverrides, instructionLines, subject, grade,
  });
  exam.paperTemplateSnapshotAt = new Date();
  return exam;
};
