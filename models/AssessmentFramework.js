import mongoose from 'mongoose';

const AssessmentFrameworkSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  description: { type: String, default: '' },
  scope: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });
AssessmentFrameworkSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export default mongoose.model('AssessmentFramework', AssessmentFrameworkSchema);
