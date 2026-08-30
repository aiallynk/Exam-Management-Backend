import mongoose from 'mongoose';

// e.g. "Grade VII" (school), "B.Tech" (higher-ed), "PG Diploma" (training).
// Owned by exactly one OrganizationUnit — the college/school/centre that
// runs it.
const ProgramSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  organizationUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationUnit', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

ProgramSchema.index({ tenantId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
ProgramSchema.index({ tenantId: 1, organizationUnitId: 1, name: 1 });

export default mongoose.model('Program', ProgramSchema);
