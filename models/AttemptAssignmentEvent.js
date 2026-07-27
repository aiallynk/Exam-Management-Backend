import mongoose from 'mongoose';

/**
 * Append-only history of which evaluator a candidate's completed attempt was
 * assigned to, for auditing and for the "assignment history" requirement
 * around candidate-response distribution. This is intentionally separate
 * from ExaminerAssignment (which is the scoped access GRANT) — one grant
 * covers many attempts over time, and one attempt can move between grants
 * (reassignment); this collection is the append-only log of those moves.
 */
const AttemptAssignmentEventSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      index: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    attemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamAttempt',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ['ASSIGNED', 'REASSIGNED', 'REMOVED'],
      required: true,
    },
    // Evaluator the attempt belongs to after this event; null for REMOVED.
    examinerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    // Evaluator the attempt belonged to before this event; null for a fresh
    // ASSIGNED event (nothing to move from).
    previousExaminerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExaminerAssignment',
    },
    strategy: {
      type: String,
      enum: ['MANUAL', 'RANDOM_BALANCED', 'ROUND_ROBIN', 'WORKLOAD_BASED'],
      default: 'MANUAL',
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    performedByRole: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

AttemptAssignmentEventSchema.index({ examId: 1, attemptId: 1, createdAt: -1 });

export default mongoose.model('AttemptAssignmentEvent', AttemptAssignmentEventSchema);
