import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';
import { assertDisposableTestDatabase } from '../../utils/testDatabaseSafety.js';
import Tenant from '../../models/Tenant.js';
import User from '../../models/User.js';
import OrganizationUnit from '../../models/academic/OrganizationUnit.js';
import AcademicSession from '../../models/academic/AcademicSession.js';
import Program from '../../models/academic/Program.js';
import Specialization from '../../models/academic/Specialization.js';
import CurriculumVersion from '../../models/academic/CurriculumVersion.js';
import AcademicPeriod from '../../models/academic/AcademicPeriod.js';
import Course from '../../models/academic/Course.js';
import Cohort from '../../models/academic/Cohort.js';
import AcademicSection from '../../models/academic/AcademicSection.js';
import Enrollment from '../../models/academic/Enrollment.js';
import CourseOffering from '../../models/academic/CourseOffering.js';
import Exam from '../../models/Exam.js';
import QuestionPaper from '../../models/QuestionPaper.js';
import Section from '../../models/Section.js';
import Question from '../../models/Question.js';
import ExamSession from '../../models/ExamSession.js';
import ExamParticipant from '../../models/ExamParticipant.js';
import ExamAttempt from '../../models/ExamAttempt.js';
import Answer from '../../models/Answer.js';
import ExaminerAssignment from '../../models/ExaminerAssignment.js';
import AnswerScript from '../../models/AnswerScript.js';

export const PHASE5_E2E_PASSWORD = 'Phase5!Safe2026';

export const PHASE5_E2E_USERS = Object.freeze({
  SUPER_ADMIN: 'phase5.super@xamigo.test',
  TENANT_ADMIN: 'phase5.tenant.admin@xamigo.test',
  ACADEMIC_ADMIN: 'phase5.academic.admin@xamigo.test',
  TEACHER: 'phase5.teacher.a@xamigo.test',
  EXAM_CREATOR: 'phase5.creator.a@xamigo.test',
  EVALUATOR: 'phase5.evaluator.a@xamigo.test',
  CANDIDATE: 'phase5.candidate.1@xamigo.test',
  MULTI_ROLE: 'phase5.multi.role@xamigo.test',
});

const addUser = (data) => User.create({
  password: PHASE5_E2E_PASSWORD,
  status: 'ACTIVE',
  planType: 'legend',
  ...data,
});

const createTenant = async ({ name, code, type, rootType, rootName, superAdmin }) => {
  const tenant = await Tenant.create({
    name,
    code,
    type,
    contactEmail: `operations+${code.toLowerCase()}@xamigo.test`,
    status: 'ACTIVE',
    subscription: {
      planType: 'legend',
      status: 'ACTIVE',
      customFeatures: {
        examinerReview: true,
        mandatoryVerification: true,
        omr: true,
        aiSubjectiveAutoGrading: true,
        analytics: true,
      },
    },
    createdBy: superAdmin._id,
  });
  const root = await OrganizationUnit.create({
    tenantId: tenant._id,
    type: rootType,
    name: rootName,
    code: `${code}-ROOT`,
    createdBy: superAdmin._id,
  });
  tenant.rootOrganizationUnitId = root._id;
  await tenant.save();
  return { tenant, root };
};

const createPaper = async ({ exam, creator, questions }) => {
  const paper = await QuestionPaper.create({ examId: exam._id, setName: 'Set A', createdBy: creator._id });
  const section = await Section.create({
    questionPaperId: paper._id,
    name: 'Section A',
    order: 0,
    duration: exam.duration,
    marks: questions.reduce((sum, item) => sum + item.points, 0),
    marksPerQuestion: 1,
    expectedQuestions: questions.length,
  });
  const questionDocs = await Question.create(questions.map((question, index) => ({
    questionPaperId: paper._id,
    sectionId: section._id,
    order: index,
    isIncludedInExam: true,
    ...question,
  })));
  paper.sections = [section._id];
  await paper.save();
  return { paper, section, questions: questionDocs };
};

const createActiveSession = ({ exam, paper, creator, suffix }) => ExamSession.create({
  examId: exam._id,
  questionPaperId: paper._id,
  questionPaperIds: [paper._id],
  qrCode: `PHASE5-QR-${suffix}`,
  manualToken: `PHASE5-TOKEN-${suffix}`,
  isActive: true,
  startTime: new Date(Date.now() - 60 * 60 * 1000),
  endTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
  tenantId: exam.tenantId,
  assignAllCandidates: false,
  createdBy: creator._id,
});

