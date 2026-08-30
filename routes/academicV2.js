import express from 'express';
import {
  OrganizationUnit, AcademicSession, Program, Specialization, CurriculumVersion,
  AcademicPeriod, Course, Cohort, AcademicSection, Enrollment, CourseOffering,
} from '../models/academic/index.js';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import {
  assertOrganizationUnitValid, assertSingleRootPerTenant, assertProgramValid, assertSpecializationValid,
  assertCurriculumVersionValid, assertAcademicPeriodValid, assertCourseValid,
  assertCohortValid, assertAcademicSectionValid, assertEnrollmentValid, assertCourseOfferingValid,
} from '../services/academicIntegrityService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import { hasRole } from '../utils/userRoles.js';
import { buildAcademicListFilter, assertAcademicMutationAllowed, resolveAcademicVisibility } from '../services/academicAccessService.js';
import { resolveTenantFeature } from '../services/tenantFeatureService.js';
import { UserProvisioningScopeError } from '../services/userProvisioningScopeService.js';
import {
  resolveOrganizationContext,
  selectOrganizationContext,
  assertOrganizationUnitAccess,
  OrganizationContextError,
} from '../services/organizationContextService.js';

// Explicit-domain-model replacement for routes/academic.js — see
// docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md. Each resource gets its
// own relational-integrity check (services/academicIntegrityService.js)
// instead of the generic "every referenced id belongs to this tenant" check
// the old AcademicEntity router used, which could not express "belongs to
// the correct PARENT."

const router = express.Router();
const canManage = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN')];
const canRead = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR')];

// Registers GET (list, filterable) / POST (create) / PATCH (update) for one
// explicit academic resource. `validate` receives the tenant-scoped,
// already-merged field set and throws (via academicIntegrityService) on any
// relational violation; it runs before every create and before every
// update that touches a relationship-bearing field.
const registerResource = ({
  path, Model, createFields, updateFields, filterFields, validate, resourceType,
}) => {
  router.get(`/${path}`, ...canRead, async (req, res, next) => {
    try {
      const orgContext = await resolveOrganizationContext(req.user).catch(() => null);
      const organizationUnitId = orgContext?.currentOrganizationUnitId || null;
      const filter = await buildAcademicListFilter(req.user, path, { organizationUnitId });
      filterFields.forEach((field) => { if (req.query[field]) filter[field] = req.query[field]; });
      if (req.query.status) filter.status = req.query.status;
      const items = await Model.find(filter).sort({ name: 1 }).lean();
      return res.json({ items, organizationContext: orgContext ? {
        currentOrganizationUnitId: orgContext.currentOrganizationUnitId,
        currentOrganizationUnit: orgContext.currentOrganizationUnit,
      } : null });
    } catch (error) { return next(error); }
  });

  router.post(`/${path}`, ...canManage, async (req, res, next) => {
    try {
      const tenantId = req.user.tenantId;
      const payload = Object.fromEntries(createFields.map((field) => [field, req.body?.[field]]));
      if (!String(payload.name || '').trim() && createFields.includes('name')) {
        return res.status(400).json({ error: 'name is required.' });
      }
      await assertAcademicMutationAllowed(req.user, path, payload);
      await validate({ tenantId, ...payload });
      const item = await Model.create({ tenantId, ...payload, createdBy: req.user._id });
      await logAuditEvent('ACADEMIC_V2_CREATED', {
        userId: req.user._id, tenantId, resourceType, resourceId: item._id, method: req.method, path: req.path,
      });
      return res.status(201).json({ item });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ error: `A ${resourceType} with this code/name already exists in this scope.` });
      return next(error);
    }
  });

  router.patch(`/${path}/:id`, ...canManage, async (req, res, next) => {
    try {
      const tenantId = req.user.tenantId;
      const existing = await Model.findOne({ _id: req.params.id, tenantId }).lean();
      if (!existing) return res.status(404).json({ error: `${resourceType} not found.` });
      const patch = Object.fromEntries(
        updateFields.filter((field) => req.body?.[field] !== undefined).map((field) => [field, req.body[field]])
      );
      await assertAcademicMutationAllowed(req.user, path, { ...existing, ...patch }, existing._id);
      const relationshipTouched = createFields.some((field) => field in patch);
      if (relationshipTouched) {
        const merged = Object.fromEntries(createFields.map((field) => [field, field in patch ? patch[field] : existing[field]]));
        await validate({ tenantId, ...merged, selfId: existing._id });
      }
      const item = await Model.findOneAndUpdate({ _id: req.params.id, tenantId }, { $set: patch }, { new: true, runValidators: true });
      await logAuditEvent('ACADEMIC_V2_UPDATED', {
        userId: req.user._id, tenantId, resourceType, resourceId: item._id, method: req.method, path: req.path,
      });
      return res.json({ item });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ error: `A ${resourceType} with this code/name already exists in this scope.` });
      return next(error);
    }
  });
};

