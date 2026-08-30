import User from '../models/User.js';
import Exam from '../models/Exam.js';
import {
  OrganizationUnit, AcademicSession, Program, Specialization, CurriculumVersion,
  AcademicPeriod, Course, Cohort, AcademicSection, Enrollment, CourseOffering,
} from '../models/academic/index.js';
import ExamParticipant from '../models/ExamParticipant.js';
import { hasRole, hasAnyRole } from '../utils/userRoles.js';
import { isStaffExamOwner, OPERATING_STAFF_ROLES } from '../utils/examOperationAccess.js';
import { expandOrganizationUnits, narrowAcademicFilterByOrganization } from './organizationContextService.js';

const id = (value) => value == null ? '' : String(value);
const uniqueIds = (values = []) => [...new Set(values.filter(Boolean).map(id))];

export class AcademicAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AcademicAccessError';
    this.status = status;
    this.statusCode = status;
  }
}

const loadCurrentUser = async (user) => {
  if (!user?._id) throw new AcademicAccessError(401, 'Authentication required.');
  return User.findById(user._id)
    .select('_id tenantId role roles status academicAdminScope primaryOrganizationUnitId organizationUnitAccess organizationPreferences')
    .lean();
};

// expandOrganizationUnits lives in organizationContextService.js

/**
 * Resolve the bounded academic records visible to an Academic Admin or
 * Teacher or scoped Exam Creator. Tenant Admin receives `all: true`.
 */
