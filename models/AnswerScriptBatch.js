import mongoose from 'mongoose';

const AnswerScriptBatchSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  questionPaperId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionPaper', required: true },
  courseOfferingId: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseOffering', default: null },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  totalFiles: { type: Number, default: 0 },
  uploadingCount: { type: Number, default: 0 },
  queuedCount: { type: Number, default: 0 },
  processingCount: { type: Number, default: 0 },
  needsMappingCount: { type: Number, default: 0 },
  needsReviewCount: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  duplicateCount: { type: Number, default: 0 },
  cancelledCount: { type: Number, default: 0 },
  clientUploadConcurrency: { type: Number, default: 4 },
  status: {
    type: String,
    enum: ['UPLOADING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'],
    default: 'QUEUED',
    index: true,
  },
  completedAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: Date.now },
}, { timestamps: true });

AnswerScriptBatchSchema.index({ tenantId: 1, examId: 1, createdAt: -1 });

export default mongoose.model('AnswerScriptBatch', AnswerScriptBatchSchema);
