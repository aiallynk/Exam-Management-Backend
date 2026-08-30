import mongoose from 'mongoose';

const AnswerSchema = new mongoose.Schema(
  {
    attemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamAttempt',
      required: true,
      index: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
    },
    answerText: {
      type: String,
      default: '',
      trim: true,
    },
    isCorrect: {
      type: Boolean,
    },
    pointsEarned: {
      type: Number,
      default: 0,
      min: 0,
    },
    aiEvaluation: {
      type: mongoose.Schema.Types.Mixed,
    },
    rubricEvaluation: {
      aiScores: { type: mongoose.Schema.Types.Mixed, default: [] },
      finalScores: { type: mongoose.Schema.Types.Mixed, default: [] },
      finalMark: { type: Number, min: 0, default: null },
      overriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      overrideReason: { type: String, trim: true, default: '' },
      updatedAt: { type: Date, default: null },
    },
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
    },
    codingResult: {
      type: mongoose.Schema.Types.Mixed,
    },
    needsReview: {
      type: Boolean,
      default: false,
    },
    // Set only when this Answer was materialized from a scanned offline
    // answer script (Master Phase 4) rather than typed online — links back
    // to the AnswerSegment so the evaluator UI can show the original
    // scanned page alongside the extracted text. Null for every online
    // answer, which is the overwhelming majority of Answer documents.
    sourceAnswerSegmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AnswerSegment',
      default: null,
    },
    timeSpent: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─── Examiner verification (additive; pointsEarned/isCorrect/aiEvaluation
    // above remain the "current effective value" for every existing reader) ──
    examinerScore: {
      type: Number,
      min: 0,
    },
    examinerFeedback: {
      type: String,
      trim: true,
    },
    examinerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    examinerReviewedAt: {
      type: Date,
    },

    moderatorScore: {
      type: Number,
      min: 0,
    },
    moderatorFeedback: {
      type: String,
      trim: true,
    },
    moderatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    moderatorReviewedAt: {
      type: Date,
    },

    finalScoreSource: {
      type: String,
      enum: ['RULE_ENGINE', 'AI', 'EXAMINER', 'MODERATOR', 'ADMIN_OVERRIDE'],
    },

    evaluationStatus: {
      type: String,
      enum: [
        'NOT_ATTEMPTED',
        'NOT_EVALUATED',
        'AUTO_EVALUATED',
        'AI_EVALUATED',
        'PENDING_REVIEW',
        'UNDER_REVIEW',
        'REVIEWED',
        'FLAGGED',
        'MODERATED',
        'FINALIZED',
        'EVALUATION_FAILED',
      ],
    },
  },
  {
    timestamps: true,
  }
);

AnswerSchema.index({ attemptId: 1, questionId: 1 }, { unique: true });

export default mongoose.model('Answer', AnswerSchema);
