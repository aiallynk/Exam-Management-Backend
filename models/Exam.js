import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: true,
      index: true,
      immutable: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    duration: {
      type: Number,
      required: true,
      min: 1,
    },
    gracePeriod: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxAttempts: {
      type: Number,
      default: 1,
      min: 1,
    },
    showResultsImmediately: {
      type: Boolean,
      default: false,
    },
    resultsReleasedAt: {
      type: Date,
    },
    certificatesSentAt: {
      type: Date,
    },
    certificateTemplate: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    allowCertification: {
      type: Boolean,
      default: false,
    },
    passingPercentage: {
      type: Number,
      default: 60,
      min: 0,
      max: 100,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Multi-tenant fields - Exam belongs to EITHER organizationId OR instituteId
    // Organization and Institute are EQUAL LEVEL personas
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
      // Required if instituteId is not provided
    },
    instituteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institute',
      index: true,
      // Required if organizationId is not provided
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // AI generation metadata
    aiGenerated: {
      type: Boolean,
      default: false,
    },
    aiInputSource: {
      type: String,
      enum: ['TOPIC_ONLY', 'DETAILED_CONTENT'],
    },
    aiMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Validate: Exam must belong to EITHER organization OR institute
ExamSchema.pre('save', function (next) {
  const hasOrg = !!this.organizationId;
  const hasInst = !!this.instituteId;
  
  if (!hasOrg && !hasInst) {
    return next(new Error('Exam must belong to either an Organization or an Institute'));
  }
  
  if (hasOrg && hasInst) {
    return next(new Error('Exam cannot belong to both Organization and Institute. Choose one.'));
  }
  
  next();
});

// Generate uniqueId before saving
ExamSchema.pre('save', async function (next) {
  if (!this.uniqueId) {
    this.uniqueId = await generateUniqueIdWithCheck(
      mongoose.model('Exam'),
      ID_PREFIXES.EXAM
    );
  }
  next();
});

// Multi-tenant indexes
ExamSchema.index({ uniqueId: 1 });
ExamSchema.index({ organizationId: 1, createdAt: -1 });
ExamSchema.index({ instituteId: 1, createdAt: -1 });
ExamSchema.index({ createdBy: 1, createdAt: -1 });
ExamSchema.index({ organizationId: 1, isActive: 1 });
ExamSchema.index({ instituteId: 1, isActive: 1 });

export default mongoose.model('Exam', ExamSchema);

