import mongoose from 'mongoose';

// Source-Grounded AI Question Generation — one uploaded file or ingested
// URL. A URL source's point-in-time capture ("snapshot") is folded
// directly into this document rather than a separate SourceSnapshot
// collection: v1 only ever holds one live snapshot per source, so a join
// would buy nothing (mirrors how Exam.aiMetadata / WizKidsExamConfig are
// 1:1 side-fields, not many-to-one relations, elsewhere in this codebase).
// Generation only ever reads the stored/extracted text via ContextChunk —
// never re-fetches a URL live — so a saved exam's grounding is stable even
// if the source page later changes.
const ContextSourceSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    contextSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ContextSet',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sourceType: {
      type: String,
      enum: ['FILE', 'URL'],
      required: true,
    },
    // --- FILE fields ---
    originalFilename: {
      type: String,
      trim: true,
      default: '',
    },
    fileExtension: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    fileSizeBytes: {
      type: Number,
      default: 0,
      min: 0,
    },
    // --- URL fields (snapshot captured at ingestion time) ---
    sourceUrl: {
      type: String,
      trim: true,
      default: '',
    },
    // The IP address actually fetched, recorded for audit even though the
    // SSRF check already happened before this was persisted.
    resolvedIp: {
      type: String,
      trim: true,
      default: '',
    },
    fetchedAt: {
      type: Date,
      default: null,
    },
    httpStatus: {
      type: Number,
      default: null,
    },
    contentType: {
      type: String,
      trim: true,
      default: '',
    },
    // sha256 of the sanitized extracted text — used for the partial-unique
    // guard below and as a debugging/audit fingerprint, never used as a
    // security control on its own.
    snapshotHash: {
      type: String,
      trim: true,
      default: '',
    },
    // --- shared ---
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'READY', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    failureReason: {
      type: String,
      trim: true,
      default: '',
    },
    // Structured taxonomy code alongside the human-readable failureReason
    // above (master prompt §10/§30) — lets the UI branch on a stable
    // value (e.g. show Drive-specific sharing guidance) instead of
    // pattern-matching free text.
    errorCode: {
      type: String,
      trim: true,
      default: '',
    },
    // 'WEB' for an ordinary fetched page, 'GOOGLE_DRIVE' when the URL was
    // recognized and routed through the Drive-aware provider. Unset for
    // FILE sources.
    sourceProvider: {
      type: String,
      trim: true,
      default: '',
    },
    // Safe diagnostics only (master prompt §10) — never the raw
    // extracted text itself.
    extractionMethod: {
      type: String,
      trim: true,
      default: '',
    },
    extractedCharCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    chunkCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

ContextSourceSchema.index({ tenantId: 1, contextSetId: 1 });
ContextSourceSchema.index({ tenantId: 1, status: 1 });
// Guards against adding identical content twice within the same set
// (soft-signal only; empty/missing hashes and different sets are exempt).
ContextSourceSchema.index(
  { contextSetId: 1, snapshotHash: 1 },
  {
    unique: true,
    partialFilterExpression: { snapshotHash: { $type: 'string', $ne: '' } },
  }
);

export default mongoose.model('ContextSource', ContextSourceSchema);
