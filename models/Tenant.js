import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * Tenant Model - Unified Exam Hosting Entity
 * 
 * Replaces Organization and Institute models with a single, simple entity.
 * 
 * TENANT TYPES:
 * - SCHOOL: Educational institution (K-12)
 * - COLLEGE: Higher education institution
 * - COMPANY: Corporate entity
 * - INSTITUTE: Training/research institute
 * - GOVERNMENT: Government organization
 * - OTHER: Other types
 * 
 * SIMPLE FLOW:
 * 1. SUPER_ADMIN creates tenant
 * 2. SUPER_ADMIN assigns users to tenant
 * 3. EXAM_CREATOR creates exams for their tenant
 * 4. CANDIDATE attempts exams within their tenant
 */
const TenantSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
      immutable: true,
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
      match: [/^[A-Z0-9_-]+$/, 'Code must contain only uppercase letters, numbers, hyphens, and underscores'],
    },
    type: {
      type: String,
      enum: ['SCHOOL', 'COLLEGE', 'COMPANY', 'INSTITUTE', 'GOVERNMENT', 'OTHER'],
      required: true,
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
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
TenantSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Tenant'),
        ID_PREFIXES.TENANT
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Indexes for efficient queries
TenantSchema.index({ uniqueId: 1 });
TenantSchema.index({ code: 1 });
TenantSchema.index({ type: 1, status: 1 });
TenantSchema.index({ status: 1, createdAt: -1 });
TenantSchema.index({ createdBy: 1 });

export default mongoose.model('Tenant', TenantSchema);
