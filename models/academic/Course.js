import mongoose from 'mongoose';

// e.g. "Data Structures" (higher-ed), "Science" (school). Owned by one
// CurriculumVersion; offered in a given session/period/cohort via
// CourseOffering below.
const CourseSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  curriculumVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumVersion', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  credits: { type: Number, default: null },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

CourseSchema.index({ tenantId: 1, curriculumVersionId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
CourseSchema.index({ tenantId: 1, curriculumVersionId: 1, name: 1 });

export default mongoose.model('Course', CourseSchema);
