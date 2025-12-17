import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const UserSchema = new mongoose.Schema(
  {
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
      enum: ['SUPER_ADMIN', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'TEACHER', 'STUDENT'],
      default: 'STUDENT',
      required: true,
      index: true,
    },
    // Multi-tenant fields
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
      // Required for all roles except SUPER_ADMIN
      required: function() {
        return this.role !== 'SUPER_ADMIN';
      },
    },
    instituteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institute',
      index: true,
      // Required for INSTITUTE_ADMIN, TEACHER, STUDENT
      required: function() {
        return ['INSTITUTE_ADMIN', 'TEACHER', 'STUDENT'].includes(this.role);
      },
    },
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

// Compound indexes for efficient multi-tenant queries
UserSchema.index({ organizationId: 1, role: 1 });
UserSchema.index({ instituteId: 1, role: 1 });
UserSchema.index({ organizationId: 1, instituteId: 1, status: 1 });

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

