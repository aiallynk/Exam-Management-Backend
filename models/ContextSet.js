import mongoose from 'mongoose';

// Source-Grounded AI Question Generation — a ContextSet is one exam
// creator's working collection of uploaded files / URLs assembled for a
// single generation session. Sources are added to it via ContextSource;
// chunked/embedded text lives in ContextChunk. Kept intentionally thin —
// selection state (`which sources are checked for this generation call`)
// lives on the client/request, not here, so a set can be reused across
// several generate-questions calls without a schema change.
const ContextSetSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Null until the exam draft is actually saved — a creator can upload
    // sources before an Exam document exists yet.
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      default: null,
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['DRAFT', 'READY', 'ARCHIVED'],
      default: 'DRAFT',
    },
    // Denormalized count, maintained by contextIngestionService — avoids a
    // COUNT query every time the source-selection UI refreshes.
    sourceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

ContextSetSchema.index({ tenantId: 1, createdBy: 1, createdAt: -1 });
ContextSetSchema.index({ tenantId: 1, examId: 1 });

export default mongoose.model('ContextSet', ContextSetSchema);
