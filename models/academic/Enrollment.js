import mongoose from 'mongoose';

// Links a User (a CANDIDATE, typically) to their real academic placement.
// This is the authoritative record for "which program/curriculum/cohort is
// this student actually in" — User.academicProfile (see models/User.js)
// remains preserved as flexible legacy data, but Enrollment is the V2
// source of truth (matches docs/WIZKIDS_REMOVAL_REPORT.md's stated intent).
const EnrollmentSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
  programId: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', required: true },
  curriculumVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumVersion', default: null },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', default: null },
  academicSectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSection', default: null },
  // Canonical academic roll number for this placement (session/cohort/section scoped).
  rollNumber: { type: String, trim: true, default: '', index: true },
  externalStudentId: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'COMPLETED', 'WITHDRAWN'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

EnrollmentSchema.index({ tenantId: 1, userId: 1, academicSessionId: 1 }, { unique: true });
EnrollmentSchema.index({ tenantId: 1, cohortId: 1 });
EnrollmentSchema.index(
  { tenantId: 1, academicSessionId: 1, academicSectionId: 1, rollNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      rollNumber: { $type: 'string', $ne: '' },
      academicSectionId: { $type: 'objectId' },
      status: 'ACTIVE',
    },
  }
);

export default mongoose.model('Enrollment', EnrollmentSchema);
