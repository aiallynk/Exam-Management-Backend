import mongoose from 'mongoose';

const KnowledgeIngestionBatchSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    resourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LibraryResource' }],
    sourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ContextSource' }],
    total: { type: Number, default: 0 },
    queued: { type: Number, default: 0 },
    processing: { type: Number, default: 0 },
    ready: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    storedOnly: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED'],
      default: 'QUEUED',
      index: true,
    },
    priority: { type: String, enum: ['FAST', 'ECONOMY'], default: 'FAST' },
  },
  { timestamps: true }
);

KnowledgeIngestionBatchSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model('KnowledgeIngestionBatch', KnowledgeIngestionBatchSchema);