registerResource({
  path: 'organization-units', Model: OrganizationUnit, resourceType: 'OrganizationUnit',
  createFields: ['name', 'code', 'type', 'parentOrganizationUnitId', 'metadata'],
  updateFields: ['name', 'code', 'type', 'parentOrganizationUnitId', 'status', 'metadata'],
  filterFields: ['parentOrganizationUnitId', 'type'],
  validate: async ({ tenantId, parentOrganizationUnitId, selfId }) => {
    await assertSingleRootPerTenant({ tenantId, parentOrganizationUnitId, selfId });
    await assertOrganizationUnitValid({ tenantId, parentOrganizationUnitId, selfId });
  },
});

// Convenience lookup for the Organization Structure page: the tenant's one
// root, authoritatively via Tenant.rootOrganizationUnitId (falls back to a
// parentOrganizationUnitId:null scan for tenants provisioned before that
// field existed — none exist in this environment, but the fallback costs
// nothing and avoids a silent 404 if that ever changes).
router.get('/organization-units/root', ...canRead, async (req, res, next) => {
  try {
    const scopeFilter = await buildAcademicListFilter(req.user, 'organization-units');
    const tenant = await Tenant.findById(req.user.tenantId).select('rootOrganizationUnitId').lean();
    const root = tenant?.rootOrganizationUnitId
      ? await OrganizationUnit.findOne({ $and: [scopeFilter, { _id: tenant.rootOrganizationUnitId }] }).lean()
      : await OrganizationUnit.findOne({ ...scopeFilter, parentOrganizationUnitId: null }).sort({ createdAt: 1 }).lean();
    return res.json({ root: root || null });
  } catch (error) { return next(error); }
});

// Nested tree view for the Organization Structure UI — a flat list forces
// the client to reconstruct the hierarchy itself; this builds it once
// server-side instead.
router.get('/organization-units/tree', ...canRead, async (req, res, next) => {
  try {
    const filter = await buildAcademicListFilter(req.user, 'organization-units');
    const items = await OrganizationUnit.find(filter).sort({ name: 1 }).lean();
    const byId = new Map(items.map((item) => [String(item._id), { ...item, children: [] }]));
    const roots = [];
    byId.forEach((node) => {
      const parentId = node.parentOrganizationUnitId ? String(node.parentOrganizationUnitId) : null;
      if (parentId && byId.has(parentId)) byId.get(parentId).children.push(node);
      else roots.push(node);
    });
    return res.json({ tree: roots });
  } catch (error) { return next(error); }
});

// Assignment picker for Academic Admin/Tenant Admin. Names and role codes
// only; no candidate roster or tenant settings leak into this domain API.
router.get('/staff', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN'), async (req, res, next) => {
  try {
    const requestedRole = String(req.query.role || '').toUpperCase();
    const allowed = ['TEACHER', 'EXAM_CREATOR'];
    if (requestedRole && !allowed.includes(requestedRole)) return res.status(400).json({ error: 'role must be TEACHER or EXAM_CREATOR.' });
    const roleClauses = (requestedRole ? [requestedRole] : allowed).flatMap((role) => [{ role }, { roles: role }]);
    const staffFilter = { tenantId: req.user.tenantId, status: 'ACTIVE', $or: roleClauses };

    // ACADEMIC_ADMIN is location-bound by default: an assignment picker must
    // not double as a tenant-wide staff directory across other locations.
    // Scope to staff whose home/delegated organization unit falls inside the
    // actor's authorized subtree, unless the actor holds whole-tenant scope.
    if (hasRole(req.user, 'ACADEMIC_ADMIN') && !hasRole(req.user, 'TENANT_ADMIN')) {
      const visibility = await resolveAcademicVisibility(req.user);
      if (!visibility.all) {
        const unitIds = visibility.ids['organization-units'] || [];
        staffFilter.$and = [{
          $or: [
            { primaryOrganizationUnitId: { $in: unitIds } },
            { organizationUnitAccess: { $in: unitIds } },
          ],
        }];
      }
    }

    const items = await User.find(staffFilter)
      .select('_id name email role roles')
      .sort({ name: 1 })
      .lean();
    return res.json({ items });
  } catch (error) { return next(error); }
});

