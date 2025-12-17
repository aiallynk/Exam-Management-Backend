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
    // Multi-tenant fields (inherited from exam, but stored for performance)
    // Attempt belongs to EITHER organizationId OR instituteId (same as exam)
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    instituteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institute',
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

// Validate: Attempt must belong to EITHER organization OR institute (same as exam)
ExamAttemptSchema.pre('save', function (next) {
  const hasOrg = !!this.organizationId;
  const hasInst = !!this.instituteId;
  
  // Both can be null initially (will be set from exam)
  if (!hasOrg && !hasInst) {
    // Allow null initially - will be populated from exam
    return next();
  }
  
  if (hasOrg && hasInst) {
    return next(new Error('Attempt cannot belong to both Organization and Institute. Choose one.'));
  }
  
  next();
});

ExamAttemptSchema.index({ uniqueId: 1 });
ExamAttemptSchema.index({ userId: 1, createdAt: -1 });
ExamAttemptSchema.index({ sessionId: 1, userId: 1 });
ExamAttemptSchema.index({ organizationId: 1 });
ExamAttemptSchema.index({ instituteId: 1 });
ExamAttemptSchema.index({ instituteId: 1, userId: 1 });

export default mongoose.model('ExamAttempt', ExamAttemptSchema);

