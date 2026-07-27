import ExaminerAssignment from '../models/ExaminerAssignment.js';
import ExamParticipant from '../models/ExamParticipant.js';
import Exam from '../models/Exam.js';
import Question from '../models/Question.js';
import User from '../models/User.js';
import { AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { createUserNotifications } from './notificationService.js';
import { hasRole } from '../utils/userRoles.js';

/**
 * Single home for evaluator↔exam assignment logic, used by both the
 * top-level /api/examiner-assignments router and the exam-scoped
 * /api/exams/:examId/evaluators router, so tenant/plan/scope validation is
 * only implemented once. See models/ExaminerAssignment.js for the
 * ExamParticipant-vs-ExaminerAssignment split this preserves.
 */
export const SCOPE_TYPES = ['FULL_EXAM', 'SECTION', 'QUESTIONS', 'ATTEMPTS'];

const PENDING_EVALUATION_STATUSES = ['PENDING_REVIEW', 'UNDER_REVIEW', 'FLAGGED'];
const COMPLETED_EVALUATION_STATUSES = ['REVIEWED', 'FINALIZED', 'MODERATED'];

const EVALUATOR_EXCLUDED_ROLES = Object.freeze(['CANDIDATE', 'TENANT_ADMIN']);

// An evaluator can be a dedicated EVALUATOR account or an Exam Creator with
// EVALUATOR added as an extra role. Candidate and Tenant Admin accounts are
// intentionally never repurposed as evaluators.
export const isEligibleEvaluatorAssignee = (user) =>
  user?.status === 'ACTIVE' &&
  hasRole(user, 'EVALUATOR') &&
  user?.evaluatorAccess?.enabled === true &&
  !EVALUATOR_EXCLUDED_ROLES.some((role) => hasRole(user, role));

// Keep every evaluator picker aligned with assignment authorization. This is
// intentionally exported instead of repeating a subtly different Mongo query
// in tenant-wide and exam-specific endpoints.
export const getEligibleEvaluatorUserFilter = ({ tenantId, now = new Date() } = {}) => ({
  ...(tenantId ? { tenantId } : {}),
  status: 'ACTIVE',
  'evaluatorAccess.enabled': true,
  $and: [
    { $or: [{ role: 'EVALUATOR' }, { roles: 'EVALUATOR' }] },
    {
      $nor: [
        { role: { $in: EVALUATOR_EXCLUDED_ROLES } },
        { roles: { $in: EVALUATOR_EXCLUDED_ROLES } },
      ],
    },
    {
      $or: [
        { 'evaluatorAccess.accessExpiresAt': null },
        { 'evaluatorAccess.accessExpiresAt': { $gte: now } },
      ],
    },
  ],
});

export class EvaluatorAssignmentError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'EvaluatorAssignmentError';
    this.status = status;
  }
}

/**
 * Ensure the examiner holds an EVALUATOR ExamParticipant doc for this exam,
 * without disturbing any other role doc (e.g. CANDIDATE/CREATOR) they may
 * already hold for the same exam — operates strictly on the
 * {examId,userId,examRole:'EVALUATOR'} compound key.
 */
export async function ensureEvaluatorParticipant(examId, userId, tenantId, assignedBy) {
  let participant = await ExamParticipant.findOne({ examId, userId, examRole: 'EVALUATOR' });
  if (!participant) {
    participant = new ExamParticipant({
      examId,
      userId,
      examRole: 'EVALUATOR',
      assignedBy,
      tenantId: tenantId || null,
    });
    try {
      await participant.save();
    } catch (error) {
      if (error?.code !== 11000) throw error;

      // A concurrent assign request can legitimately win this insert. Re-read
      // the intended role record before treating the duplicate as an error.
      participant = await ExamParticipant.findOne({ examId, userId, examRole: 'EVALUATOR' });
      if (participant) return participant;

      // The only remaining duplicate shape is a pre-role-aware database
      // index. The migration replaces it with { examId, userId, examRole };
      // never pass Mongo's raw "examId already exists" message to the UI.
      if (error?.keyPattern?.examId && error?.keyPattern?.userId && !error?.keyPattern?.examRole) {
        throw new EvaluatorAssignmentError(503, 'Evaluator assignment setup is being updated. Please retry in a moment.');
      }
      throw new EvaluatorAssignmentError(409, 'Another evaluator assignment request completed at the same time. Refresh the assignment list and try again if needed.');
    }
  }
  return participant;
}

