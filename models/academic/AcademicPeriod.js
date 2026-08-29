import mongoose from 'mongoose';

// e.g. "Semester 3" (higher-ed), "Term 1" (school), "Module 2" (training).
const AcademicPeriodSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  curriculumVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumVersion', required: true, index: true },
  type: { type: String, required: true, enum: ['SEMESTER', 'TERM', 'TRIMESTER', 'YEAR', 'MODULE', 'PHASE'] },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  sequence: { type: Number, default: 0 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

AcademicPeriodSchema.index({ tenantId: 1, curriculumVersionId: 1, sequence: 1 });
AcademicPeriodSchema.index({ tenantId: 1, curriculumVersionId: 1, name: 1 }, { unique: true });

export default mongoose.model('AcademicPeriod', AcademicPeriodSchema);
