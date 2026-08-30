import mongoose from 'mongoose';
import config from '../config/env.js';
import AcademicEntity from '../models/AcademicEntity.js';
import {
  OrganizationUnit, AcademicSession, Program, Specialization, CurriculumVersion,
  AcademicPeriod, Course, Cohort, AcademicSection, Enrollment, CourseOffering,
} from '../models/academic/index.js';

// Non-destructive migration from the generic AcademicEntity collection into
// the explicit domain models — see docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md
// Part 1 / "MIGRATION FROM AcademicEntity". AcademicEntity is never
// modified or deleted by this script, in either mode.
//
// SAFE BY DEFAULT: with no flags, this only reads AcademicEntity and prints
// a report — no database write happens. Pass --apply to actually create the
// new documents. Re-running with --apply is idempotent: any AcademicEntity
// _id that already exists in its target collection is skipped, not
// duplicated or overwritten.
//
// New documents reuse the SOURCE AcademicEntity's _id, so every existing
// reference to it (Exam.academicContext.*, QuestionUsage.courseOfferingId,
// framework/rubric scope arrays, ...) keeps resolving without a second
// rewrite pass anywhere else in the codebase.
//
// Not every historical record can migrate cleanly: the old generic router
// (routes/academic.js) never required the richer relationships the new
// explicit models do (e.g. Program.organizationUnitId, CourseOffering's
// full join, Enrollment.programId). Records missing a now-required field
// are reported as "needs manual completion" and — in --apply mode — are
// skipped rather than written with a fabricated/guessed value.

const apply = process.argv.includes('--apply');
const BATCH_SIZE = 200;

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '') ?? null;

// entityType -> { Model, map(sourceDoc) -> { doc, missing: string[] } }
const RESOURCE_MAP = {
  ORGANIZATION_UNIT: {
    Model: OrganizationUnit,
    map: (source) => ({
      doc: {
        _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '',
        parentOrganizationUnitId: first(source.references?.parentOrganizationUnitId, source.parentId),
        // The old model never captured a UNIVERSITY/COLLEGE/BRANCH/... type
        // distinction per record — cannot be inferred, defaults to OTHER
        // and is flagged for manual reclassification in the new UI.
        type: 'OTHER',
        status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true },
      },
      missing: [],
      note: 'type defaulted to OTHER — reclassify in Institution & Academics once migrated.',
    }),
  },
  ACADEMIC_SESSION: {
    Model: AcademicSession,
    map: (source) => ({
      doc: {
        _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '',
        organizationUnitId: first(source.references?.organizationUnitId, source.parentId),
        status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true },
      },
      missing: [],
    }),
  },
  PROGRAM: {
    Model: Program,
    map: (source) => {
      const organizationUnitId = first(source.references?.organizationUnitId, source.parentId);
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '', organizationUnitId, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing: organizationUnitId ? [] : ['organizationUnitId'],
      };
    },
  },
  SPECIALIZATION: {
    Model: Specialization,
    map: (source) => {
      const programId = first(source.references?.programId, source.parentId);
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '', programId, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing: programId ? [] : ['programId'],
      };
    },
  },
  CURRICULUM_VERSION: {
    Model: CurriculumVersion,
    map: (source) => {
      const programId = first(source.references?.programId, source.parentId);
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '', programId, specializationId: source.references?.specializationId || null, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing: programId ? [] : ['programId'],
      };
    },
  },
  ACADEMIC_PERIOD: {
    Model: AcademicPeriod,
    map: (source) => {
      const curriculumVersionId = first(source.references?.curriculumVersionId, source.parentId);
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, curriculumVersionId, type: 'TERM', sequence: 0, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing: curriculumVersionId ? [] : ['curriculumVersionId'],
        note: 'type defaulted to TERM (SEMESTER/TRIMESTER/YEAR/MODULE/PHASE were never distinguished in the old model) — verify in Institution & Academics.',
      };
    },
  },
  COURSE: {
    Model: Course,
    map: (source) => {
      const curriculumVersionId = first(source.references?.curriculumVersionId, source.parentId);
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '', curriculumVersionId, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing: curriculumVersionId ? [] : ['curriculumVersionId'],
      };
    },
  },
  COHORT: {
    Model: Cohort,
    map: (source) => {
      const programId = first(source.references?.programId, source.parentId);
      const academicSessionId = source.references?.academicSessionId || null;
      const missing = [];
      if (!programId) missing.push('programId');
      if (!academicSessionId) missing.push('academicSessionId');
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '', programId, academicSessionId, curriculumVersionId: source.references?.curriculumVersionId || null, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing,
      };
    },
  },
  SECTION: {
    Model: AcademicSection,
    map: (source) => {
      const cohortId = first(source.references?.cohortId, source.parentId);
      return {
        doc: { _id: source._id, tenantId: source.tenantId, name: source.name, code: source.code || '', cohortId, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing: cohortId ? [] : ['cohortId'],
      };
    },
  },
  ENROLLMENT: {
    Model: Enrollment,
    map: (source) => {
      const userId = source.references?.userId || null;
      const academicSessionId = source.references?.academicSessionId || null;
      const programId = source.references?.programId || null; // never required by the old router — commonly absent
      const missing = [];
      if (!userId) missing.push('userId');
      if (!academicSessionId) missing.push('academicSessionId');
      if (!programId) missing.push('programId');
      return {
        doc: { _id: source._id, tenantId: source.tenantId, userId, academicSessionId, programId, curriculumVersionId: source.references?.curriculumVersionId || null, cohortId: source.references?.cohortId || null, academicSectionId: source.references?.sectionId || null, status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true } },
        missing,
      };
    },
  },
  COURSE_OFFERING: {
    Model: CourseOffering,
    map: (source) => {
      const courseId = source.references?.courseId || null;
      const academicSessionId = source.references?.academicSessionId || null;
      const organizationUnitId = source.references?.organizationUnitId || null;
      const programId = source.references?.programId || null;
      const curriculumVersionId = source.references?.curriculumVersionId || null;
      const academicPeriodId = source.references?.academicPeriodId || null;
      const required = { courseId, academicSessionId, organizationUnitId, programId, curriculumVersionId, academicPeriodId };
      const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
      return {
        doc: {
          _id: source._id, tenantId: source.tenantId, ...required,
          specializationId: source.references?.specializationId || null,
          cohortId: source.references?.cohortId || null,
          academicSectionId: source.references?.sectionId || null,
          status: mapStatus(source.status), metadata: { ...source.metadata, migratedFromAcademicEntity: true },
        },
        missing,
        note: missing.length ? 'The old model only ever captured courseId for a Course Offering — the richer join fields were never collected. This record cannot migrate automatically; re-create it via Institution & Academics once its Course/Program/Curriculum/Period counterparts exist.' : undefined,
      };
    },
  },
};