registerResource({
  path: 'academic-sessions', Model: AcademicSession, resourceType: 'AcademicSession',
  createFields: ['name', 'code', 'organizationUnitId', 'startDate', 'endDate', 'metadata'],
  updateFields: ['name', 'code', 'organizationUnitId', 'startDate', 'endDate', 'status', 'metadata'],
  filterFields: ['organizationUnitId'],
  validate: async ({ tenantId, organizationUnitId }) => {
    if (organizationUnitId) await assertOrganizationUnitValid({ tenantId, parentOrganizationUnitId: organizationUnitId });
  },
});

registerResource({
  path: 'programs', Model: Program, resourceType: 'Program',
  createFields: ['name', 'code', 'organizationUnitId', 'metadata'],
  updateFields: ['name', 'code', 'organizationUnitId', 'status', 'metadata'],
  filterFields: ['organizationUnitId'],
  validate: ({ tenantId, organizationUnitId }) => assertProgramValid({ tenantId, organizationUnitId }),
});

registerResource({
  path: 'specializations', Model: Specialization, resourceType: 'Specialization',
  createFields: ['name', 'code', 'programId', 'metadata'],
  updateFields: ['name', 'code', 'programId', 'status', 'metadata'],
  filterFields: ['programId'],
  validate: ({ tenantId, programId }) => assertSpecializationValid({ tenantId, programId }),
});

registerResource({
  path: 'curriculum-versions', Model: CurriculumVersion, resourceType: 'CurriculumVersion',
  createFields: ['name', 'code', 'programId', 'specializationId', 'effectiveFrom', 'metadata'],
  updateFields: ['name', 'code', 'programId', 'specializationId', 'effectiveFrom', 'status', 'metadata'],
  filterFields: ['programId', 'specializationId'],
  validate: ({ tenantId, programId, specializationId }) => assertCurriculumVersionValid({ tenantId, programId, specializationId }),
});

registerResource({
  path: 'academic-periods', Model: AcademicPeriod, resourceType: 'AcademicPeriod',
  createFields: ['name', 'type', 'curriculumVersionId', 'sequence', 'metadata'],
  updateFields: ['name', 'type', 'curriculumVersionId', 'sequence', 'status', 'metadata'],
  filterFields: ['curriculumVersionId'],
  validate: ({ tenantId, curriculumVersionId }) => assertAcademicPeriodValid({ tenantId, curriculumVersionId }),
});

registerResource({
  path: 'courses', Model: Course, resourceType: 'Course',
  createFields: ['name', 'code', 'curriculumVersionId', 'credits', 'metadata'],
  updateFields: ['name', 'code', 'curriculumVersionId', 'credits', 'status', 'metadata'],
  filterFields: ['curriculumVersionId'],
  validate: ({ tenantId, curriculumVersionId }) => assertCourseValid({ tenantId, curriculumVersionId }),
});

registerResource({
  path: 'cohorts', Model: Cohort, resourceType: 'Cohort',
  createFields: ['name', 'code', 'programId', 'academicSessionId', 'curriculumVersionId', 'metadata'],
  updateFields: ['name', 'code', 'programId', 'academicSessionId', 'curriculumVersionId', 'status', 'metadata'],
  filterFields: ['programId', 'academicSessionId'],
  validate: ({ tenantId, programId, academicSessionId, curriculumVersionId }) => assertCohortValid({ tenantId, programId, academicSessionId, curriculumVersionId }),
});

