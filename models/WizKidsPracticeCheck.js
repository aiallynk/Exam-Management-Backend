import mongoose from 'mongoose';

// WizKids Phase 7 — Practice Mode.
//
// An append-only record of every "check my answer" event during a Practice
// attempt — this is where "attempt history" (master prompt §54 Phase 7)
// lives, entirely isolated from the standard ExamAttempt/Answer models
// (master prompt §31's same isolation principle, applied one phase early
// since Practice needs its own event trail before Speed Mode's
// WizKidsAttemptState exists). A student may check the same question more
// than once (try again after getting it wrong) — each check is its own
// document, so the full practice journey is preserved, not just the latest
// state. Standard ExamAttempt/Answer records remain the sole source of
// truth for anything that affects a real grade; this collection never
// contributes to scoring.
const WizKidsPracticeCheckSchema = new mongoose.Schema(
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
      index: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    submittedAnswer: {
      type: mongoose.Schema.Types.Mixed,
    },
    isCorrect: {
      type: Boolean,
      required: true,
    },
    explanation: {
      type: String,
      trim: true,
      default: '',
    },
    checkedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

WizKidsPracticeCheckSchema.index({ attemptId: 1, questionId: 1, checkedAt: -1 });
WizKidsPracticeCheckSchema.index({ tenantId: 1, userId: 1, checkedAt: -1 });

export default mongoose.model('WizKidsPracticeCheck', WizKidsPracticeCheckSchema);
