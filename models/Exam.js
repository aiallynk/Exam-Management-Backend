import mongoose from 'mongoose';

const ExamSchema = new mongoose.Schema(
  {
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
    // Multi-tenant fields
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    instituteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institute',
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
  },
  {
    timestamps: true,
  }
);

// Multi-tenant indexes
ExamSchema.index({ organizationId: 1, instituteId: 1, createdAt: -1 });
ExamSchema.index({ createdBy: 1, createdAt: -1 });
ExamSchema.index({ organizationId: 1, isActive: 1 });
ExamSchema.index({ instituteId: 1, isActive: 1 });

export default mongoose.model('Exam', ExamSchema);

