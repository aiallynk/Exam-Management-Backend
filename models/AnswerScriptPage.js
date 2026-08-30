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
    // 'application/pdf' when the page was prepared Python-free (a single-page
    // PDF handed straight to the Gemini vision model); an image/* type when a
    // rasterizer produced a JPEG/PNG. Null on legacy rows (treated as JPEG).
    mimeType: { type: String, default: null },
  },
  workingImage: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    widthPx: { type: Number, default: null },
    heightPx: { type: Number, default: null },
    dpi: { type: Number, default: null },
    colorMode: { type: String, enum: ['GRAYSCALE', 'COLOR', null], default: null },
    mimeType: { type: String, default: null },
  },
  previewImage: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    widthPx: { type: Number, default: null },
    heightPx: { type: Number, default: null },
  },
  thumbnailImage: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    widthPx: { type: Number, default: null },
    heightPx: { type: Number, default: null },
  },
  identityHeaderImage: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    mimeType: { type: String, default: null },
  },
  contentHash: { type: String, default: null, index: true },
  normalizedCrop: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    width: { type: Number, default: 1 },
    height: { type: Number, default: 1 },
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
    deskewDegrees: { type: Number, default: 0 },
    colorRelevant: { type: Boolean, default: false },
  },

  ocrText: { type: String, default: '' }, // full-page raw extraction, before segmentation
  extractionSegments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  extractionCheckpoint: {
    inputHash: { type: String, default: null },
    completedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  },
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
