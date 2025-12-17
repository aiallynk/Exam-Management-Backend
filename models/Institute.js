import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * Institute Model
 * Represents an institute (equal level with Organization)
 * Managed by Super Admin
 * NOTE: Organization and Institute are at EQUAL LEVEL - not hierarchical
 */
const InstituteSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      index: true,
      sparse: true,
      immutable: true, // Cannot be changed once set
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      unique: true, // Unique across all institutes (not per organization)
      trim: true,
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

// Generate uniqueId before validation
InstituteSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Institute'),
        ID_PREFIXES.INSTITUTE
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Indexes for efficient queries
InstituteSchema.index({ uniqueId: 1 });
InstituteSchema.index({ code: 1 });
InstituteSchema.index({ status: 1, createdAt: -1 });
InstituteSchema.index({ createdBy: 1 });

export default mongoose.model('Institute', InstituteSchema);
