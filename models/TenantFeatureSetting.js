import mongoose from 'mongoose';

// Additive tenant preference layered below the platform and subscription plan.
// Missing records intentionally mean "use the current plan behaviour".
const TenantFeatureSettingSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    featureKey: { type: String, required: true, trim: true, uppercase: true },
    requestedEnabled: { type: Boolean, required: true, default: true },
    // Set only by platform administration.  Tenant administrators can see the
    // effective value but cannot overwrite an enforced platform decision.
    superAdminEnforced: { type: Boolean, required: true, default: false },
    enforcedEnabled: { type: Boolean, required: true, default: true },
    effectiveEnabled: { type: Boolean, required: true, default: false },
    planEntitled: { type: Boolean, required: true, default: false },
    disabledReason: { type: String, trim: true, default: '' },
    configuredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    configuredAt: { type: Date, required: true, default: Date.now },
    version: { type: Number, required: true, default: 1, min: 1 },
  },
  { timestamps: true }
);

TenantFeatureSettingSchema.index({ tenantId: 1, featureKey: 1 }, { unique: true });
TenantFeatureSettingSchema.index({ tenantId: 1, effectiveEnabled: 1 });

export default mongoose.model('TenantFeatureSetting', TenantFeatureSettingSchema);
