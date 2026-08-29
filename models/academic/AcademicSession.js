import mongoose from 'mongoose';

// e.g. "2026-27". Optionally scoped to one OrganizationUnit (a branch/campus
// running its own session calendar); tenant-wide when omitted.
const AcademicSessionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  organizationUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationUnit', default: null },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

AcademicSessionSchema.index({ tenantId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
AcademicSessionSchema.index({ tenantId: 1, organizationUnitId: 1, name: 1 });

export default mongoose.model('AcademicSession', AcademicSessionSchema);