export async function resolveAcademicVisibility(rawUser) {
  const user = await loadCurrentUser(rawUser);
  if (!user || user.status !== 'ACTIVE') throw new AcademicAccessError(403, 'Account is not active.');
  const tenantId = user.tenantId;
  if (!tenantId) throw new AcademicAccessError(403, 'A tenant workspace is required.');

  if (hasRole(user, 'TENANT_ADMIN')) return { tenantId, all: true, user };
  let organizationUnitIds = [];
  let programIds = [];
  let offeringDocs = [];

  if (hasRole(user, 'ACADEMIC_ADMIN')) {
    if (user.academicAdminScope?.wholeTenant === true) return { tenantId, all: true, user };
    organizationUnitIds = await expandOrganizationUnits(tenantId, user.academicAdminScope?.organizationUnitIds || []);
    programIds = uniqueIds(user.academicAdminScope?.programIds || []);
    const programsInUnits = organizationUnitIds.length
      ? await Program.find({ tenantId, organizationUnitId: { $in: organizationUnitIds } }).select('_id').lean()
      : [];
    programIds = uniqueIds([...programIds, ...programsInUnits.map((item) => item._id)]);
    const offeringClauses = [
      ...(organizationUnitIds.length ? [{ organizationUnitId: { $in: organizationUnitIds } }] : []),
      ...(programIds.length ? [{ programId: { $in: programIds } }] : []),
    ];
    offeringDocs = offeringClauses.length
      ? await CourseOffering.find({ tenantId, $or: offeringClauses }).lean()
      : [];
  } else if (hasRole(user, 'TEACHER') || hasRole(user, 'EXAM_CREATOR')) {
    const offeringScope = hasRole(user, 'TEACHER')
      ? { facultyUserId: user._id }
      : { assessmentCreatorUserIds: user._id };
    offeringDocs = await CourseOffering.find({ tenantId, ...offeringScope, status: 'ACTIVE' }).lean();
    organizationUnitIds = uniqueIds(offeringDocs.map((item) => item.organizationUnitId));
    programIds = uniqueIds(offeringDocs.map((item) => item.programId));
  } else {
    throw new AcademicAccessError(403, 'An academic workspace role is required.');
  }

  const curriculumVersionIds = uniqueIds(offeringDocs.map((item) => item.curriculumVersionId));
  const cohortIds = uniqueIds(offeringDocs.map((item) => item.cohortId));
  const academicSectionIds = uniqueIds(offeringDocs.map((item) => item.academicSectionId));
  const academicSessionIds = uniqueIds(offeringDocs.map((item) => item.academicSessionId));
  const courseIds = uniqueIds(offeringDocs.map((item) => item.courseId));
  const academicPeriodIds = uniqueIds(offeringDocs.map((item) => item.academicPeriodId));
  const specializationIds = uniqueIds(offeringDocs.map((item) => item.specializationId));

  if (hasRole(user, 'ACADEMIC_ADMIN') && programIds.length) {
    const [curricula, cohorts] = await Promise.all([
      CurriculumVersion.find({ tenantId, programId: { $in: programIds } }).select('_id specializationId').lean(),
      Cohort.find({ tenantId, programId: { $in: programIds } }).select('_id academicSessionId curriculumVersionId').lean(),
    ]);
    curriculumVersionIds.push(...uniqueIds(curricula.map((item) => item._id)));
    specializationIds.push(...uniqueIds(curricula.map((item) => item.specializationId)));
    cohortIds.push(...uniqueIds(cohorts.map((item) => item._id)));
    academicSessionIds.push(...uniqueIds(cohorts.map((item) => item.academicSessionId)));
  }

  const [sections, courses, periods] = await Promise.all([
    cohortIds.length ? AcademicSection.find({ tenantId, cohortId: { $in: uniqueIds(cohortIds) } }).select('_id').lean() : [],
    curriculumVersionIds.length ? Course.find({ tenantId, curriculumVersionId: { $in: uniqueIds(curriculumVersionIds) } }).select('_id').lean() : [],
    curriculumVersionIds.length ? AcademicPeriod.find({ tenantId, curriculumVersionId: { $in: uniqueIds(curriculumVersionIds) } }).select('_id').lean() : [],
  ]);
  academicSectionIds.push(...sections.map((item) => id(item._id)));
  courseIds.push(...courses.map((item) => id(item._id)));
  academicPeriodIds.push(...periods.map((item) => id(item._id)));

  return {
    tenantId,
    user,
    all: false,
    ids: {
      'organization-units': uniqueIds(organizationUnitIds),
      'academic-sessions': uniqueIds(academicSessionIds),
      programs: uniqueIds(programIds),
      specializations: uniqueIds(specializationIds),
      'curriculum-versions': uniqueIds(curriculumVersionIds),
      'academic-periods': uniqueIds(academicPeriodIds),
      courses: uniqueIds(courseIds),
      cohorts: uniqueIds(cohortIds),
      'academic-sections': uniqueIds(academicSectionIds),
      enrollments: [],
      'course-offerings': uniqueIds(offeringDocs.map((item) => item._id)),
    },
  };
}

export async function buildAcademicListFilter(rawUser, resourcePath, { organizationUnitId = null } = {}) {
  const visibility = await resolveAcademicVisibility(rawUser);
  let filter;
  if (visibility.all) {
    filter = { tenantId: visibility.tenantId };
  } else if (resourcePath === 'enrollments') {
    if (hasRole(visibility.user, 'ACADEMIC_ADMIN')) {
      const programIds = visibility.ids.programs || [];
      return { tenantId: visibility.tenantId, programId: { $in: programIds } };
    }
    const offeringIds = visibility.ids['course-offerings'] || [];
    const offerings = offeringIds.length
      ? await CourseOffering.find({ _id: { $in: offeringIds }, tenantId: visibility.tenantId }).select('academicSessionId programId cohortId academicSectionId').lean()
      : [];
    const clauses = offerings.map((offering) => ({
      academicSessionId: offering.academicSessionId,
      programId: offering.programId,
      ...(offering.cohortId ? { cohortId: offering.cohortId } : {}),
      ...(offering.academicSectionId ? { academicSectionId: offering.academicSectionId } : {}),
    }));
    filter = { tenantId: visibility.tenantId, ...(clauses.length ? { $or: clauses } : { _id: { $in: [] } }) };
  } else {
    filter = { tenantId: visibility.tenantId, _id: { $in: visibility.ids[resourcePath] || [] } };
  }
  return narrowAcademicFilterByOrganization(filter, resourcePath, organizationUnitId);
}

