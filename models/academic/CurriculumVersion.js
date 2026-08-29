import mongoose from 'mongoose';

// e.g. "Curriculum 2026" under B.Tech/CSE, or "ICSE Curriculum" under Grade
// VII. Optionally narrowed to one Specialization; when omitted the
// curriculum applies to the whole Program.
const CurriculumVersionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  programId: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', required: true, index: true },
  specializationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Specialization', default: null },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  effectiveFrom: { type: Date, default: null },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

CurriculumVersionSchema.index({ tenantId: 1, programId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
CurriculumVersionSchema.index({ tenantId: 1, programId: 1, name: 1 });

export default mongoose.model('CurriculumVersion', CurriculumVersionSchema);
