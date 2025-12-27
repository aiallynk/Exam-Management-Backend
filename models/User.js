import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * User Model - 4-Role System
 * 
 * ROLES:
 * - SUPER_ADMIN: Full system access, can create tenants
 * - TENANT_ADMIN: Manages all data within their tenant (users, exams, sessions, etc.)
 * - EXAM_CREATOR: Can create exams and sessions within their tenant
 * - CANDIDATE: Can attempt exams within their tenant
 * 
 * TENANT:
 * - All users (except SUPER_ADMIN) must belong to a tenant
 * - Tenant represents exam hosting entity (School, College, Company, etc.)
 * - Users are assigned to tenants by SUPER_ADMIN
 */
const UserSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      index: true,
      sparse: true, // Allow null values temporarily
      immutable: true,
    },
    email: {
      type: String,
      unique: true,
      required: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      // Role system: SUPER_ADMIN, TENANT_ADMIN, EXAM_CREATOR, CANDIDATE
      enum: ['SUPER_ADMIN', 'TENANT_ADMIN', 'EXAM_CREATOR', 'CANDIDATE'],
      default: 'CANDIDATE',
      required: true,
      index: true,
    },
    // Tenant field - User belongs to a tenant (except SUPER_ADMIN)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      index: true,
      // Not schema-level required - validated in pre-save hook
    },
    mobile: {
      type: String,
      trim: true,
    },
    // Status management
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED'],
      default: 'ACTIVE',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
UserSchema.index({ uniqueId: 1 });
UserSchema.index({ tenantId: 1, role: 1 });
UserSchema.index({ status: 1 });

// Generate uniqueId before validation (only for new documents or existing ones without uniqueId)
UserSchema.pre('validate', async function (next) {
  // Generate uniqueId for new documents or existing documents that don't have one yet
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('User'),
        ID_PREFIXES.USER
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Validate: User must belong to a tenant (except SUPER_ADMIN)
// Allow users to be created without tenant initially (they can be assigned later)
UserSchema.pre('save', function (next) {
  if (this.role === 'SUPER_ADMIN') {
    // SUPER_ADMIN doesn't need a tenant
    return next();
  }
  
  // TENANT_ADMIN must have a tenantId
  if (this.role === 'TENANT_ADMIN' && !this.tenantId) {
    return next(new Error('TENANT_ADMIN must be assigned to a tenant'));
  }
  
  // Non-SUPER_ADMIN users should have a tenant, but allow null initially for assignment
  // This allows Super Admin to create users and assign tenants later
  
  next();
});

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
UserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

export default mongoose.model('User', UserSchema);

