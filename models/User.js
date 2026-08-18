import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * User Model - Multi-Role System
 *
 * ROLES:
 * - SUPER_ADMIN: Full system access, can create tenants
 * - TENANT_ADMIN: Manages all data within their tenant (users, exams, sessions, etc.)
 * - EXAM_CREATOR: Can create exams and sessions within their tenant
 * - CANDIDATE: Can attempt exams within their tenant
 * - EVALUATOR: Can review/score exam responses they are explicitly assigned to
 *
 * `role` is the legacy primary role and stays authoritative for anything that
 * only understands a single role (self-signup, older call sites). `roles` is
 * the authoritative collection going forward — a user may hold more than one,
 * e.g. an EXAM_CREATOR who is additionally an EVALUATOR keeps
 * role='EXAM_CREATOR', roles=['EXAM_CREATOR','EVALUATOR']. Never read
 * `user.role` alone to decide EVALUATOR access; use the helpers in
 * utils/userRoles.js (normalizeRoles/hasRole/hasAnyRole), which fall back to
 * `[role]` for any document that predates this field.
 *
 * TENANT:
 * - All users (except SUPER_ADMIN) must belong to a tenant
 * - Tenant represents exam hosting entity (School, College, Company, etc.)
 * - Users are assigned to tenants by SUPER_ADMIN
 */
const ROLE_VALUES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'EXAM_CREATOR', 'CANDIDATE', 'EVALUATOR'];
const UserSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
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
      enum: ROLE_VALUES,
      default: 'CANDIDATE',
      required: true,
    },
    // Authoritative multi-role collection. Kept in sync with `role` (the
    // primary role always stays a member) by the pre-save hook below and by
    // services/userRoleService.js's addRole/removeRole. Do not write to this
    // directly from routes — go through that service so `role` and `roles`
    // can never disagree about the primary role's membership.
    roles: {
      type: [{ type: String, enum: ROLE_VALUES }],
      default: undefined,
    },
    // Tenant field - User belongs to a tenant (except SUPER_ADMIN)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      // Not schema-level required - validated in pre-save hook
    },
    subTenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubTenant',
      default: null,
    },
    mobile: {
      type: String,
      trim: true,
    },
    academicProfile: {
      gradeLevel: { type: Number, min: 1, max: 7, default: null },
      className: { type: String, trim: true, maxlength: 80, default: '' },
      division: { type: String, trim: true, maxlength: 40, default: '' },
      rollNumber: { type: String, trim: true, maxlength: 80, default: '' },
    },
    // Status management
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED'],
      default: 'ACTIVE',
    },
    planType: {
      type: String,
      enum: ['free', 'free_trial', 'demo', 'pro', 'ultimate', 'legend', 'business', 'enterprise'],
      default: 'free',
      lowercase: true,
      trim: true,
    },
    // Tenant-scoped evaluator capability. This is deliberately metadata, not
    // a new global RBAC role: a user can remain a candidate/creator while
    // receiving a time-bounded evaluator preset and exam assignments.
    evaluatorAccess: {
      enabled: { type: Boolean, default: false },
      accessExpiresAt: { type: Date, default: null },
      assignedAt: { type: Date, default: null },
      assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      removedAt: { type: Date, default: null },
      removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    examsCreated: {
      type: Number,
      default: 0,
      min: 0,
    },
    resetToken: {
      type: String,
      default: null,
      index: true,
    },
    resetTokenExpiry: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
UserSchema.index({ tenantId: 1, role: 1 });
UserSchema.index({ tenantId: 1, subTenantId: 1, role: 1 });
UserSchema.index({ status: 1 });
UserSchema.index({ planType: 1 });
UserSchema.index({ tenantId: 1, roles: 1 });
UserSchema.index({ tenantId: 1, role: 1, 'academicProfile.gradeLevel': 1 });

// Keep `roles` populated and guaranteed to contain the primary `role`.
// Documents saved before this field existed have no `roles` at all — this
// backfills them in place, additively, the first time they're loaded and
// re-saved; it never removes a role a caller already added.
UserSchema.pre('save', function (next) {
  const current = Array.isArray(this.roles) ? this.roles.filter(Boolean) : [];
  const merged = new Set(current.length ? current : [this.role]);
  merged.add(this.role);
  const resolved = Array.from(merged);
  if (resolved.length !== current.length || resolved.some((r) => !current.includes(r))) {
    this.roles = resolved;
  }
  next();
});

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
    const planType = String(this.planType || '').toLowerCase();
    const allowSelfSignup = ['free', 'free_trial', 'demo'].includes(planType);
    if (!allowSelfSignup) {
      return next(new Error('TENANT_ADMIN must be assigned to a tenant'));
    }
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
  delete obj.resetToken;
  delete obj.resetTokenExpiry;
  return obj;
};

export default mongoose.model('User', UserSchema);
