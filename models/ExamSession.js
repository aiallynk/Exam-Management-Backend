import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamSessionSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
      immutable: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
    },
    questionPaperIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'QuestionPaper',
        },
      ],
      default: [],
    },
    qrCode: {
      type: String,
      unique: true,
      required: true,
    },
    qrImage: {
      type: String,
    },
    manualToken: {
      type: String,
      unique: true,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    startTime: {
      type: Date,
      required: true,
    },
    endTime: {
      type: Date,
      required: true,
      validate: {
        validator: function (value) {
          return value > this.startTime;
        },
        message: 'End time must be after start time',
      },
    },
    // Tenant field (inherited from exam, but stored for performance)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
    },
    // Assign all candidates by default; false means specific candidates list
    assignAllCandidates: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    distributionMode: {
      type: String,
      enum: ['single', 'random', 'sequential', 'roll', 'manual'],
      default: 'single',
    },
    distributionState: {
      lastAssignedIndex: {
        type: Number,
        default: -1,
      },
      lastAssignedPaper: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QuestionPaper',
      },
    },
    normalizationApplied: {
      type: Boolean,
      default: false,
    },
    normalizationLockedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
ExamSessionSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('ExamSession'),
        ID_PREFIXES.SESSION
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Validate: Session tenantId will be inherited from exam
// Allow null initially - will be populated from exam
ExamSessionSchema.pre('save', function (next) {
  // tenantId can be null initially - will be set from exam
  next();
});

// Single field indexes
ExamSessionSchema.index({ tenantId: 1 });

// Compound indexes for common query patterns
// For exam sessions: { examId, createdAt }
ExamSessionSchema.index({ examId: 1, createdAt: -1 });

// For active sessions query: { isActive, startTime, endTime }
ExamSessionSchema.index({ isActive: 1, startTime: 1, endTime: 1 });

// For tenant-scoped active sessions: { tenantId, isActive }
ExamSessionSchema.index({ tenantId: 1, isActive: 1 });

// For time-based queries: { startTime, endTime }
ExamSessionSchema.index({ startTime: 1, endTime: 1 });

const ExamSession = mongoose.model('ExamSession', ExamSessionSchema);

export default ExamSession;