export async function assertAcademicMutationAllowed(rawUser, resourcePath, payload = {}, existingId = null) {
  const visibility = await resolveAcademicVisibility(rawUser);
  if (visibility.all && hasRole(visibility.user, 'TENANT_ADMIN')) return visibility;
  if (!hasRole(visibility.user, 'ACADEMIC_ADMIN')) {
    throw new AcademicAccessError(403, 'Academic Admin or Tenant Admin is required to change academic setup.');
  }
  if (visibility.all) return visibility;
  if (existingId && !(visibility.ids[resourcePath] || []).includes(id(existingId))) {
    throw new AcademicAccessError(403, 'This record is outside your delegated academic scope.');
  }
  const checks = [
    ['parentOrganizationUnitId', 'organization-units'], ['organizationUnitId', 'organization-units'],
    ['programId', 'programs'], ['curriculumVersionId', 'curriculum-versions'],
    ['cohortId', 'cohorts'], ['academicSectionId', 'academic-sections'],
    ['courseOfferingId', 'course-offerings'],
  ];
  for (const [field, type] of checks) {
    if (payload[field] && !(visibility.ids[type] || []).includes(id(payload[field]))) {
      throw new AcademicAccessError(403, `The selected ${field} is outside your delegated academic scope.`);
    }
  }
  return visibility;
}

export async function canOperateExam(rawUser, examOrId) {
  const user = await loadCurrentUser(rawUser);
  const exam = typeof examOrId === 'object' && examOrId?._id
    ? examOrId
    : await Exam.findOne({ _id: examOrId, tenantId: user?.tenantId }).lean();
  if (!user || !exam || id(user.tenantId) !== id(exam.tenantId)) return false;
  if (isStaffExamOwner(user, exam)) return true;
  if (hasAnyRole(user, OPERATING_STAFF_ROLES)) {
    const creatorParticipant = await ExamParticipant.exists({
      examId: exam._id,
      userId: user._id,
      examRole: 'CREATOR',
      tenantId: user.tenantId,
    });
    if (creatorParticipant) return true;
  }
  if (hasRole(user, 'TEACHER') && exam.academicContext?.courseOfferingId) {
    return Boolean(await CourseOffering.exists({
      _id: exam.academicContext.courseOfferingId,
      tenantId: user.tenantId,
      facultyUserId: user._id,
      status: 'ACTIVE',
    }));
  }
  if (hasRole(user, 'ACADEMIC_ADMIN')) {
    const visibility = await resolveAcademicVisibility(user);
    if (visibility.all) return true;
    if (exam.academicContext?.courseOfferingId && visibility.ids['course-offerings'].includes(id(exam.academicContext.courseOfferingId))) return true;
    if (exam.academicContext?.programId && visibility.ids.programs.includes(id(exam.academicContext.programId))) return true;
    if (exam.academicContext?.organizationUnitId && visibility.ids['organization-units'].includes(id(exam.academicContext.organizationUnitId))) return true;
  }
  return false;
}

export async function canAuthorInCourseOffering(rawUser, courseOfferingId) {
  const user = await loadCurrentUser(rawUser);
  if (!user || !hasRole(user, 'EXAM_CREATOR') || !courseOfferingId) return false;
  return Boolean(await CourseOffering.exists({
    _id: courseOfferingId,
    tenantId: user.tenantId,
    status: 'ACTIVE',
    $or: [
      { assessmentCreatorUserIds: user._id },
      ...(hasRole(user, 'TEACHER') ? [{ facultyUserId: user._id }] : []),
    ],
  }));
}

export const canMonitorTenantOperations = (user) => hasRole(user, 'TENANT_ADMIN');