/**
 * Load and cross-validate the exam and the candidate examiner for a new
 * assignment: exam must be within the caller's tenant scope, the examiner
 * must share the exam's tenant (unless the actor is SUPER_ADMIN), and the
 * examiner must currently hold active, unexpired evaluator capability.
 */
export async function loadExamAndEvaluator({ examId, examinerId, tenantFilter, actorRole }) {
  const exam = await Exam.findOne({ _id: examId, ...(tenantFilter || {}) });
  if (!exam) {
    throw new EvaluatorAssignmentError(404, 'Exam not found');
  }

  const examiner = await User.findById(examinerId).select('tenantId role roles status evaluatorAccess name email');
  if (!examiner) {
    throw new EvaluatorAssignmentError(404, 'Examiner user not found');
  }

  if (
    actorRole !== 'SUPER_ADMIN' &&
    exam.tenantId &&
    examiner.tenantId &&
    String(exam.tenantId) !== String(examiner.tenantId)
  ) {
    throw new EvaluatorAssignmentError(403, 'Examiner must belong to the same tenant as the exam');
  }

  if (!isEligibleEvaluatorAssignee(examiner)) {
    throw new EvaluatorAssignmentError(422, 'Only an active Evaluator can be assigned to review an exam. Candidates and Tenant Admins cannot be assigned as evaluators.');
  }

  // Note: there is no limit here on how many evaluators an exam may have, or
  // how many exams an evaluator may be assigned to — both are many-to-many
  // by design (separate ExaminerAssignment documents). The only thing this
  // check gates is whether THIS SPECIFIC user's own evaluator access is
  // currently enabled and unexpired.
  if (!examiner.evaluatorAccess?.enabled) {
    throw new EvaluatorAssignmentError(409, `${examiner.name || 'This user'} does not currently have evaluator access enabled. Grant evaluator access first, then assign exams.`);
  }
  if (examiner.evaluatorAccess.accessExpiresAt && new Date(examiner.evaluatorAccess.accessExpiresAt) < new Date()) {
    throw new EvaluatorAssignmentError(409, `${examiner.name || 'This user'}'s evaluator access expired on ${new Date(examiner.evaluatorAccess.accessExpiresAt).toLocaleString()}. Extend their access before assigning more exams.`);
  }

  return { exam, examiner };
}

/**
 * Create a scoped, time-bound ExaminerAssignment and keep the coarse-grained
 * ExamParticipant record in sync, in one call so no call site can create one
 * without the other. Throws EvaluatorAssignmentError for validation failures
 * so callers can map status/message directly onto the HTTP response.
 */