const seedSchoolTenant = async ({ superAdmin }) => {
  const { tenant, root } = await createTenant({
    name: 'ABC Education Group', code: 'PHASE5_ABC', type: 'SCHOOL',
    rootType: 'SCHOOL_GROUP', rootName: 'ABC Education Group', superAdmin,
  });
  const ashoka = await OrganizationUnit.create({ tenantId: tenant._id, parentOrganizationUnitId: root._id, type: 'SCHOOL', name: 'Ashoka Marg', code: 'ASHOKA', createdBy: superAdmin._id });
  const otherBranch = await OrganizationUnit.create({ tenantId: tenant._id, parentOrganizationUnitId: root._id, type: 'SCHOOL', name: 'River Road', code: 'RIVER', createdBy: superAdmin._id });

  const tenantAdmin = await addUser({ email: PHASE5_E2E_USERS.TENANT_ADMIN, name: 'Tenant Admin A', role: 'TENANT_ADMIN', roles: ['TENANT_ADMIN'], tenantId: tenant._id });
  const academicAdmin = await addUser({ email: PHASE5_E2E_USERS.ACADEMIC_ADMIN, name: 'Academic Admin A', role: 'ACADEMIC_ADMIN', roles: ['ACADEMIC_ADMIN'], tenantId: tenant._id, academicAdminScope: { wholeTenant: false, organizationUnitIds: [ashoka._id], programIds: [] } });
  const teacherA = await addUser({ email: PHASE5_E2E_USERS.TEACHER, name: 'Teacher A', role: 'TEACHER', roles: ['TEACHER'], tenantId: tenant._id });
  const teacherB = await addUser({ email: 'phase5.teacher.b@xamigo.test', name: 'Teacher B', role: 'TEACHER', roles: ['TEACHER'], tenantId: tenant._id });
  const creatorA = await addUser({ email: PHASE5_E2E_USERS.EXAM_CREATOR, name: 'Creator A', role: 'EXAM_CREATOR', roles: ['EXAM_CREATOR'], tenantId: tenant._id });
  const creatorB = await addUser({ email: 'phase5.creator.b@xamigo.test', name: 'Creator B', role: 'EXAM_CREATOR', roles: ['EXAM_CREATOR'], tenantId: tenant._id });
  const evaluatorA = await addUser({ email: PHASE5_E2E_USERS.EVALUATOR, name: 'Evaluator A', role: 'EVALUATOR', roles: ['EVALUATOR'], tenantId: tenant._id, evaluatorAccess: { enabled: true, assignedAt: new Date(), assignedBy: tenantAdmin._id } });
  const multiRole = await addUser({ email: PHASE5_E2E_USERS.MULTI_ROLE, name: 'Teacher Creator Evaluator', role: 'TEACHER', roles: ['TEACHER', 'EXAM_CREATOR', 'EVALUATOR'], tenantId: tenant._id, evaluatorAccess: { enabled: true, assignedAt: new Date(), assignedBy: tenantAdmin._id } });
  const candidates = await Promise.all(Array.from({ length: 5 }, (_, index) => addUser({
    email: `phase5.candidate.${index + 1}@xamigo.test`,
    name: `Candidate ${index + 1}`,
    role: 'CANDIDATE',
    roles: ['CANDIDATE'],
    tenantId: tenant._id,
    academicProfile: { rollNumber: `VIIA-${String(index + 1).padStart(2, '0')}` },
  })));

  const academicSession = await AcademicSession.create({ tenantId: tenant._id, organizationUnitId: ashoka._id, name: '2026-27', code: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), createdBy: academicAdmin._id });
  const grade7 = await Program.create({ tenantId: tenant._id, organizationUnitId: ashoka._id, name: 'Grade VII', code: 'GRADE-VII', createdBy: academicAdmin._id });
  academicAdmin.academicAdminScope.programIds = [grade7._id];
  await academicAdmin.save();
  const curriculum = await CurriculumVersion.create({ tenantId: tenant._id, programId: grade7._id, name: 'ICSE Curriculum', code: 'ICSE-2026', effectiveFrom: new Date('2026-04-01'), createdBy: academicAdmin._id });
  const term = await AcademicPeriod.create({ tenantId: tenant._id, curriculumVersionId: curriculum._id, type: 'TERM', name: 'Term 1', sequence: 1, createdBy: academicAdmin._id });
  const science = await Course.create({ tenantId: tenant._id, curriculumVersionId: curriculum._id, name: 'Science', code: 'SCI-VII', createdBy: academicAdmin._id });
  const cohort = await Cohort.create({ tenantId: tenant._id, programId: grade7._id, academicSessionId: academicSession._id, curriculumVersionId: curriculum._id, name: 'Grade VII 2026-27', code: 'VII-2026', createdBy: academicAdmin._id });
  const sectionA = await AcademicSection.create({ tenantId: tenant._id, cohortId: cohort._id, name: 'VII A', code: 'VII-A', createdBy: academicAdmin._id });
  const offeringA = await CourseOffering.create({ tenantId: tenant._id, courseId: science._id, academicSessionId: academicSession._id, organizationUnitId: ashoka._id, programId: grade7._id, curriculumVersionId: curriculum._id, academicPeriodId: term._id, cohortId: cohort._id, academicSectionId: sectionA._id, facultyUserId: teacherA._id, assessmentCreatorUserIds: [creatorA._id, multiRole._id], createdBy: academicAdmin._id });
  const enrollments = await Enrollment.create(candidates.map((candidate) => ({ tenantId: tenant._id, userId: candidate._id, academicSessionId: academicSession._id, programId: grade7._id, curriculumVersionId: curriculum._id, cohortId: cohort._id, academicSectionId: sectionA._id, createdBy: academicAdmin._id })));

  const outOfScopeProgram = await Program.create({ tenantId: tenant._id, organizationUnitId: otherBranch._id, name: 'Grade VIII', code: 'GRADE-VIII', createdBy: tenantAdmin._id });
  const otherCurriculum = await CurriculumVersion.create({ tenantId: tenant._id, programId: outOfScopeProgram._id, name: 'State Curriculum', code: 'STATE-2026', createdBy: tenantAdmin._id });
  const otherPeriod = await AcademicPeriod.create({ tenantId: tenant._id, curriculumVersionId: otherCurriculum._id, type: 'TERM', name: 'Term 1', sequence: 1, createdBy: tenantAdmin._id });
  const otherCourse = await Course.create({ tenantId: tenant._id, curriculumVersionId: otherCurriculum._id, name: 'Mathematics', code: 'MATH-VIII', createdBy: tenantAdmin._id });
  const otherCohort = await Cohort.create({ tenantId: tenant._id, programId: outOfScopeProgram._id, academicSessionId: academicSession._id, curriculumVersionId: otherCurriculum._id, name: 'Grade VIII 2026-27', code: 'VIII-2026', createdBy: tenantAdmin._id });
  const sectionB = await AcademicSection.create({ tenantId: tenant._id, cohortId: otherCohort._id, name: 'VIII B', code: 'VIII-B', createdBy: tenantAdmin._id });
  const offeringB = await CourseOffering.create({ tenantId: tenant._id, courseId: otherCourse._id, academicSessionId: academicSession._id, organizationUnitId: otherBranch._id, programId: outOfScopeProgram._id, curriculumVersionId: otherCurriculum._id, academicPeriodId: otherPeriod._id, cohortId: otherCohort._id, academicSectionId: sectionB._id, facultyUserId: teacherB._id, assessmentCreatorUserIds: [creatorB._id], createdBy: tenantAdmin._id });

  const examA = await Exam.create({ title: 'Phase 5 Science OF Assessment', description: 'Seeded release-security and evaluator workflow assessment', duration: 60, deliveryMode: 'HYBRID', evaluationMode: 'AI_MANDATORY_REVIEW', assessmentPurpose: 'OF', assessmentType: 'EXAM', academicContext: { organizationUnitId: ashoka._id, academicSessionId: academicSession._id, programId: grade7._id, curriculumVersionId: curriculum._id, academicPeriodId: term._id, courseId: science._id, cohortId: cohort._id, academicSectionId: sectionA._id, courseOfferingId: offeringA._id }, resolvedSpecificationSnapshot: { specification: { feedback: { mode: 'AFTER_RELEASE', retries: 0, showCorrectAnswer: true } } }, resolvedSpecificationAt: new Date(), showResultsImmediately: false, tenantId: tenant._id, createdBy: creatorA._id, questionCount: 2, totalMarks: 10 });
  const paperA = await createPaper({ exam: examA, creator: creatorA, questions: [
    { questionText: 'Which process allows green plants to make food?', questionType: 'MULTIPLE_CHOICE', questionFormat: 'MCQ', options: ['Photosynthesis', 'Respiration', 'Transpiration', 'Germination'], correctAnswer: 'Photosynthesis', points: 4, difficulty: 'EASY', category: 'Photosynthesis', evaluationConfig: { explanation: 'Plants use light energy to make food.', rubric: [] } },
    { questionText: 'Explain how photosynthesis supports life on Earth.', questionType: 'SHORT_ANSWER', questionFormat: 'MCQ', correctAnswer: 'It produces food and oxygen using light, carbon dioxide, and water.', points: 6, difficulty: 'MEDIUM', category: 'Photosynthesis', evaluationConfig: { rubric: [{ criterion: 'Scientific accuracy', maxMarks: 4, description: 'Explains the process accurately.' }, { criterion: 'Importance', maxMarks: 2, description: 'Connects food and oxygen to life.' }] } },
  ] });
  const sessionA = await createActiveSession({ exam: examA, paper: paperA.paper, creator: creatorA, suffix: 'SCIENCE-OF' });
  await ExamParticipant.create([{ examId: examA._id, userId: creatorA._id, examRole: 'CREATOR', tenantId: tenant._id, assignedBy: creatorA._id }, { examId: examA._id, userId: evaluatorA._id, examRole: 'EVALUATOR', tenantId: tenant._id, assignedBy: creatorA._id }, ...candidates.map((candidate) => ({ examId: examA._id, userId: candidate._id, examRole: 'CANDIDATE', tenantId: tenant._id, assignedBy: creatorA._id }))]);
  const reviewAttempt = await ExamAttempt.create({ examId: examA._id, sessionId: sessionA._id, questionPaperId: paperA.paper._id, userId: candidates[0]._id, tenantId: tenant._id, startTime: new Date(Date.now() - 45 * 60 * 1000), submitTime: new Date(Date.now() - 5 * 60 * 1000), submittedAt: new Date(Date.now() - 5 * 60 * 1000), isCompleted: true, scoreSummary: { totalScore: 4, maxScore: 10, percentage: 40, computedAt: new Date() } });
  const reviewAnswers = await Answer.create([
    { attemptId: reviewAttempt._id, questionId: paperA.questions[0]._id, answerText: 'Photosynthesis', isCorrect: true, pointsEarned: 4, needsReview: false, finalScoreSource: 'RULE_ENGINE', evaluationStatus: 'REVIEWED', examinerScore: 4, examinerId: evaluatorA._id, examinerReviewedAt: new Date() },
    { attemptId: reviewAttempt._id, questionId: paperA.questions[1]._id, answerText: 'Plants make oxygen and food.', pointsEarned: 3, needsReview: true, finalScoreSource: 'AI', evaluationStatus: 'PENDING_REVIEW', aiEvaluation: { score: 3, feedback: 'Mentions food and oxygen.', confidence: 0.72, rubricScores: [{ criterion: 'Scientific accuracy', score: 2 }, { criterion: 'Importance', score: 1 }] } },
  ]);
  const finalizedDerivativeScript = await AnswerScript.create({
    tenantId: tenant._id,
    examId: examA._id,
    questionPaperId: paperA.paper._id,
    candidateId: candidates[0]._id,
    courseOfferingId: offeringA._id,
    sourceFile: { key: 'xamigo-private/phase5/original.pdf', url: 'private://phase5/original.pdf', checksum: 'phase5-derivative-source', sizeBytes: 1024 },
    originalFileName: 'phase5-candidate-1-science.pdf',
    mimeType: 'application/pdf',
    status: 'FINALIZED',
    mappingMethod: 'MANUAL',
    mappingConfidence: 1,
    materializedAttemptId: reviewAttempt._id,
    finalizedAt: new Date(),
    finalizedBy: evaluatorA._id,
    evaluatedDerivative: {
      key: 'xamigo-private/phase5/evaluated.pdf',
      checksum: 'phase5-evaluated-derivative',
      sizeBytes: 2048,
      mimeType: 'application/pdf',
      generatedAt: new Date(),
      generatedBy: evaluatorA._id,
      layoutMode: 'STRUCTURED_REVIEW_APPENDIX',
    },
    createdBy: teacherA._id,
  });
  const assignment = await ExaminerAssignment.create({ tenantId: tenant._id, examId: examA._id, examinerId: evaluatorA._id, scopeType: 'FULL_EXAM', scopeData: {}, accessStartsAt: new Date(Date.now() - 60 * 60 * 1000), accessExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), status: 'ACTIVE', assignedBy: creatorA._id });

  const forExam = await Exam.create({ title: 'Phase 5 Science FOR Concept Check', description: 'Seeded formative feedback and retry assessment', duration: 20, assessmentPurpose: 'FOR', assessmentType: 'QUIZ', academicContext: examA.academicContext, resolvedSpecificationSnapshot: { specification: { feedback: { mode: 'AFTER_QUESTION', retries: 1, showCorrectAnswer: false } } }, resolvedSpecificationAt: new Date(), tenantId: tenant._id, createdBy: creatorA._id, questionCount: 1, totalMarks: 1 });
  const forPaper = await createPaper({ exam: forExam, creator: creatorA, questions: [{ questionText: 'Which gas do plants absorb during photosynthesis?', questionType: 'MULTIPLE_CHOICE', questionFormat: 'MCQ', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'], correctAnswer: 'Carbon dioxide', points: 1, difficulty: 'EASY', category: 'Photosynthesis', evaluationConfig: { correctFeedback: 'Correct — plants absorb carbon dioxide.', incorrectFeedback: 'Revisit the inputs required for photosynthesis.', explanation: 'Carbon dioxide is one of the raw materials.' } }] });
  const forSession = await createActiveSession({ exam: forExam, paper: forPaper.paper, creator: creatorA, suffix: 'SCIENCE-FOR' });
  await ExamParticipant.create([{ examId: forExam._id, userId: creatorA._id, examRole: 'CREATOR', tenantId: tenant._id, assignedBy: creatorA._id }, { examId: forExam._id, userId: candidates[0]._id, examRole: 'CANDIDATE', tenantId: tenant._id, assignedBy: creatorA._id }]);
  const formativeAttempt = await ExamAttempt.create({ examId: forExam._id, sessionId: forSession._id, questionPaperId: forPaper.paper._id, userId: candidates[0]._id, tenantId: tenant._id, startTime: new Date(), isCompleted: false });

  const otherExam = await Exam.create({ title: 'Creator B Mathematics Assessment', duration: 30, deliveryMode: 'OFFLINE', evaluationMode: 'MANUAL', assessmentPurpose: 'OF', academicContext: { organizationUnitId: otherBranch._id, programId: outOfScopeProgram._id, curriculumVersionId: otherCurriculum._id, academicPeriodId: otherPeriod._id, courseId: otherCourse._id, cohortId: otherCohort._id, academicSectionId: sectionB._id, courseOfferingId: offeringB._id }, tenantId: tenant._id, createdBy: creatorB._id, questionCount: 1, totalMarks: 5 });
  const otherPaper = await createPaper({ exam: otherExam, creator: creatorB, questions: [{ questionText: 'Calculate 12 × 8.', questionType: 'NUMBER', questionFormat: 'MCQ', correctAnswer: '96', points: 5, difficulty: 'EASY', category: 'Arithmetic' }] });
  const otherSession = await createActiveSession({ exam: otherExam, paper: otherPaper.paper, creator: creatorB, suffix: 'OTHER' });
  const unassignedAttempt = await ExamAttempt.create({ examId: otherExam._id, sessionId: otherSession._id, questionPaperId: otherPaper.paper._id, userId: candidates[4]._id, tenantId: tenant._id, startTime: new Date(Date.now() - 30 * 60 * 1000), submittedAt: new Date(), submitTime: new Date(), isCompleted: true });
  await Answer.create({ attemptId: unassignedAttempt._id, questionId: otherPaper.questions[0]._id, answerText: '96', pointsEarned: 5, isCorrect: true, evaluationStatus: 'REVIEWED', finalScoreSource: 'RULE_ENGINE' });
  const otherAnswerScript = await AnswerScript.create({ tenantId: tenant._id, examId: otherExam._id, questionPaperId: otherPaper.paper._id, candidateId: candidates[4]._id, courseOfferingId: offeringB._id, sourceFile: { key: 'private/phase5/teacher-b-script.pdf', url: 'private://phase5/teacher-b-script.pdf', checksum: 'phase5-teacher-b-script', sizeBytes: 1024 }, originalFileName: 'teacher-b-script.pdf', mimeType: 'application/pdf', status: 'EVALUATED', mappingMethod: 'MANUAL', mappingConfidence: 1, materializedAttemptId: unassignedAttempt._id, createdBy: teacherB._id });

  return { tenant, root, ashoka, otherBranch, tenantAdmin, academicAdmin, teacherA, teacherB, creatorA, creatorB, evaluatorA, multiRole, candidates, academicSession, grade7, curriculum, term, science, cohort, sectionA, offeringA, enrollments, outOfScopeProgram, offeringB, examA, paperA, sessionA, reviewAttempt, reviewAnswers, finalizedDerivativeScript, assignment, forExam, forPaper, forSession, formativeAttempt, otherExam, otherPaper, unassignedAttempt, otherAnswerScript };
};

const seedIsolationTenant = async ({ superAdmin }) => {
  const { tenant, root } = await createTenant({ name: 'Phase 5 Isolation Tenant', code: 'PHASE5_TENANT_B', type: 'SCHOOL', rootType: 'SCHOOL_GROUP', rootName: 'Tenant B School Group', superAdmin });
  const tenantAdmin = await addUser({ email: 'phase5.tenant.b.admin@xamigo.test', name: 'Tenant Admin B', role: 'TENANT_ADMIN', roles: ['TENANT_ADMIN'], tenantId: tenant._id });
  const candidate = await addUser({ email: 'phase5.tenant.b.candidate@xamigo.test', name: 'Tenant B Candidate', role: 'CANDIDATE', roles: ['CANDIDATE'], tenantId: tenant._id });
  return { tenant, root, tenantAdmin, candidate };
};

const seedUniversityTenant = async ({ superAdmin }) => {
  const { tenant, root } = await createTenant({ name: 'XYZ University', code: 'PHASE5_XYZ', type: 'COLLEGE', rootType: 'UNIVERSITY', rootName: 'XYZ University', superAdmin });
  const college = await OrganizationUnit.create({ tenantId: tenant._id, parentOrganizationUnitId: root._id, type: 'COLLEGE', name: 'Engineering College', code: 'ENG', createdBy: superAdmin._id });
  const department = await OrganizationUnit.create({ tenantId: tenant._id, parentOrganizationUnitId: college._id, type: 'DEPARTMENT', name: 'Computer Science Department', code: 'CSE-DEPT', createdBy: superAdmin._id });
  const staff = await addUser({ email: 'phase5.xyz.staff@xamigo.test', name: 'XYZ Academic Staff', role: 'ACADEMIC_ADMIN', roles: ['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'], tenantId: tenant._id, academicAdminScope: { wholeTenant: false, organizationUnitIds: [department._id], programIds: [] } });
  const session = await AcademicSession.create({ tenantId: tenant._id, organizationUnitId: department._id, name: '2026-27', code: 'XYZ-2026-27', createdBy: staff._id });
  const program = await Program.create({ tenantId: tenant._id, organizationUnitId: department._id, name: 'B.Tech', code: 'BTECH', createdBy: staff._id });
  const specialization = await Specialization.create({ tenantId: tenant._id, programId: program._id, name: 'Computer Science', code: 'CSE', createdBy: staff._id });
  const curriculum = await CurriculumVersion.create({ tenantId: tenant._id, programId: program._id, specializationId: specialization._id, name: 'Curriculum 2026', code: 'BTECH-CSE-2026', createdBy: staff._id });
  const period = await AcademicPeriod.create({ tenantId: tenant._id, curriculumVersionId: curriculum._id, type: 'SEMESTER', name: 'Semester 3', sequence: 3, createdBy: staff._id });
  const course = await Course.create({ tenantId: tenant._id, curriculumVersionId: curriculum._id, name: 'Data Structures', code: 'CS203', credits: 4, createdBy: staff._id });
  const cohort = await Cohort.create({ tenantId: tenant._id, programId: program._id, academicSessionId: session._id, curriculumVersionId: curriculum._id, name: '2026-2030', code: '2026-2030', createdBy: staff._id });
  const section = await AcademicSection.create({ tenantId: tenant._id, cohortId: cohort._id, name: 'A', code: 'A', createdBy: staff._id });
  const offering = await CourseOffering.create({ tenantId: tenant._id, courseId: course._id, academicSessionId: session._id, organizationUnitId: department._id, programId: program._id, specializationId: specialization._id, curriculumVersionId: curriculum._id, academicPeriodId: period._id, cohortId: cohort._id, academicSectionId: section._id, facultyUserId: staff._id, assessmentCreatorUserIds: [staff._id], createdBy: staff._id });
  staff.academicAdminScope.programIds = [program._id];
  await staff.save();
  return { tenant, root, college, department, staff, session, program, specialization, curriculum, period, course, cohort, section, offering };
};

export const seedPhase5Demo = async ({ uri = process.env.TEST_MONGODB_URI } = {}) => {
  const target = assertDisposableTestDatabase({ nodeEnv: process.env.NODE_ENV, uri });
  await mongoose.connect(uri, { dbName: target.databaseName, autoIndex: true });
  await mongoose.connection.db.dropDatabase();

  const superAdmin = await addUser({ email: PHASE5_E2E_USERS.SUPER_ADMIN, name: 'Phase 5 Super Admin', role: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'] });
  const school = await seedSchoolTenant({ superAdmin });
  const isolation = await seedIsolationTenant({ superAdmin });
  const university = await seedUniversityTenant({ superAdmin });

  const result = {
    databaseName: target.databaseName,
    credentials: Object.fromEntries(Object.entries(PHASE5_E2E_USERS).map(([role, email]) => [role, { email, password: PHASE5_E2E_PASSWORD }])),
    ids: {
      tenantAId: String(school.tenant._id),
      candidateId: String(school.candidates[0]._id),
      tenantBId: String(isolation.tenant._id),
      universityTenantId: String(university.tenant._id),
      courseOfferingId: String(school.offeringA._id),
      otherTeacherCourseOfferingId: String(school.offeringB._id),
      otherTeacherAnswerScriptId: String(school.otherAnswerScript._id),
      otherCreatorExamId: String(school.otherExam._id),
      unassignedAttemptId: String(school.unassignedAttempt._id),
      outOfScopeProgramId: String(school.outOfScopeProgram._id),
      ofExamId: String(school.examA._id),
      ofAttemptId: String(school.reviewAttempt._id),
      finalizedDerivativeScriptId: String(school.finalizedDerivativeScript._id),
      ofQuestionPaperId: String(school.paperA.paper._id),
      ofQuestionId: String(school.paperA.questions[0]._id),
      forExamId: String(school.forExam._id),
      forAttemptId: String(school.formativeAttempt._id),
      forQuestionPaperId: String(school.forPaper.paper._id),
      forQuestionId: String(school.forPaper.questions[0]._id),
      evaluatorAssignmentId: String(school.assignment._id),
      universityCourseOfferingId: String(university.offering._id),
    },
    counts: {
      tenants: await Tenant.countDocuments(),
      users: await User.countDocuments(),
      courseOfferings: await CourseOffering.countDocuments(),
      exams: await Exam.countDocuments(),
      candidatesInSchoolOffering: school.candidates.length,
    },
  };

  await mongoose.disconnect();
  return result;
};

const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedFile && fileURLToPath(import.meta.url) === executedFile) {
  seedPhase5Demo()
    .then((result) => {
      process.stdout.write(`PHASE5_SEED_JSON=${JSON.stringify(result)}\n`);
    })
    .catch(async (error) => {
      process.stderr.write(`Phase 5 seed failed: ${error.stack || error.message}\n`);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}
