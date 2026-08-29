import {
  OrganizationUnit,
  Program,
  Specialization,
  CurriculumVersion,
  AcademicPeriod,
  Course,
  Cohort,
  AcademicSection,
  AcademicSession,
  CourseOffering,
} from '../models/academic/index.js';
import User from '../models/User.js';

// Maps an Exam.academicContext / resolver-input key to the explicit model
// that owns it. `sectionId` (not `academicSectionId`) is kept as the
// context key for backward field-name compatibility with any
// already-created Exam.academicContext blobs — it targets the
// AcademicSection collection under the hood.
const CONTEXT_MODELS = {
  organizationUnitId: OrganizationUnit,
  academicSessionId: AcademicSession,
  programId: Program,
  specializationId: Specialization,
  curriculumVersionId: CurriculumVersion,
  academicPeriodId: AcademicPeriod,
  courseId: Course,
  courseOfferingId: CourseOffering,
  cohortId: Cohort,
  sectionId: AcademicSection,
};

// Relational-integrity checks for the explicit academic domain models — see
// docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md Part "RELATIONAL
// INTEGRITY". A Mongoose `ref` only proves an ObjectId points at *some*
// document of the right collection and tenant; it does not prove that
// document is the correct parent in the chain (e.g. that a Course Offering's
// curriculum actually belongs to its selected program). Every function here
// throws a 400 with an actionable message rather than silently accepting a
// logically impossible combination.

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const mustExist = async (Model, id, tenantId, label) => {
  if (!id) return null;
  const doc = await Model.findOne({ _id: id, tenantId }).lean();
  if (!doc) throw badRequest(`${label} is not available in this tenant.`);
  return doc;
};

// Cheap cycle guard for the self-referential organization tree: walks up
// from the proposed parent and rejects if it ever reaches the node being
// saved (only relevant on update, where `selfId` is set).
// Ownership model (see docs/XAMIGO_TENANT_ADMIN_IA_UI_CORRECTION.md):
// platform provisioning (routes/superAdmin.js's tenant-creation flow)
// creates the one root OrganizationUnit for a tenant. A Tenant Admin can
// add children under it but must never create a second root — enforced
// here, not just hidden in the UI, so a direct API call cannot bypass it.
// Only applies on CREATE (selfId unset); editing the existing root's own
// fields must not trip over itself.
export const assertSingleRootPerTenant = async ({ tenantId, parentOrganizationUnitId, selfId }) => {
  if (parentOrganizationUnitId || selfId) return;
  const existingRoot = await OrganizationUnit.findOne({ tenantId, parentOrganizationUnitId: null }).select('_id name').lean();
  if (existingRoot) {
    throw badRequest(`This tenant already has a root organization ("${existingRoot.name}"). Add a child under it instead of creating another root.`);
  }
};

export const assertOrganizationUnitValid = async ({ tenantId, parentOrganizationUnitId, selfId = null }) => {
  if (!parentOrganizationUnitId) return;
  let cursor = await mustExist(OrganizationUnit, parentOrganizationUnitId, tenantId, 'Parent organization unit');
  const seen = new Set([String(selfId || '')]);
  while (cursor) {
    if (selfId && String(cursor._id) === String(selfId)) {
      throw badRequest('An organization unit cannot be its own ancestor.');
    }
    if (seen.has(String(cursor._id))) break; // already-broken cycle in existing data; do not loop forever
    seen.add(String(cursor._id));
    if (!cursor.parentOrganizationUnitId) break;
    cursor = await OrganizationUnit.findOne({ _id: cursor.parentOrganizationUnitId, tenantId }).lean();
  }
};

export const assertProgramValid = async ({ tenantId, organizationUnitId }) => {
  await mustExist(OrganizationUnit, organizationUnitId, tenantId, 'Organization unit');
};

export const assertSpecializationValid = async ({ tenantId, programId }) => {
  await mustExist(Program, programId, tenantId, 'Program');
};

export const assertCurriculumVersionValid = async ({ tenantId, programId, specializationId }) => {
  await mustExist(Program, programId, tenantId, 'Program');
  if (specializationId) {
    const specialization = await mustExist(Specialization, specializationId, tenantId, 'Specialization');
    if (String(specialization.programId) !== String(programId)) {
      throw badRequest('The selected specialization does not belong to the selected program.');
    }
  }
};

export const assertAcademicPeriodValid = async ({ tenantId, curriculumVersionId }) => {
  await mustExist(CurriculumVersion, curriculumVersionId, tenantId, 'Curriculum version');
};

export const assertCourseValid = async ({ tenantId, curriculumVersionId }) => {
  await mustExist(CurriculumVersion, curriculumVersionId, tenantId, 'Curriculum version');
};

