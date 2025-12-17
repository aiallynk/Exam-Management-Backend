import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamSessionSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: true,
      index: true,
      immutable: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
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
      index: true,
    },
    qrImage: {
      type: String,
    },
    manualToken: {
      type: String,
      unique: true,
      required: true,
      index: true,
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
    // Multi-tenant fields (inherited from exam, but stored for performance)
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
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before saving
ExamSessionSchema.pre('save', async function (next) {
  if (!this.uniqueId) {
    this.uniqueId = await generateUniqueIdWithCheck(
      mongoose.model('ExamSession'),
      ID_PREFIXES.SESSION
    );
  }
  next();
});

// Validate: Session must belong to EITHER organization OR institute (same as exam)
ExamSessionSchema.pre('save', function (next) {
  const hasOrg = !!this.organizationId;
  const hasInst = !!this.instituteId;
  
  // Both can be null initially (will be set from exam)
  if (!hasOrg && !hasInst) {
    // Allow null initially - will be populated from exam
    return next();
  }
  
  if (hasOrg && hasInst) {
    return next(new Error('Session cannot belong to both Organization and Institute. Choose one.'));
  }
  
  next();
});

ExamSessionSchema.index({ uniqueId: 1 });
ExamSessionSchema.index({ examId: 1, createdAt: -1 });
ExamSessionSchema.index({ isActive: 1, startTime: 1, endTime: 1 });
ExamSessionSchema.index({ organizationId: 1 });
ExamSessionSchema.index({ instituteId: 1 });
ExamSessionSchema.index({ instituteId: 1, isActive: 1 });

const ExamSession = mongoose.model('ExamSession', ExamSessionSchema);

export default ExamSession;

