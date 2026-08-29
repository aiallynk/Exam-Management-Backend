import mongoose from 'mongoose';

const FrameworkVersionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  frameworkId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentFramework', required: true, index: true },
  version: { type: String, required: true, trim: true },
  rules: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'RETIRED'], default: 'DRAFT', index: true },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });
FrameworkVersionSchema.index({ tenantId: 1, frameworkId: 1, version: 1 }, { unique: true });
FrameworkVersionSchema.pre('save', function immutablePublishedVersion(next) {
  if (!this.isNew && this.isModified('rules') && !this.isModified('status') && this.status === 'PUBLISHED') {
    return next(new Error('Published framework versions are immutable; create a new version.'));
  }
  return next();
});
export default mongoose.model('FrameworkVersion', FrameworkVersionSchema);