export async function createEvaluatorAssignment({
  exam,
  examinerId,
  scopeType,
  scopeData,
  accessStartsAt,
  accessExpiresAt,
  capabilities = {},
  assignedBy,
  assignedByRole,
}) {
  if (scopeType && !SCOPE_TYPES.includes(scopeType)) {
    throw new EvaluatorAssignmentError(400, `scopeType must be one of ${SCOPE_TYPES.join(', ')}`);
  }

  const startsAt = accessStartsAt ? new Date(accessStartsAt) : new Date();
  const expiresAt = accessExpiresAt ? new Date(accessExpiresAt) : undefined;
  if (expiresAt && expiresAt <= startsAt) {
    throw new EvaluatorAssignmentError(400, 'accessExpiresAt must be after accessStartsAt');
  }

  const resolvedScopeType = scopeType || 'FULL_EXAM';
  const existingActive = await ExaminerAssignment.findOne({
    examId: exam._id,
    examinerId,
    scopeType: resolvedScopeType,
    status: 'ACTIVE',
  }).select('_id');
  if (existingActive) {
    throw new EvaluatorAssignmentError(409, 'This evaluator already has an active assignment with the same scope on this exam. Edit or revoke it instead of assigning the exam again.');
  }

  await ensureEvaluatorParticipant(exam._id, examinerId, exam.tenantId, assignedBy);

  let assignment;
  try {
    assignment = await ExaminerAssignment.create({
      tenantId: exam.tenantId || null,
      examId: exam._id,
      examinerId,
      scopeType: resolvedScopeType,
      scopeData: scopeData || {},
      assignmentMode: 'MANUAL',
      accessStartsAt: startsAt,
      accessExpiresAt: expiresAt,
      canViewStudentIdentity: capabilities.canViewStudentIdentity !== false,
      canApproveAiScore: capabilities.canApproveAiScore !== false,
      canOverrideScore: capabilities.canOverrideScore !== false,
      canAddFeedback: capabilities.canAddFeedback !== false,
      requiresOverrideReason: capabilities.requiresOverrideReason !== false,
      status: 'ACTIVE',
      assignedBy,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new EvaluatorAssignmentError(409, 'This evaluator already has an active assignment with the same scope on this exam. Edit or revoke it instead of assigning the exam again.');
    }
    throw error;
  }

  await logAuditEvent(AUDIT_ACTIONS.EXAMINER_ASSIGNMENT_CREATED, {
    userId: assignedBy,
    userRole: assignedByRole || null,
    tenantId: exam.tenantId || null,
    resourceType: 'ExaminerAssignment',
    resourceId: assignment._id,
    details: { examId: exam._id, examinerId, scopeType: assignment.scopeType },
  });

  try {
    await createUserNotifications({
      title: 'New Evaluation Assignment',
      message: `You have been assigned to evaluate "${exam.title}".`,
      type: 'examiner_assignment_created',
      tenantId: exam.tenantId || null,
      examId: exam._id,
      createdBy: assignedBy,
      userIds: [examinerId],
      metadata: { examId: exam._id, assignmentId: assignment._id },
    });
  } catch (notifyError) {
    console.error('[NOTIFICATIONS] Failed to notify examiner assignment:', notifyError?.message || notifyError);
  }

  return assignment;
}

/**
 * Resolve which question IDs an assignment's scope covers, for computing
 * pending/completed review counts. Returns null for scopes that are not
 * question-shaped (FULL_EXAM, ATTEMPTS) — callers should treat null as "no
 * question-level filter needed".
 */
export async function getScopedQuestionIds(assignment) {
  if (assignment.scopeType === 'QUESTIONS') {
    return (assignment.scopeData?.questionIds || []).map(String);
  }
  if (assignment.scopeType === 'SECTION') {
    const sectionIds = assignment.scopeData?.sectionIds || [];
    if (!sectionIds.length) return [];
    const questions = await Question.find({ sectionId: { $in: sectionIds } }).select('_id').lean();
    return questions.map((question) => String(question._id));
  }
  return null;
}

/**
 * Compute pending/completed answer counts for a list of assignments on the
 * same exam, respecting each assignment's scope (FULL_EXAM/SECTION/
 * QUESTIONS/ATTEMPTS). Used by exam-scoped "Manage Evaluators" views.
 */
export async function computeAssignmentProgress(assignments) {
  if (!assignments.length) return new Map();

  const Answer = (await import('../models/Answer.js')).default;
  const ExamAttempt = (await import('../models/ExamAttempt.js')).default;

  const progress = new Map();

  await Promise.all(
    assignments.map(async (assignment) => {
      const baseMatch = {};
      if (assignment.scopeType === 'ATTEMPTS') {
        baseMatch.attemptId = { $in: (assignment.scopeData?.attemptIds || []) };
      } else {
        const scopedQuestionIds = await getScopedQuestionIds(assignment);
        if (scopedQuestionIds !== null) {
          if (!scopedQuestionIds.length) {
            progress.set(String(assignment._id), { pending: 0, completed: 0 });
            return;
          }
          baseMatch.questionId = { $in: scopedQuestionIds };
        } else {
          const attemptIds = await ExamAttempt.find({ examId: assignment.examId, isCompleted: true })
            .distinct('_id');
          baseMatch.attemptId = { $in: attemptIds };
        }
      }

      const counts = await Answer.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: null,
            pending: { $sum: { $cond: [{ $in: ['$evaluationStatus', PENDING_EVALUATION_STATUSES] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $in: ['$evaluationStatus', COMPLETED_EVALUATION_STATUSES] }, 1, 0] } },
          },
        },
      ]);

      progress.set(String(assignment._id), counts[0] ? { pending: counts[0].pending, completed: counts[0].completed } : { pending: 0, completed: 0 });
    })
  );

  return progress;
}