registerResource({
  path: 'academic-sections', Model: AcademicSection, resourceType: 'AcademicSection',
  createFields: ['name', 'code', 'cohortId', 'metadata'],
  updateFields: ['name', 'code', 'cohortId', 'status', 'metadata'],
  filterFields: ['cohortId'],
  validate: ({ tenantId, cohortId }) => assertAcademicSectionValid({ tenantId, cohortId }),
});

registerResource({
  path: 'enrollments', Model: Enrollment, resourceType: 'Enrollment',
  createFields: ['userId', 'academicSessionId', 'programId', 'curriculumVersionId', 'cohortId', 'academicSectionId', 'rollNumber', 'externalStudentId', 'metadata'],
  updateFields: ['curriculumVersionId', 'cohortId', 'academicSectionId', 'rollNumber', 'externalStudentId', 'status', 'metadata'],
  filterFields: ['userId', 'academicSessionId', 'programId', 'cohortId', 'academicSectionId'],
  validate: ({ tenantId, userId, academicSessionId, programId, curriculumVersionId, cohortId, academicSectionId }) =>
    assertEnrollmentValid({ tenantId, userId, academicSessionId, programId, curriculumVersionId, cohortId, academicSectionId }),
});

registerResource({
  path: 'course-offerings', Model: CourseOffering, resourceType: 'CourseOffering',
  createFields: ['courseId', 'academicSessionId', 'organizationUnitId', 'programId', 'specializationId', 'curriculumVersionId', 'academicPeriodId', 'cohortId', 'academicSectionId', 'facultyUserId', 'assessmentCreatorUserIds', 'metadata'],
  updateFields: ['cohortId', 'academicSectionId', 'facultyUserId', 'assessmentCreatorUserIds', 'status', 'metadata'],
  filterFields: ['courseId', 'academicSessionId', 'curriculumVersionId', 'academicPeriodId', 'organizationUnitId'],
  validate: (params) => assertCourseOfferingValid(params),
});

