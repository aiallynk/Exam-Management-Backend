import mongoose from 'mongoose';

const SubmissionSchema = new mongoose.Schema(
  {
    attemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamAttempt',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
    code: {
      type: String,
      required: true,
      default: '',
    },
    language: {
      type: String,
      required: true,
      trim: true,
    },
    isDraft: {
      type: Boolean,
      default: false,
      index: true,
    },
    draftSavedAt: {
      type: Date,
    },
    score: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    output: {
      type: String,
      default: '',
    },
    error: {
      type: String,
      default: '',
    },
    total: {
      type: Number,
      default: 0,
      min: 0,
    },
    passed: {
      type: Number,
      default: 0,
      min: 0,
    },
    failed: {
      type: Number,
      default: 0,
      min: 0,
    },
    timeTaken: {
      type: Number,
      default: 0,
      min: 0,
    },
    executionTimeMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    plagiarism: {
      flagged: {
        type: Boolean,
        default: false,
      },
      similarity: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      matchedSubmissionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Submission',
      },
      matchedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    },
  },
  {
    timestamps: true,
  }
);

SubmissionSchema.index({ attemptId: 1, questionId: 1 }, { unique: true });
SubmissionSchema.index({ examId: 1, questionId: 1, isDraft: 1 });

export default mongoose.model('Submission', SubmissionSchema);
