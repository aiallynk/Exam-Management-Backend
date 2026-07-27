import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * Scoped, time-bound grant of evaluation access to an examiner.
 *
 * Whether someone CAN evaluate at all lives on ExamParticipant (examRole
 * EVALUATOR/MODERATOR). WHICH exam/section/questions/attempts they can
 * actually touch, and for how long, lives here. Holding the EVALUATOR role
 * does not by itself grant access to any submission — an active, unexpired,
 * matching-scope ExaminerAssignment is also required (see
 * middleware/examPermissions.js hasActiveExaminerAssignment).
 */
const ExaminerAssignmentSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false,
      sparse: true,
      immutable: true,
    },
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
    examinerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    scopeType: {
      type: String,
      enum: ['FULL_EXAM', 'SECTION', 'QUESTIONS', 'ATTEMPTS'],
      required: true,
      default: 'FULL_EXAM',
    },
    // Shape depends on scopeType: { sectionIds: [ObjectId] } | { questionIds: [ObjectId] } | { attemptIds: [ObjectId] }
    scopeData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // How this assignment's ATTEMPTS scope was populated. 'MANUAL' (default)
    // covers every pre-existing assignment and every FULL_EXAM/SECTION/
    // QUESTIONS grant. The other three are written by
    // services/responseDistributionService.js when candidate responses are
    // split across evaluators.
    assignmentMode: {
      type: String,
      enum: ['MANUAL', 'RANDOM_BALANCED', 'ROUND_ROBIN', 'WORKLOAD_BASED'],
      default: 'MANUAL',
    },

    accessStartsAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    accessExpiresAt: {
      type: Date,
    },

    canViewStudentIdentity: {
      type: Boolean,
      default: true,
    },
    canApproveAiScore: {
      type: Boolean,
      default: true,
    },
    canOverrideScore: {
      type: Boolean,
      default: true,
    },
    canAddFeedback: {
      type: Boolean,
      default: true,
    },
    requiresOverrideReason: {
      type: Boolean,
      default: true,
    },

    status: {
      type: String,
      enum: ['ACTIVE', 'REVOKED', 'EXPIRED', 'COMPLETED'],
      default: 'ACTIVE',
      index: true,
    },
    revokedAt: {
      type: Date,
    },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    completedAt: {
      type: Date,
    },

    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

ExaminerAssignmentSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('ExaminerAssignment'),
        ID_PREFIXES.EXAMINER_ASSIGNMENT
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Single field / lookup indexes
ExaminerAssignmentSchema.index({ examinerId: 1, status: 1 });
ExaminerAssignmentSchema.index({ examId: 1, status: 1 });
ExaminerAssignmentSchema.index({ tenantId: 1, status: 1 });
// A person may return to an exam after revocation/completion, but they cannot
// receive two simultaneous grants for the exact same scope. This is the
// database-level race guard behind the service's friendly 409 response.
ExaminerAssignmentSchema.index(
  { examId: 1, examinerId: 1, scopeType: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'ACTIVE' },
    name: 'active_evaluator_assignment_scope_unique',
  }
);

export default mongoose.model('ExaminerAssignment', ExaminerAssignmentSchema);
