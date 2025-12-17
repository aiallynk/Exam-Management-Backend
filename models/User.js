import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

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
      required: function () {
        return this.role !== 'ADMIN' || this.password;
      },
    },
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'TEACHER', 'STUDENT', 'ADMIN', 'DESIGNER'], // Include legacy roles for backward compatibility
      default: 'STUDENT',
      required: true,
      index: true,
    },
    // Multi-tenant fields - Organization and Institute are EQUAL LEVEL
    // User belongs to EITHER organizationId OR instituteId (not both)
    // Validation is enforced in pre-save hook, not schema-level required
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
      // Not schema-level required - validated in pre-save hook
    },
    instituteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institute',
      index: true,
      // Not schema-level required - validated in pre-save hook
    },
    // Validation: User must belong to either organization OR institute (except SUPER_ADMIN)
    // This is enforced in pre-save hook
    mobile: {
      type: String,
      trim: true,
    },
    college: {
      type: String,
      trim: true,
    },
    degree: {
      type: String,
      trim: true,
    },
    branch: {
      type: String,
      trim: true,
    },
    hometown: {
      type: String,
      trim: true,
    },
    canViewResults: {
      type: Boolean,
      default: false,
    },
    // Status management
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED'],
      default: 'ACTIVE',
      index: true,
    },
    // Legacy support: Keep DESIGNER and ADMIN for backward compatibility
    // DESIGNER maps to TEACHER, ADMIN maps to INSTITUTE_ADMIN
    legacyRole: {
      type: String,
      enum: ['DESIGNER', 'ADMIN'],
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient multi-tenant queries
UserSchema.index({ uniqueId: 1 });
UserSchema.index({ organizationId: 1, role: 1 });
UserSchema.index({ instituteId: 1, role: 1 });
UserSchema.index({ status: 1 });

// Map legacy roles to new roles before validation
UserSchema.pre('validate', function (next) {
  // Map legacy roles to new roles for backward compatibility
  const roleMapping = {
    'ADMIN': 'INSTITUTE_ADMIN',
    'DESIGNER': 'TEACHER',
  };
  
  if (roleMapping[this.role]) {
    // Store original role in legacyRole field for reference before mapping
    if (!this.legacyRole && (this.role === 'ADMIN' || this.role === 'DESIGNER')) {
      this.legacyRole = this.role;
    }
    this.role = roleMapping[this.role];
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

// Validate: User must belong to EITHER organization OR institute (except SUPER_ADMIN)
// Allow users to be created without tenant initially (they can be assigned later)
UserSchema.pre('save', function (next) {
  if (this.role === 'SUPER_ADMIN') {
    // SUPER_ADMIN doesn't need organization or institute
    return next();
  }
  
  // User must belong to EITHER organization OR institute (not both)
  // Allow neither initially (for users being created without tenant assignment)
  const hasOrg = !!this.organizationId;
  const hasInst = !!this.instituteId;
  
  // Allow users without tenant initially (they'll be assigned later)
  // Only validate mutual exclusivity if both are set
  if (hasOrg && hasInst) {
    return next(new Error('User cannot belong to both Organization and Institute. Choose one.'));
  }
  
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

