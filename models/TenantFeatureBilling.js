import mongoose from 'mongoose';

const { Schema } = mongoose;

const TenantFeatureSelectionSchema = new Schema(
  {
    examCreation: { type: Boolean, default: true },
    analytics: { type: Boolean, default: true },
    proctoring: { type: Boolean, default: false },
  },
  { _id: false }
);

const TenantFeatureBillingSchema = new Schema(
  {
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      unique: true,
    },
    selectedFeatures: {
      type: TenantFeatureSelectionSchema,
      default: () => ({}),
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('TenantFeatureBilling', TenantFeatureBillingSchema);
