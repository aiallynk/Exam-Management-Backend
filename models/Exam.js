import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
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
    // Tenant field - Exam belongs to a tenant
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
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
    supportedLanguages: {
      type: [String],
      default: ['en'],
    },
    defaultLanguage: {
      type: String,
      default: 'en',
      trim: true,
    },
    allowMultiLanguage: {
      type: Boolean,
      default: false,
    },
    // Offline exam package fields
    offlinePackageVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    offlinePackageGeneratedAt: {
      type: Date,
    },
    offlinePackageEnabled: {
      type: Boolean,
      default: false,
    },
    questionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    candidateCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Validate: Exam must belong to a tenant
ExamSchema.pre('save', function (next) {
  if (!this.tenantId) {
    return next(new Error('Exam must belong to a tenant'));
  }
  
  next();
});

// Generate uniqueId before validation
ExamSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Exam'),
        ID_PREFIXES.EXAM
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Indexes
ExamSchema.index({ uniqueId: 1 });
ExamSchema.index({ tenantId: 1, createdAt: -1 });
ExamSchema.index({ createdBy: 1, createdAt: -1 });
ExamSchema.index({ tenantId: 1, isActive: 1 });

export default mongoose.model('Exam', ExamSchema);

