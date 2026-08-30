import mongoose from 'mongoose';

// A subdivision of a Cohort, e.g. "Section A". NOT the exam-paper Section
// model (models/Section.js, which groups Questions within a QuestionPaper)
// — deliberately named AcademicSection and kept in models/academic/ to
// avoid any confusion between the two unrelated concepts.
const AcademicSectionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

AcademicSectionSchema.index({ tenantId: 1, cohortId: 1, name: 1 }, { unique: true });

export default mongoose.model('AcademicSection', AcademicSectionSchema);
