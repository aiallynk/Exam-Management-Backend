import mongoose from 'mongoose';

// One tenant-scoped academic catalogue avoids duplicate identifiers across
// institution types while keeping explicit entity types and relationships.
const AcademicEntitySchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  entityType: { type: String, required: true, enum: ['ORGANIZATION_UNIT', 'ACADEMIC_SESSION', 'PROGRAM', 'SPECIALIZATION', 'CURRICULUM_VERSION', 'ACADEMIC_PERIOD', 'COURSE', 'COHORT', 'SECTION', 'COURSE_OFFERING', 'ENROLLMENT'], index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'DRAFT', 'ARCHIVED'], default: 'ACTIVE' },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicEntity', default: null },
  references: { type: mongoose.Schema.Types.Mixed, default: {} },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

AcademicEntitySchema.index({ tenantId: 1, entityType: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
AcademicEntitySchema.index({ tenantId: 1, entityType: 1, parentId: 1, name: 1 });

export default mongoose.model('AcademicEntity', AcademicEntitySchema);
