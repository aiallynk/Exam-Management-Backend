import mongoose from 'mongoose';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import AttemptAssignmentEvent from '../models/AttemptAssignmentEvent.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import { AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import {
  EvaluatorAssignmentError,
  loadExamAndEvaluator,
  createEvaluatorAssignment,
  computeAssignmentProgress,
} from './evaluatorAssignmentService.js';

export const DISTRIBUTION_STRATEGIES = ['RANDOM_BALANCED', 'ROUND_ROBIN', 'WORKLOAD_BASED'];
const DEFAULT_STRATEGY = 'RANDOM_BALANCED';

const toIdString = (value) => String(value?._id || value || '');

/**
 * Split `total` items into `buckets` groups whose sizes never differ by more
 * than one, largest buckets first. Pure and exported for unit tests.
 * computeBalancedSplit(10, 3) -> [4, 3, 3]
 * computeBalancedSplit(3, 4)  -> [1, 1, 1, 0]
 * computeBalancedSplit(10, 1) -> [10]
 */
export function computeBalancedSplit(total, buckets) {
  if (!Number.isFinite(total) || !Number.isFinite(buckets) || buckets <= 0) return [];
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** Fisher-Yates shuffle. Pure, does not mutate the input array. */
export function shuffleArray(items, randomFn = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Pure planning function: decides which evaluator each attempt in
 * `attemptIds` should go to, given each evaluator's current baseline count
 * (`currentCounts`). Never mutates its inputs and never touches the
 * database, so it is fully unit-testable without Mongo.
 *
 * Every strategy is a greedy "assign to whichever evaluator currently holds
 * the fewest attempts" core — the only thing that differs between
 * strategies is the ORDER attempts are considered in and how ties are
 * broken. Starting from equal (or workload-derived) baselines, this greedy
 * core provably keeps every evaluator's final count within 1 of every
 * other's, matching computeBalancedSplit for a fresh run, while also being
 * correct when called incrementally (one attempt at a time, e.g. from the
 * auto-distribute-on-submit hook) because it always looks at the current
 * running totals rather than assuming a single batch.
 *
 * @returns {{ assignments: {attemptId:string, evaluatorId:string}[], finalCounts: Record<string, number> }}
 */
export function planDistribution({
  attemptIds,
  evaluatorIds,
  strategy = DEFAULT_STRATEGY,
  currentCounts = {},
  randomFn = Math.random,
}) {
  if (!Array.isArray(evaluatorIds) || evaluatorIds.length === 0) {
    return { assignments: [], finalCounts: {} };
  }
  const ids = attemptIds.map(String);
  const evaluators = evaluatorIds.map(String);
  const running = new Map(evaluators.map((id) => [id, Number(currentCounts[id]) || 0]));

  if (strategy === 'ROUND_ROBIN') {
    const assignments = ids.map((attemptId, index) => ({
      attemptId,
      evaluatorId: evaluators[index % evaluators.length],
    }));
    assignments.forEach(({ evaluatorId }) => running.set(evaluatorId, (running.get(evaluatorId) || 0) + 1));
    return { assignments, finalCounts: Object.fromEntries(running) };
  }

  // RANDOM_BALANCED and WORKLOAD_BASED both use the greedy min-load core;
  // they only differ in ordering/tie-break, matching the distinction
  // between "randomised fairness" and "deterministic, workload-driven".
  const orderedAttempts = strategy === 'RANDOM_BALANCED' ? shuffleArray(ids, randomFn) : ids;
  const assignments = [];
  orderedAttempts.forEach((attemptId) => {
    let minCount = Infinity;
    let candidates = [];
    evaluators.forEach((evaluatorId) => {
      const count = running.get(evaluatorId) || 0;
      if (count < minCount) {
        minCount = count;
        candidates = [evaluatorId];
      } else if (count === minCount) {
        candidates.push(evaluatorId);
      }
    });
    const chosen = strategy === 'RANDOM_BALANCED' && candidates.length > 1
      ? candidates[Math.floor(randomFn() * candidates.length)]
      : candidates[0];
    running.set(chosen, (running.get(chosen) || 0) + 1);
    assignments.push({ attemptId, evaluatorId: chosen });
  });

  return { assignments, finalCounts: Object.fromEntries(running) };
}

/** Every ACTIVE ATTEMPTS-scope assignment for the exam (the distribution pool). */
async function getActiveAttemptScopeAssignments(examId, { session } = {}) {
  return ExaminerAssignment.find({ examId, scopeType: 'ATTEMPTS', status: 'ACTIVE' }).session(session || null);
}

/** Attempt IDs already claimed by some evaluator's ATTEMPTS-scope assignment. */
async function getAlreadyAssignedAttemptIdSet(examId, { session } = {}) {
  const assignments = await getActiveAttemptScopeAssignments(examId, { session });
  const set = new Set();
  assignments.forEach((assignment) => {
    (assignment.scopeData?.attemptIds || []).forEach((id) => set.add(String(id)));
  });
  return set;
}

/**
 * Every completed attempt for the exam that is not yet claimed by any
 * evaluator's ATTEMPTS-scope assignment — the pool distribution draws from.
 */
export async function getUnassignedCompletedAttemptIds(examId, { session } = {}) {
  const [completed, alreadyAssigned] = await Promise.all([
    ExamAttempt.find({ examId, isCompleted: true }).select('_id').session(session || null).lean(),
    getAlreadyAssignedAttemptIdSet(examId, { session }),
  ]);
  return completed.map((attempt) => String(attempt._id)).filter((id) => !alreadyAssigned.has(id));
}

/**
 * Get this evaluator's ATTEMPTS-scope assignment for the exam, creating an
 * empty one if this is their first time being registered for distribution.
 * Runs outside any transaction — it is independently idempotent (checked by
 * existence first) and its side effects (ExamParticipant sync, audit log,
 * notification) are the same ones every other assignment path already uses.
 */
async function getOrCreateAttemptsAssignment({ exam, evaluatorId, assignedBy, assignedByRole }) {
  const existing = await ExaminerAssignment.findOne({
    examId: exam._id,
    examinerId: evaluatorId,
    scopeType: 'ATTEMPTS',
    status: 'ACTIVE',
  });
  if (existing) return existing;

  const { examiner } = await loadExamAndEvaluator({
    examId: exam._id,
    examinerId: evaluatorId,
    tenantFilter: exam.tenantId ? { tenantId: exam.tenantId } : {},
    actorRole: assignedByRole,
  });

  return createEvaluatorAssignment({
    exam,
    examinerId: examiner._id,
    scopeType: 'ATTEMPTS',
    scopeData: { attemptIds: [] },
    assignedBy,
    assignedByRole,
  });
}

/**
 * Real-world workload baseline for WORKLOAD_BASED: each evaluator's current
 * pending-review count across every ACTIVE assignment they hold, tenant
 * wide (not just this exam) — read-only, computed outside the transaction
 * since a heuristic baseline does not need transactional freshness.
 */
async function getWorkloadBaseline(evaluatorIds) {
  const assignments = await ExaminerAssignment.find({ examinerId: { $in: evaluatorIds }, status: 'ACTIVE' }).lean();
  const progress = await computeAssignmentProgress(assignments);
  const totals = {};
  assignments.forEach((assignment) => {
    const evaluatorId = String(assignment.examinerId);
    const pending = progress.get(String(assignment._id))?.pending || 0;
    totals[evaluatorId] = (totals[evaluatorId] || 0) + pending;
  });
  evaluatorIds.forEach((id) => { if (totals[String(id)] === undefined) totals[String(id)] = 0; });
  return totals;
}

/**
 * Distribute currently-unassigned completed attempts for `examId` across
 * `evaluatorIds`, registering each evaluator for distribution if this is
 * their first time. Idempotent: attempts already claimed by any evaluator's
 * ATTEMPTS-scope assignment are never reconsidered, so calling this
 * repeatedly (or once per new submission) only ever assigns the newly
 * eligible remainder. Concurrency-safe via a Mongo transaction around the
 * read-plan-write sequence.
 *
 * @param {{examId, evaluatorIds:string[], strategy?:string, assignedBy, assignedByRole, tenantFilter?, attemptIdsOverride?:string[]}} params
 */
export async function distributeAttemptsAcrossEvaluators({
  examId,
  evaluatorIds,
  strategy = DEFAULT_STRATEGY,
  assignedBy,
  assignedByRole,
  tenantFilter,
  attemptIdsOverride,
}) {
  if (!Array.isArray(evaluatorIds) || evaluatorIds.length === 0) {
    throw new EvaluatorAssignmentError(400, 'At least one evaluatorId is required to distribute responses.');
  }
  if (!DISTRIBUTION_STRATEGIES.includes(strategy)) {
    throw new EvaluatorAssignmentError(400, `strategy must be one of ${DISTRIBUTION_STRATEGIES.join(', ')}`);
  }

  const exam = await Exam.findOne({ _id: examId, ...(tenantFilter || {}) });
  if (!exam) {
    throw new EvaluatorAssignmentError(404, 'Exam not found');
  }

  const uniqueEvaluatorIds = [...new Set(evaluatorIds.map(String))];
  const assignmentsByEvaluator = new Map();
  for (const evaluatorId of uniqueEvaluatorIds) {
    const assignment = await getOrCreateAttemptsAssignment({ exam, evaluatorId, assignedBy, assignedByRole });
    assignmentsByEvaluator.set(evaluatorId, assignment);
  }

  const workloadBaseline = strategy === 'WORKLOAD_BASED' ? await getWorkloadBaseline(uniqueEvaluatorIds) : {};

  const session = await mongoose.startSession();
  let summary;
  try {
    await session.withTransaction(async () => {
      const alreadyAssigned = await getAlreadyAssignedAttemptIdSet(examId, { session });
      let candidateAttemptIds;
      if (attemptIdsOverride) {
        const completedSet = new Set(
          (await ExamAttempt.find({ examId, isCompleted: true, _id: { $in: attemptIdsOverride } })
            .select('_id').session(session).lean()).map((a) => String(a._id))
        );
        candidateAttemptIds = attemptIdsOverride.map(String).filter((id) => completedSet.has(id));
      } else {
        candidateAttemptIds = await getUnassignedCompletedAttemptIds(examId, { session });
      }
      const unassignedAttemptIds = candidateAttemptIds.filter((id) => !alreadyAssigned.has(id));

      if (!unassignedAttemptIds.length) {
        summary = { distributed: 0, skippedAlreadyAssigned: candidateAttemptIds.length, perEvaluator: [] };
        return;
      }

      const currentCounts = {};
      uniqueEvaluatorIds.forEach((evaluatorId) => {
        const assignment = assignmentsByEvaluator.get(evaluatorId);
        currentCounts[evaluatorId] = strategy === 'WORKLOAD_BASED'
          ? (workloadBaseline[evaluatorId] || 0)
          : (assignment.scopeData?.attemptIds || []).length;
      });

      const { assignments } = planDistribution({
        attemptIds: unassignedAttemptIds,
        evaluatorIds: uniqueEvaluatorIds,
        strategy,
        currentCounts,
      });

      const byEvaluator = new Map();
      assignments.forEach(({ attemptId, evaluatorId }) => {
        if (!byEvaluator.has(evaluatorId)) byEvaluator.set(evaluatorId, []);
        byEvaluator.get(evaluatorId).push(attemptId);
      });

      const events = [];
      for (const [evaluatorId, attemptIds] of byEvaluator.entries()) {
        const assignment = assignmentsByEvaluator.get(evaluatorId);
        await ExaminerAssignment.updateOne(
          { _id: assignment._id },
          {
            $addToSet: { 'scopeData.attemptIds': { $each: attemptIds } },
            $set: { assignmentMode: strategy },
          },
          { session }
        );
        attemptIds.forEach((attemptId) => {
          events.push({
            tenantId: exam.tenantId || null,
            examId: exam._id,
            attemptId,
            action: 'ASSIGNED',
            examinerId: evaluatorId,
            previousExaminerId: null,
            assignmentId: assignment._id,
            strategy,
            performedBy,
            performedByRole,
          });
        });
      }

      if (events.length) {
        await AttemptAssignmentEvent.insertMany(events, { session });
      }

      summary = {
        distributed: unassignedAttemptIds.length,
        skippedAlreadyAssigned: candidateAttemptIds.length - unassignedAttemptIds.length,
        perEvaluator: [...byEvaluator.entries()].map(([evaluatorId, attemptIds]) => ({
          evaluatorId,
          newlyAssigned: attemptIds.length,
        })),
      };
    });
  } finally {
    await session.endSession();
  }

  if (summary.distributed > 0) {
    await logAuditEvent(AUDIT_ACTIONS.RESPONSE_DISTRIBUTION_COMPLETED, {
      userId: assignedBy,
      userRole: assignedByRole || null,
      tenantId: exam.tenantId || null,
      resourceType: 'Exam',
      resourceId: exam._id,
      details: { examId: exam._id, strategy, ...summary },
    });
  }

  return summary;
}

/**
 * Move a single candidate attempt from whichever evaluator currently holds
 * it to `toExaminerId`. Never deletes or alters the underlying Answer
 * review data (examinerScore/examinerFeedback/evaluationStatus) — only the
 * ExaminerAssignment scope changes, so completed review records survive
 * reassignment intact.
 */
export async function reassignAttempt({ examId, attemptId, toExaminerId, performedBy, performedByRole, tenantFilter }) {
  const exam = await Exam.findOne({ _id: examId, ...(tenantFilter || {}) });
  if (!exam) {
    throw new EvaluatorAssignmentError(404, 'Exam not found');
  }

  const destination = await getOrCreateAttemptsAssignment({
    exam,
    evaluatorId: toExaminerId,
    assignedBy: performedBy,
    assignedByRole: performedByRole,
  });

  const session = await mongoose.startSession();
  let previousExaminerId = null;
  try {
    await session.withTransaction(async () => {
      const sources = await ExaminerAssignment.find({
        examId,
        scopeType: 'ATTEMPTS',
        status: 'ACTIVE',
        'scopeData.attemptIds': attemptId,
      }).session(session);

      for (const source of sources) {
        if (String(source._id) === String(destination._id)) continue;
        previousExaminerId = source.examinerId;
        await ExaminerAssignment.updateOne(
          { _id: source._id },
          { $pull: { 'scopeData.attemptIds': attemptId } },
          { session }
        );
      }

      await ExaminerAssignment.updateOne(
        { _id: destination._id },
        { $addToSet: { 'scopeData.attemptIds': attemptId } },
        { session }
      );

      await AttemptAssignmentEvent.create([{
        tenantId: exam.tenantId || null,
        examId: exam._id,
        attemptId,
        action: sources.length ? 'REASSIGNED' : 'ASSIGNED',
        examinerId: toExaminerId,
        previousExaminerId,
        assignmentId: destination._id,
        strategy: 'MANUAL',
        performedBy,
        performedByRole,
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  await logAuditEvent(AUDIT_ACTIONS.EVALUATION_ASSIGNMENT_REASSIGNED, {
    userId: performedBy,
    userRole: performedByRole || null,
    tenantId: exam.tenantId || null,
    resourceType: 'ExaminerAssignment',
    resourceId: destination._id,
    details: { examId, attemptId, fromExaminerId: previousExaminerId, toExaminerId },
  });

  return { assignmentId: destination._id, attemptId, toExaminerId, previousExaminerId };
}

/**
 * Auto-distribution hook for the submission pipeline. Deliberately silent
 * (never throws) and a no-op unless the exam creator explicitly opted the
 * exam into automatic distribution (Exam.evaluatorDistributionStrategy set)
 * — every exam that predates this feature, and every exam that doesn't set
 * it, behaves exactly as before. Also a no-op if no evaluator has been
 * registered for distribution yet (nothing to assign to).
 */
export async function autoDistributeOnAttemptCompletion({ attemptId, examId }) {
  try {
    const exam = await Exam.findById(examId).select('tenantId evaluatorDistributionStrategy');
    if (!exam?.evaluatorDistributionStrategy) return;

    const registeredEvaluatorIds = (await getActiveAttemptScopeAssignments(examId))
      .map((assignment) => toIdString(assignment.examinerId))
      .filter(Boolean);
    if (!registeredEvaluatorIds.length) return;

    await distributeAttemptsAcrossEvaluators({
      examId,
      evaluatorIds: [...new Set(registeredEvaluatorIds)],
      strategy: exam.evaluatorDistributionStrategy,
      assignedBy: null,
      assignedByRole: 'SYSTEM_AUTO_DISTRIBUTION',
      attemptIdsOverride: [attemptId],
    });
  } catch (error) {
    console.error('[RESPONSE_DISTRIBUTION] Auto-distribution failed for attempt', attemptId, error?.message || error);
  }
}

/**
 * Per-exam distribution overview for the Manage Evaluators UI: every ACTIVE
 * assignment with review progress, plus how many completed attempts are not
 * yet claimed by any evaluator.
 */
export async function getDistributionSummary({ examId, tenantFilter }) {
  const exam = await Exam.findOne({ _id: examId, ...(tenantFilter || {}) })
    .select('title tenantId evaluationMode evaluatorDistributionStrategy')
    .lean();
  if (!exam) {
    throw new EvaluatorAssignmentError(404, 'Exam not found');
  }

  const assignments = await ExaminerAssignment.find({ examId, status: 'ACTIVE' })
    .populate('examinerId', 'name email')
    .sort({ createdAt: -1 })
    .lean();
  const progressByAssignment = await computeAssignmentProgress(assignments);

  const [totalCompleted, alreadyAssigned] = await Promise.all([
    ExamAttempt.countDocuments({ examId, isCompleted: true }),
    getAlreadyAssignedAttemptIdSet(examId),
  ]);

  return {
    exam,
    assignments: assignments.map((assignment) => ({
      ...assignment,
      progress: progressByAssignment.get(String(assignment._id)) || { pending: 0, completed: 0 },
    })),
    totalCompletedAttempts: totalCompleted,
    unassignedAttemptCount: Math.max(0, totalCompleted - alreadyAssigned.size),
  };
}
