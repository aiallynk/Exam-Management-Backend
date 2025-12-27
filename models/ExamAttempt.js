import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamAttemptSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      index: true,
      sparse: true,
      immutable: true,
    },
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
    // Tenant field (inherited from exam, but stored for performance)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
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

// Generate uniqueId before validation
ExamAttemptSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('ExamAttempt'),
        ID_PREFIXES.ATTEMPT
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Validate: Attempt tenantId will be inherited from exam
// Allow null initially - will be populated from exam
ExamAttemptSchema.pre('save', function (next) {
  // tenantId can be null initially - will be set from exam
  next();
});

// Single field indexes
ExamAttemptSchema.index({ uniqueId: 1 });
ExamAttemptSchema.index({ userId: 1, createdAt: -1 });
ExamAttemptSchema.index({ tenantId: 1 });

// Compound indexes for common query patterns
// For checking max attempts: { userId, examId, isCompleted }
ExamAttemptSchema.index({ userId: 1, examId: 1, isCompleted: 1 });

// For finding active attempts: { userId, sessionId, isCompleted }
ExamAttemptSchema.index({ userId: 1, sessionId: 1, isCompleted: 1 });

// For tenant-scoped queries: { tenantId, createdAt }
ExamAttemptSchema.index({ tenantId: 1, createdAt: -1 });
ExamAttemptSchema.index({ tenantId: 1, userId: 1 });

// For results queries: { examId, isCompleted, isDisqualified }
ExamAttemptSchema.index({ examId: 1, isCompleted: 1, isDisqualified: 1 });

// For session queries: { sessionId, isCompleted }
ExamAttemptSchema.index({ sessionId: 1, isCompleted: 1 });

export default mongoose.model('ExamAttempt', ExamAttemptSchema);

