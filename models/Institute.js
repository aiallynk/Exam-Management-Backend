import mongoose from 'mongoose';

/**
 * Institute Model
 * Represents an institute that belongs to ONE organization
 * Managed by Organization Admin or Super Admin
 */
const InstituteSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    contactEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    contactPhone: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
      index: true,
    },
    // Limits and quotas
    examLimit: {
      type: Number,
      default: null, // null = unlimited
    },
    aiUsageLimit: {
      type: Number,
      default: null, // null = unlimited
    },
    currentAiUsage: {
      type: Number,
      default: 0,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index: organizationId + code must be unique
InstituteSchema.index({ organizationId: 1, code: 1 }, { unique: true });
InstituteSchema.index({ organizationId: 1, status: 1 });
InstituteSchema.index({ createdBy: 1 });

export default mongoose.model('Institute', InstituteSchema);