router.get('/organization-context', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'), async (req, res, next) => {
  try {
    const context = await resolveOrganizationContext(req.user);
    return res.json({ context });
  } catch (error) {
    if (error instanceof OrganizationContextError) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

router.post('/organization-context/select', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'), async (req, res, next) => {
  try {
    const organizationUnitId = req.body?.organizationUnitId;
    if (!organizationUnitId) return res.status(400).json({ error: 'organizationUnitId is required.' });
    const context = await selectOrganizationContext(req.user, organizationUnitId);
    return res.json({ context });
  } catch (error) {
    if (error instanceof OrganizationContextError) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

router.get('/my-assessment-course-offerings', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('EXAM_CREATOR', 'TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const orgContext = await resolveOrganizationContext(req.user);
    const filter = await buildAcademicListFilter(req.user, 'course-offerings', {
      organizationUnitId: orgContext.currentOrganizationUnitId,
    });
    const items = await CourseOffering.find({ ...filter, status: 'ACTIVE' })
      .populate('courseId', 'name code')
      .populate('academicSessionId', 'name code')
      .populate('programId', 'name code')
      .populate('academicPeriodId', 'name type sequence')
      .populate('cohortId', 'name code')
      .populate('academicSectionId', 'name code')
      .populate('organizationUnitId', 'name code type')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ items, organizationContext: {
      currentOrganizationUnitId: orgContext.currentOrganizationUnitId,
      currentOrganizationUnit: orgContext.currentOrganizationUnit,
    } });
  } catch (error) { return next(error); }
});

router.get('/academic-sections/:sectionId/roster', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('ACADEMIC_ADMIN', 'TENANT_ADMIN', 'TEACHER'), async (req, res, next) => {
  try {
    const section = await AcademicSection.findOne({ _id: req.params.sectionId, tenantId: req.user.tenantId }).lean();
    if (!section) return res.status(404).json({ error: 'Academic section not found.' });
    const cohort = await Cohort.findOne({ _id: section.cohortId, tenantId: req.user.tenantId }).lean();
    if (!cohort) return res.status(404).json({ error: 'Cohort not found for this section.' });
    const program = await Program.findOne({ _id: cohort.programId, tenantId: req.user.tenantId }).lean();
    if (program?.organizationUnitId) await assertOrganizationUnitAccess(req.user, program.organizationUnitId);
    const items = await Enrollment.find({
      tenantId: req.user.tenantId,
      cohortId: cohort._id,
      academicSectionId: section._id,
      status: 'ACTIVE',
    }).populate('userId', 'name email status').sort({ rollNumber: 1, createdAt: 1 }).lean();
    const orgContext = await resolveOrganizationContext(req.user).catch(() => null);
    return res.json({
      section,
      cohort,
      program,
      items,
      organizationContext: orgContext ? {
        currentOrganizationUnitId: orgContext.currentOrganizationUnitId,
        currentOrganizationUnit: orgContext.currentOrganizationUnit,
      } : null,
    });
  } catch (error) {
    if (error instanceof OrganizationContextError) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

// Add ONE candidate (new or existing) to a section's roster. Reachable by
// Tenant Admin, Academic Admin, and — only when the tenant control
// TEACHER_STUDENT_MANAGEMENT is enabled — the Teacher who owns a
// CourseOffering tied to this section. This is the fix for the previously
// broken path: the Class/Section roster UI already let Academic Admin
// attempt to add a new student, but that call went to POST /tenant-admin/users,
// which is Tenant-Admin-only, so it silently 403'd. Location is always
// derived from the section's own resolved organization unit (the same
// value assertOrganizationUnitAccess/CourseOffering ownership already
// verified the actor is authorized for) — never trusted from the client,
// and never the generic multi-select pattern.
router.post('/academic-sections/:sectionId/candidates', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER'), async (req, res, next) => {
  try {
    const section = await AcademicSection.findOne({ _id: req.params.sectionId, tenantId: req.user.tenantId }).lean();
    if (!section) return res.status(404).json({ error: 'Academic section not found.' });
    const cohort = await Cohort.findOne({ _id: section.cohortId, tenantId: req.user.tenantId }).lean();
    if (!cohort) return res.status(404).json({ error: 'Cohort not found for this section.' });
    const program = await Program.findOne({ _id: cohort.programId, tenantId: req.user.tenantId }).lean();
    if (!program) return res.status(404).json({ error: 'Program not found for this section.' });

    let scopeResolutionMethod;
    if (hasRole(req.user, 'TEACHER') && !hasRole(req.user, 'TENANT_ADMIN') && !hasRole(req.user, 'ACADEMIC_ADMIN')) {
      const feature = await resolveTenantFeature(req.user.tenantId, 'TEACHER_STUDENT_MANAGEMENT');
      if (!feature?.effectiveEnabled) {
        return res.status(403).json({ error: 'Adding students is not enabled for teachers on this tenant.' });
      }
      const offering = await CourseOffering.findOne({
        tenantId: req.user.tenantId, academicSectionId: section._id, facultyUserId: req.user._id, status: 'ACTIVE',
      }).lean();
      if (!offering) {
        return res.status(403).json({ error: 'You are not assigned to this class.' });
      }
      scopeResolutionMethod = 'TEACHER_INHERITED_LOCATION';
    } else {
      // Tenant Admin / Academic Admin: reuses the same organization-unit
      // authorization check the roster GET above already applies — an
      // Academic Admin outside this program's authorized scope 403s here
      // exactly as they would viewing the roster, before any write happens.
      if (program.organizationUnitId) await assertOrganizationUnitAccess(req.user, program.organizationUnitId);
      scopeResolutionMethod = hasRole(req.user, 'TENANT_ADMIN') ? 'TENANT_ADMIN_SELECTED_LOCATION' : 'ACADEMIC_ADMIN_INHERITED_LOCATION';
    }

    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const rollNumber = String(req.body?.rollNumber || '').trim();
    const externalStudentId = String(req.body?.externalStudentId || '').trim();
    const existingUserId = req.body?.userId ? String(req.body.userId) : null;

    let user;
    if (existingUserId) {
      user = await User.findOne({
        _id: existingUserId,
        tenantId: req.user.tenantId,
        $or: [{ role: 'CANDIDATE' }, { roles: 'CANDIDATE' }],
      });
      if (!user) return res.status(404).json({ error: 'Candidate not found.' });
    } else {
      if (!name || !email) return res.status(400).json({ error: 'Name and email are required for a new candidate.' });
      user = await User.findOne({ email, tenantId: req.user.tenantId });
      if (user && user.role !== 'CANDIDATE' && !(user.roles || []).includes('CANDIDATE')) {
        return res.status(409).json({ error: 'This email already belongs to a non-candidate account.' });
      }
      if (!user) {
        const { createTenantUser } = await import('../services/userRoleService.js');
        try {
          user = await createTenantUser({
            name,
            email,
            password: req.body?.password,
            role: 'CANDIDATE',
            roles: ['CANDIDATE'],
            tenantId: req.user.tenantId,
            actorId: req.user._id,
            primaryOrganizationUnitId: program.organizationUnitId || null,
            organizationUnitAccess: program.organizationUnitId ? [{ organizationUnitId: program.organizationUnitId, grantedBy: req.user._id }] : [],
          });
        } catch (roleError) {
          if (roleError?.status) return res.status(roleError.status).json({ error: roleError.message });
          throw roleError;
        }
      }
    }

    const existingEnrollment = await Enrollment.findOne({
      tenantId: req.user.tenantId,
      userId: user._id,
      academicSessionId: cohort.academicSessionId,
      programId: program._id,
      cohortId: cohort._id,
      academicSectionId: section._id,
      status: 'ACTIVE',
    });
    if (existingEnrollment) {
      return res.status(409).json({ error: 'This candidate is already enrolled in this section.' });
    }

    await assertEnrollmentValid({
      tenantId: req.user.tenantId,
      userId: user._id,
      academicSessionId: cohort.academicSessionId,
      programId: program._id,
      curriculumVersionId: cohort.curriculumVersionId || null,
      cohortId: cohort._id,
      academicSectionId: section._id,
    });
    const enrollment = await Enrollment.create({
      tenantId: req.user.tenantId,
      userId: user._id,
      academicSessionId: cohort.academicSessionId,
      programId: program._id,
      curriculumVersionId: cohort.curriculumVersionId || null,
      cohortId: cohort._id,
      academicSectionId: section._id,
      rollNumber: rollNumber || undefined,
      externalStudentId: externalStudentId || undefined,
      status: 'ACTIVE',
    });

    await logAuditEvent(AUDIT_ACTIONS.USER_CREATED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'User',
      resourceId: user._id,
      details: {
        createdBy: String(req.user._id),
        createdRole: 'CANDIDATE',
        resolvedLocationId: program.organizationUnitId ? String(program.organizationUnitId) : null,
        scopeResolutionMethod,
        enrollmentId: String(enrollment._id),
        reusedExistingUser: Boolean(existingUserId),
      },
    });

    const userObj = user.toObject ? user.toObject() : user;
    delete userObj.password;
    return res.status(201).json({ user: userObj, enrollment });
  } catch (error) {
    if (error instanceof OrganizationContextError || error instanceof UserProvisioningScopeError) {
      return res.status(error.status).json({ error: error.message });
    }
    return next(error);
  }
});

router.post('/enrollments/bulk', ...canManage, async (req, res, next) => {
  try {
    const {
      academicSessionId, programId, curriculumVersionId, cohortId, academicSectionId, students = [],
    } = req.body || {};
    if (!academicSessionId || !programId || !Array.isArray(students) || !students.length) {
      return res.status(400).json({ error: 'academicSessionId, programId and students[] are required.' });
    }
    const program = await Program.findOne({ _id: programId, tenantId: req.user.tenantId }).lean();
    if (!program) return res.status(404).json({ error: 'Program not found.' });
    if (program.organizationUnitId) await assertOrganizationUnitAccess(req.user, program.organizationUnitId);
    await assertAcademicMutationAllowed(req.user, 'enrollments', {
      programId, cohortId, academicSectionId,
    });
    const results = [];
    for (const row of students) {
      const name = String(row?.name || '').trim();
      const email = String(row?.email || '').trim().toLowerCase();
      const rollNumber = String(row?.rollNumber || '').trim();
      const externalStudentId = String(row?.externalStudentId || '').trim();
      if (!name || !email) {
        results.push({ email, status: 'FAILED', error: 'Name and email are required.' });
        continue;
      }
      let user = await User.findOne({ email, tenantId: req.user.tenantId });
      if (!user) {
        const { createTenantUser } = await import('../services/userRoleService.js');
        user = await createTenantUser({
          name,
          email,
          password: row?.password,
          role: 'CANDIDATE',
          roles: ['CANDIDATE'],
          tenantId: req.user.tenantId,
          actorId: req.user._id,
          primaryOrganizationUnitId: program.organizationUnitId || null,
          organizationUnitAccess: program.organizationUnitId ? [{ organizationUnitId: program.organizationUnitId, grantedBy: req.user._id }] : [],
        });
      }
      const existing = await Enrollment.findOne({
        tenantId: req.user.tenantId,
        userId: user._id,
        academicSessionId,
        programId,
        cohortId: cohortId || null,
        academicSectionId: academicSectionId || null,
        status: 'ACTIVE',
      });
      if (existing) {
        results.push({ email, status: 'SKIPPED', enrollmentId: existing._id, error: 'Already enrolled.' });
        continue;
      }
      await assertEnrollmentValid({
        tenantId: req.user.tenantId,
        userId: user._id,
        academicSessionId,
        programId,
        curriculumVersionId: curriculumVersionId || null,
        cohortId: cohortId || null,
        academicSectionId: academicSectionId || null,
      });
      const enrollment = await Enrollment.create({
        tenantId: req.user.tenantId,
        userId: user._id,
        academicSessionId,
        programId,
        curriculumVersionId: curriculumVersionId || null,
        cohortId: cohortId || null,
        academicSectionId: academicSectionId || null,
        rollNumber: rollNumber || null,
        externalStudentId: externalStudentId || null,
        createdBy: req.user._id,
      });
      results.push({ email, status: 'CREATED', enrollmentId: enrollment._id, userId: user._id });
    }
    return res.status(201).json({ results });
  } catch (error) { return next(error); }
});

router.get('/my-course-offerings', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('ACADEMIC_ADMIN', 'TEACHER'), async (req, res, next) => {
  try {
    const orgContext = await resolveOrganizationContext(req.user);
    const filter = await buildAcademicListFilter(req.user, 'course-offerings', {
      organizationUnitId: orgContext.currentOrganizationUnitId,
    });
    const items = await CourseOffering.find({ ...filter, status: 'ACTIVE' })
      .populate('courseId', 'name code')
      .populate('academicSessionId', 'name code')
      .populate('programId', 'name code')
      .populate('academicPeriodId', 'name type sequence')
      .populate('cohortId', 'name code')
      .populate('academicSectionId', 'name code')
      .populate('facultyUserId', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    const withCounts = await Promise.all(items.map(async (offering) => ({
      ...offering,
      studentCount: await Enrollment.countDocuments({
        tenantId: req.user.tenantId,
        academicSessionId: offering.academicSessionId?._id,
        programId: offering.programId?._id,
        status: 'ACTIVE',
        ...(offering.cohortId?._id ? { cohortId: offering.cohortId._id } : {}),
        ...(offering.academicSectionId?._id ? { academicSectionId: offering.academicSectionId._id } : {}),
      }),
    })));
    return res.json({ items: withCounts });
  } catch (error) { return next(error); }
});

router.get('/course-offerings/:id/students', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('ACADEMIC_ADMIN', 'TEACHER'), async (req, res, next) => {
  try {
    const scopedFilter = await buildAcademicListFilter(req.user, 'course-offerings');
    // Keep the visibility predicate as a separate clause. Spreading an explicit
    // `_id` over scopedFilter would silently replace its `_id: { $in: [...] }`
    // boundary and let a teacher address another teacher's offering by id.
    const offering = await CourseOffering.findOne({ $and: [scopedFilter, { _id: req.params.id }] }).lean();
    if (!offering) return res.status(404).json({ error: 'Assigned course offering not found.' });
    const items = await Enrollment.find({
      tenantId: req.user.tenantId,
      academicSessionId: offering.academicSessionId,
      programId: offering.programId,
      status: 'ACTIVE',
      ...(offering.cohortId ? { cohortId: offering.cohortId } : {}),
      ...(offering.academicSectionId ? { academicSectionId: offering.academicSectionId } : {}),
    }).populate('userId', 'name email academicProfile').sort({ createdAt: 1 }).lean();
    return res.json({ items });
  } catch (error) { return next(error); }
});

export default router;
