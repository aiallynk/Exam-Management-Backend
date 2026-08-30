import mongoose from 'mongoose';

// The critical join (see convergence map, "COURSE OFFERING"): a Course
// actually being run in a specific Session/OrganizationUnit/Program/
// Curriculum/Period, optionally narrowed to one Cohort/Section, with a
// Faculty/Instructor. Assessment context should reference CourseOffering
// where relevant — it is the concrete "this exam is for this class right
// now" anchor that Course alone (a curriculum-level catalogue entry) is not.
//
// Relational integrity (course.curriculumVersionId === curriculumVersionId,
// curriculumVersion.programId === programId, academicPeriod.curriculumVersionId
// === curriculumVersionId, cohort.programId === programId, section.cohortId
// === cohortId when both are set) is enforced in
// services/academicIntegrityService.js at write time, not just by these
// refs existing — Mongoose refs alone cannot express "belongs to the same
// parent chain."
const CourseOfferingSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
  organizationUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationUnit', required: true },
  programId: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', required: true },
  specializationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Specialization', default: null },
  curriculumVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumVersion', required: true },
  academicPeriodId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicPeriod', required: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', default: null },
  academicSectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSection', default: null },
  facultyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assessmentCreatorUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

CourseOfferingSchema.index({ tenantId: 1, courseId: 1, academicSessionId: 1, cohortId: 1, academicSectionId: 1 }, { unique: true });
CourseOfferingSchema.index({ tenantId: 1, academicPeriodId: 1 });
CourseOfferingSchema.index({ tenantId: 1, facultyUserId: 1, status: 1 });
CourseOfferingSchema.index({ tenantId: 1, assessmentCreatorUserIds: 1, status: 1 });

export default mongoose.model('CourseOffering', CourseOfferingSchema);
