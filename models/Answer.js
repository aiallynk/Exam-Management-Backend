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
    needsReview: {
      type: Boolean,
      default: false,
    },
    timeSpent: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

AnswerSchema.index({ attemptId: 1, questionId: 1 }, { unique: true });

export default mongoose.model('Answer', AnswerSchema);

