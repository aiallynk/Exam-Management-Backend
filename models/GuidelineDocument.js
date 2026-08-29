import mongoose from 'mongoose';

const GuidelineDocumentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    inputType: { type: String, enum: ['UPLOAD', 'PASTE', 'DESCRIPTION'], required: true },
    status: {
      type: String,
      enum: [
        'UPLOADING',
        'EXTRACTING',
        'INTERPRETING',
        'VALIDATING',
        'READY_FOR_REVIEW',
        'DRAFT_SAVED',
        'FAILED',
      ],
      default: 'UPLOADING',
      index: true,
    },
    title: { type: String, trim: true, default: '' },
    rawText: { type: String, default: '' },
    originalObject: {
      key: { type: String, default: '' },
      mimeType: { type: String, default: '' },
      sizeBytes: { type: Number, default: 0 },
    },
    extractedText: { type: String, default: '' },
    detectedMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    proposal: { type: mongoose.Schema.Types.Mixed, default: null },
    proposalConfidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    sourceEvidence: { type: [mongoose.Schema.Types.Mixed], default: [] },
    aiOperationMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    frameworkId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentFramework', default: null },
    frameworkVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FrameworkVersion', default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    failureReason: { type: String, default: '' },
    jobId: { type: String, default: '' },
  },
  { timestamps: true }
);

GuidelineDocumentSchema.index({ tenantId: 1, createdBy: 1 });
GuidelineDocumentSchema.index({ tenantId: 1, status: 1 });

export default mongoose.model('GuidelineDocument', GuidelineDocumentSchema);
