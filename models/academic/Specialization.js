import mongoose from 'mongoose';

// Optional narrowing within a Program, e.g. B.Tech -> CSE / Mechanical / AI.
const SpecializationSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  programId: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

SpecializationSchema.index({ tenantId: 1, programId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
SpecializationSchema.index({ tenantId: 1, programId: 1, name: 1 });

export default mongoose.model('Specialization', SpecializationSchema);