export const assertCohortValid = async ({ tenantId, programId, academicSessionId, curriculumVersionId }) => {
  await mustExist(Program, programId, tenantId, 'Program');
  await mustExist(AcademicSession, academicSessionId, tenantId, 'Academic session');
  if (curriculumVersionId) {
    const curriculum = await mustExist(CurriculumVersion, curriculumVersionId, tenantId, 'Curriculum version');
    if (String(curriculum.programId) !== String(programId)) {
      throw badRequest('The selected curriculum version does not belong to the selected program.');
    }
  }
};

export const assertAcademicSectionValid = async ({ tenantId, cohortId }) => {
  await mustExist(Cohort, cohortId, tenantId, 'Cohort');
};

export const assertEnrollmentValid = async ({ tenantId, userId, academicSessionId, programId, curriculumVersionId, cohortId, academicSectionId }) => {
  const user = await User.findOne({ _id: userId, tenantId }).select('_id').lean();
  if (!user) throw badRequest('User is not available in this tenant.');
  await mustExist(AcademicSession, academicSessionId, tenantId, 'Academic session');
  await mustExist(Program, programId, tenantId, 'Program');

  if (curriculumVersionId) {
    const curriculum = await mustExist(CurriculumVersion, curriculumVersionId, tenantId, 'Curriculum version');
    if (String(curriculum.programId) !== String(programId)) {
      throw badRequest('The selected curriculum version does not belong to the selected program.');
    }
  }
  if (cohortId) {
    const cohort = await mustExist(Cohort, cohortId, tenantId, 'Cohort');
    if (String(cohort.programId) !== String(programId)) {
      throw badRequest('The selected cohort does not belong to the selected program.');
    }
    if (String(cohort.academicSessionId) !== String(academicSessionId)) {
      throw badRequest('The selected cohort does not belong to the selected academic session.');
    }
  }
  if (academicSectionId) {
    if (!cohortId) throw badRequest('An academic section requires a cohort to be selected first.');
    const section = await mustExist(AcademicSection, academicSectionId, tenantId, 'Academic section');
    if (String(section.cohortId) !== String(cohortId)) {
      throw badRequest('The selected academic section does not belong to the selected cohort.');
    }
  }
};

export const assertCourseOfferingValid = async ({
  tenantId, courseId, academicSessionId, organizationUnitId, programId,
  specializationId, curriculumVersionId, academicPeriodId, cohortId, academicSectionId, facultyUserId, assessmentCreatorUserIds,
}) => {
  await mustExist(AcademicSession, academicSessionId, tenantId, 'Academic session');
  await mustExist(OrganizationUnit, organizationUnitId, tenantId, 'Organization unit');
  const program = await mustExist(Program, programId, tenantId, 'Program');
  const curriculum = await mustExist(CurriculumVersion, curriculumVersionId, tenantId, 'Curriculum version');
  if (String(curriculum.programId) !== String(programId)) {
    throw badRequest('The selected curriculum version does not belong to the selected program.');
  }
  if (specializationId) {
    const specialization = await mustExist(Specialization, specializationId, tenantId, 'Specialization');
    if (String(specialization.programId) !== String(programId)) {
      throw badRequest('The selected specialization does not belong to the selected program.');
    }
    if (curriculum.specializationId && String(curriculum.specializationId) !== String(specializationId)) {
      throw badRequest('The selected curriculum version belongs to a different specialization.');
    }
  }
  const period = await mustExist(AcademicPeriod, academicPeriodId, tenantId, 'Academic period');
  if (String(period.curriculumVersionId) !== String(curriculumVersionId)) {
    throw badRequest('The selected academic period does not belong to the selected curriculum version.');
  }
  const course = await mustExist(Course, courseId, tenantId, 'Course');
  if (String(course.curriculumVersionId) !== String(curriculumVersionId)) {
    throw badRequest('The selected course does not belong to the selected curriculum version.');
  }
  if (cohortId) {
    const cohort = await mustExist(Cohort, cohortId, tenantId, 'Cohort');
    if (String(cohort.programId) !== String(programId)) {
      throw badRequest('The selected cohort does not belong to the selected program.');
    }
    if (String(cohort.academicSessionId) !== String(academicSessionId)) {
      throw badRequest('The selected cohort does not belong to the selected academic session.');
    }
    if (cohort.curriculumVersionId && String(cohort.curriculumVersionId) !== String(curriculumVersionId)) {
      throw badRequest('The selected cohort is anchored to a different curriculum version.');
    }
  }
  if (academicSectionId) {
    if (!cohortId) throw badRequest('An academic section requires a cohort to be selected first.');
    const section = await mustExist(AcademicSection, academicSectionId, tenantId, 'Academic section');
    if (String(section.cohortId) !== String(cohortId)) {
      throw badRequest('The selected academic section does not belong to the selected cohort.');
    }
  }
  if (facultyUserId) {
    const faculty = await User.findOne({
      _id: facultyUserId,
      tenantId,
      status: 'ACTIVE',
      $or: [{ role: 'TEACHER' }, { roles: 'TEACHER' }],
    }).select('_id').lean();
    if (!faculty) throw badRequest('The selected faculty member must be an active Teacher in this tenant.');
  }
  if (Array.isArray(assessmentCreatorUserIds) && assessmentCreatorUserIds.length) {
    const uniqueCreatorIds = [...new Set(assessmentCreatorUserIds.map(String))];
    const creatorCount = await User.countDocuments({
      _id: { $in: uniqueCreatorIds },
      tenantId,
      status: 'ACTIVE',
      $or: [{ role: 'EXAM_CREATOR' }, { roles: 'EXAM_CREATOR' }],
    });
    if (creatorCount !== uniqueCreatorIds.length) throw badRequest('Every assigned assessment creator must be an active Exam Creator in this tenant.');
  }
  return { program, curriculum };
};

