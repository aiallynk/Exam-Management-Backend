import mongoose from 'mongoose';

const ExamAttemptSchema = new mongoose.Schema(
  {
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamSession',
      required: true,
      index: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    startTime: {
      type: Date,
      required: true,
      default: Date.now,
    },
    submitTime: {
      type: Date,
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    isDisqualified: {
      type: Boolean,
      default: false,
    },
    disqualifyReason: {
      type: String,
      trim: true,
    },
    examSnapshot: {
      title: { type: String, trim: true },
      description: { type: String, trim: true },
    },
    tabSwitchCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    scoreSummary: {
      totalScore: {
        type: Number,
        default: 0,
        min: 0,
      },
      maxScore: {
        type: Number,
        default: 0,
        min: 0,
      },
      percentage: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      computedAt: {
        type: Date,
      },
    },
  },
  {
    timestamps: true,
  }
);

ExamAttemptSchema.index({ userId: 1, createdAt: -1 });
ExamAttemptSchema.index({ sessionId: 1, userId: 1 });

export default mongoose.model('ExamAttempt', ExamAttemptSchema);

