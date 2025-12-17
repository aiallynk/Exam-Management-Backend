import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * Organization Model
 * Represents an organization (equal level with Institute)
 * Managed by Super Admin
 */
const OrganizationSchema = new mongoose.Schema(
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
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
      match: [/^[A-Z0-9_-]+$/, 'Code must contain only uppercase letters, numbers, hyphens, and underscores'],
    },
    contactEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
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
OrganizationSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Organization'),
        ID_PREFIXES.ORGANIZATION
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Indexes for efficient queries
OrganizationSchema.index({ uniqueId: 1 });
OrganizationSchema.index({ code: 1 });
OrganizationSchema.index({ status: 1, createdAt: -1 });
OrganizationSchema.index({ createdBy: 1 });

export default mongoose.model('Organization', OrganizationSchema);
