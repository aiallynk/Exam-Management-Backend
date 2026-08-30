import mongoose from 'mongoose';

// LEGACY_COMPATIBILITY — commercial/white-label partition (plan-gated multiTenant).
// NOT a branch/campus/location boundary; OrganizationUnit owns operational locations.
// See utils/subTenantLegacy.js for classification and sunset path.
const SubTenantSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
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

SubTenantSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
SubTenantSchema.index({ tenantId: 1, name: 1 });
SubTenantSchema.index({ tenantId: 1, code: 1 }, { unique: true });

export default mongoose.model('SubTenant', SubTenantSchema);

