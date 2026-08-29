import mongoose from 'mongoose';

// A batch of learners moving through a Program together, e.g. "2026-2030
// Batch" (higher-ed) or a school "Batch". Anchored to one Program and one
// AcademicSession; optionally narrowed to a specific CurriculumVersion when
// a program runs more than one curriculum concurrently.
const CohortSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  programId: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', required: true, index: true },
  academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true, index: true },
  curriculumVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumVersion', default: null },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

CohortSchema.index({ tenantId: 1, programId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
CohortSchema.index({ tenantId: 1, programId: 1, academicSessionId: 1, name: 1 });

export default mongoose.model('Cohort', CohortSchema);
