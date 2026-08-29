import mongoose from 'mongoose';

const RubricTemplateSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  name: { type: String, required: true, trim: true },
  version: { type: String, default: '1.0' },
  applicability: { type: mongoose.Schema.Types.Mixed, default: {} },
  criteria: [{ key: { type: String, required: true }, label: { type: String, required: true }, maxMarks: { type: Number, required: true, min: 0 }, descriptors: { type: mongoose.Schema.Types.Mixed, default: {} } }],
  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'], default: 'DRAFT' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });
RubricTemplateSchema.index({ tenantId: 1, name: 1, version: 1 }, { unique: true });
export default mongoose.model('RubricTemplate', RubricTemplateSchema);
