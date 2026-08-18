import mongoose from 'mongoose';

// WizKids Phase 8 — Speed Mode.
//
// This model deliberately holds only WizKids-specific runtime state.  The
// existing ExamAttempt and Answer documents remain the authoritative record
// for the assessment and its submitted answers.  Keeping timer/navigation
// data here means Speed Mode can be removed without expanding either core
// schema (master prompt §§31-33).
const WizKidsQuestionTimingSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
    },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    durationSeconds: { type: Number, required: true, min: 0 },
    outcome: {
      type: String,
      enum: ['ANSWERED', 'TIMED_OUT', 'SKIPPED'],
      required: true,
    },
  },
  { _id: false }
);

const WizKidsAttemptStateSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    attemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamAttempt',
      required: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    mode: {
      type: String,
      enum: ['SPEED'],
      required: true,
      default: 'SPEED',
    },
    currentQuestionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      default: null,
    },
    questionStartedAt: {
      type: Date,
      default: null,
    },
    questionTimings: {
      type: [WizKidsQuestionTimingSchema],
      default: [],
    },
    lockedQuestionIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Question',
      default: [],
    },
    autoAdvance: {
      type: Boolean,
      required: true,
      default: true,
    },
    allowBackNavigation: {
      type: Boolean,
      required: true,
      default: false,
    },
    questionTimerSeconds: {
      type: Number,
      min: 1,
      default: null,
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Exactly one isolated Speed-mode state document can exist for a core
// attempt.  The tenant compound index keeps every operational read scoped.
WizKidsAttemptStateSchema.index({ attemptId: 1 }, { unique: true });
WizKidsAttemptStateSchema.index({ tenantId: 1, attemptId: 1 });
WizKidsAttemptStateSchema.index({ tenantId: 1, examId: 1, createdAt: -1 });

export default mongoose.model('WizKidsAttemptState', WizKidsAttemptStateSchema);