function mapStatus(oldStatus) {
  // Old AcademicEntity.status enum: ACTIVE | INACTIVE | DRAFT | ARCHIVED.
  // New models use ACTIVE | INACTIVE | ARCHIVED (DRAFT collapses to INACTIVE
  // — none of the new models model a separate draft workflow per record).
  return oldStatus === 'DRAFT' ? 'INACTIVE' : (oldStatus || 'ACTIVE');
}

const run = async () => {
  await mongoose.connect(config.mongodbUri, { dbName: 'exam_system' });
  console.log(apply ? 'Running in --apply mode: new documents WILL be written.' : 'Running in dry-run mode (default). Pass --apply to write. AcademicEntity is never modified either way.');

  const summary = [];
  let totalCreated = 0;
  let totalSkippedExisting = 0;
  let totalSkippedIncomplete = 0;

  for (const [entityType, resource] of Object.entries(RESOURCE_MAP)) {
    const cursor = AcademicEntity.find({ entityType }).cursor();
    let scanned = 0;
    let migratable = 0;
    let incomplete = 0;
    let alreadyMigrated = 0;
    let created = 0;
    const incompleteExamples = [];

    for (let source = await cursor.next(); source != null; source = await cursor.next()) {
      scanned += 1;
      const existing = await resource.Model.findById(source._id).select('_id').lean();
      if (existing) { alreadyMigrated += 1; continue; }

      const { doc, missing, note } = resource.map(source);
      if (missing.length) {
        incomplete += 1;
        if (incompleteExamples.length < 5) incompleteExamples.push({ id: String(source._id), name: source.name, missing });
        continue;
      }
      migratable += 1;
      if (apply) {
        await resource.Model.create(doc);
        created += 1;
      }
      if (note && incompleteExamples.length < 5) incompleteExamples.push({ id: String(source._id), name: source.name, note });
    }

    totalCreated += created;
    totalSkippedExisting += alreadyMigrated;
    totalSkippedIncomplete += incomplete;
    summary.push({ entityType, scanned, migratable, incomplete, alreadyMigrated, created, incompleteExamples });
  }

  console.log('\n--- Migration report (by entity type) ---');
  summary.forEach((row) => {
    console.log(`\n${row.entityType}: ${row.scanned} scanned, ${row.migratable} migratable, ${row.incomplete} incomplete (missing required fields), ${row.alreadyMigrated} already migrated, ${row.created} created this run.`);
    row.incompleteExamples.forEach((example) => {
      if (example.missing) console.log(`  - ${example.id} "${example.name}" missing: ${example.missing.join(', ')}`);
      else if (example.note) console.log(`  - ${example.id} "${example.name}": ${example.note}`);
    });
  });

  console.log(`\nTotals: ${totalCreated} document(s) ${apply ? 'created' : 'would be created with --apply'}, ${totalSkippedExisting} already migrated (skipped), ${totalSkippedIncomplete} incomplete (skipped, need manual completion in the new UI).`);
  console.log('\nRollback note: this script only creates new documents in the explicit academic-* collections; it never modifies AcademicEntity. To roll back, drop the specific new documents created (their metadata.migratedFromAcademicEntity === true) — AcademicEntity itself is untouched and remains the source of truth until you are satisfied with parity.');
};

run()
  .catch((error) => {
    console.error('Academic entity migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