// Used by assessmentSpecificationResolver.js. An Exam.academicContext blob
// supplies an arbitrary SUBSET of the 10 context keys (a school exam might
// only set programId/academicPeriodId/courseId; a university exam might set
// all 10). This validates (a) every supplied id belongs to the tenant and
// (b) every PAIR of simultaneously-supplied keys agree on their shared
// ancestor — e.g. it is not enough for curriculumVersionId and programId to
// each individually belong to the tenant if the curriculum actually belongs
// to a different program than the one supplied. That per-key-only check is
// exactly the AcademicEntity-era shortcut this replaces.
export const assertAcademicContextCoherent = async (tenantId, academicContext = {}) => {
  const entries = Object.entries(academicContext).filter(([key, value]) => value && CONTEXT_MODELS[key]);
  const docs = {};
  await Promise.all(entries.map(async ([key, id]) => {
    const Model = CONTEXT_MODELS[key];
    const doc = await Model.findOne({ _id: id, tenantId }).lean();
    if (!doc) throw badRequest(`Academic context ${key} is not available in this tenant.`);
    docs[key] = doc;
  }));

  const agree = (leftKey, leftField, rightKey, rightValueOrField, message) => {
    if (!docs[leftKey] || !docs[rightKey]) return;
    const leftValue = docs[leftKey][leftField];
    const rightValue = typeof rightValueOrField === 'function' ? rightValueOrField() : docs[rightKey][rightValueOrField];
    if (leftValue && rightValue && String(leftValue) !== String(rightValue)) throw badRequest(message);
  };

  agree('specializationId', 'programId', 'programId', () => academicContext.programId, 'The selected specialization does not belong to the selected program.');
  agree('curriculumVersionId', 'programId', 'programId', () => academicContext.programId, 'The selected curriculum version does not belong to the selected program.');
  if (docs.curriculumVersionId?.specializationId && docs.specializationId) {
    agree('curriculumVersionId', 'specializationId', 'specializationId', () => academicContext.specializationId, 'The selected curriculum version belongs to a different specialization.');
  }
  agree('academicPeriodId', 'curriculumVersionId', 'curriculumVersionId', () => academicContext.curriculumVersionId, 'The selected academic period does not belong to the selected curriculum version.');
  agree('courseId', 'curriculumVersionId', 'curriculumVersionId', () => academicContext.curriculumVersionId, 'The selected course does not belong to the selected curriculum version.');
  agree('cohortId', 'programId', 'programId', () => academicContext.programId, 'The selected cohort does not belong to the selected program.');
  agree('cohortId', 'academicSessionId', 'academicSessionId', () => academicContext.academicSessionId, 'The selected cohort does not belong to the selected academic session.');
  agree('sectionId', 'cohortId', 'cohortId', () => academicContext.cohortId, 'The selected academic section does not belong to the selected cohort.');
  agree('programId', 'organizationUnitId', 'organizationUnitId', () => academicContext.organizationUnitId, 'The selected program does not belong to the selected organization unit.');

  if (docs.courseOfferingId) {
    const offering = docs.courseOfferingId;
    [
      ['courseId', 'courseId'], ['academicSessionId', 'academicSessionId'], ['organizationUnitId', 'organizationUnitId'],
      ['programId', 'programId'], ['curriculumVersionId', 'curriculumVersionId'], ['academicPeriodId', 'academicPeriodId'],
      ['cohortId', 'cohortId'], ['sectionId', 'academicSectionId'],
    ].forEach(([contextKey, offeringField]) => {
      const suppliedId = academicContext[contextKey];
      const offeringId = offering[offeringField];
      if (suppliedId && offeringId && String(suppliedId) !== String(offeringId)) {
        throw badRequest(`The selected course offering does not match the selected ${contextKey}.`);
      }
    });
  }
};
