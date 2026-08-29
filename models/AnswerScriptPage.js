import mongoose from 'mongoose';

// One physical page of a scanned answer script. The page IMAGE lives in S3
// (services/storage/imageStorage.js, category 'answer-scripts') — never
// stored as a binary in MongoDB (Part C's explicit requirement).
const AnswerScriptPageSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  answerScriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScript', required: true, index: true },
  pageNumber: { type: Number, required: true, min: 1 },

  image: {
    key: { type: String, default: null },
    url: { type: String, default: null },
  },

  status: { type: String, enum: ['PENDING', 'PROCESSED', 'FAILED'], default: 'PENDING' },
  // Part F — never let a POOR/UNREADABLE page silently pass as valid AI
  // input; the ingestion service routes these to NEEDS_REVIEW instead of
  // OCR.
  qualityStatus: { type: String, enum: ['GOOD', 'ACCEPTABLE', 'POOR', 'UNREADABLE', null], default: null },
  qualityMeta: {
    isLikelyBlank: { type: Boolean, default: false },
    widthPx: { type: Number, default: null },
    heightPx: { type: Number, default: null },
    estimatedDpi: { type: Number, default: null },
    rotationDetectedDegrees: { type: Number, default: 0 },
  },

  ocrText: { type: String, default: '' }, // full-page raw extraction, before segmentation
  extractionConfidence: { type: Number, default: null, min: 0, max: 1 },
  visionMeta: {
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    aiUsageEventId: { type: mongoose.Schema.Types.ObjectId, default: null }, // links to AITokenUsage
  },
  processingError: { type: String, default: '' },
}, { timestamps: true, minimize: false });

AnswerScriptPageSchema.index({ tenantId: 1, answerScriptId: 1, pageNumber: 1 }, { unique: true });

export default mongoose.model('AnswerScriptPage', AnswerScriptPageSchema);
