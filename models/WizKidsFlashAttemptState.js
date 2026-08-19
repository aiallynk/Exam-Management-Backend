import mongoose from 'mongoose';

const RoundTimingSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  startedAt: { type: Date, required: true },
  answerOpenedAt: { type: Date, required: true },
  submittedAt: { type: Date, required: true },
  responseTimeMs: { type: Number, min: 0, required: true },
  isCorrect: { type: Boolean, required: true },
  timedOut: { type: Boolean, default: false },
}, { _id: false });

const WizKidsFlashAttemptStateSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', required: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  currentQuestionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
  roundStartedAt: { type: Date, default: null },
  submittedQuestionIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Question', default: [] },
  roundTimings: { type: [RoundTimingSchema], default: [] },
  startedAt: { type: Date, required: true, default: Date.now },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

WizKidsFlashAttemptStateSchema.index({ attemptId: 1 }, { unique: true });
WizKidsFlashAttemptStateSchema.index({ tenantId: 1, attemptId: 1 });

export default mongoose.model('WizKidsFlashAttemptState', WizKidsFlashAttemptStateSchema);

