import mongoose from 'mongoose';

// Source-Grounded AI Question Generation — one uploaded file or ingested
// URL. A URL source's point-in-time capture ("snapshot") is folded
// directly into this document rather than a separate SourceSnapshot
// collection: v1 only ever holds one live snapshot per source, so a join
// would buy nothing (mirrors how Exam.aiMetadata is
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
    // Optional: a per-exam-generation-session upload (existing Source-
    // Grounded AI flow) always sets this. A persistent Content Library
    // upload (isLibraryItem below) never belongs to any one generation
    // session, so this stays null — retrieval (contextRetrievalService.js)
    // already queries by tenantId+sourceId only, never contextSetId, so a
    // library source works in generation the moment its id is selected.
    contextSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ContextSet',
      default: null,
      index: true,
    },
    // True only for a genuine Content Library upload (routes/contentLibrary.js).
    // False for the existing ad hoc "upload material for this assessment"
    // flow (routes/ai.js POST /context-sources) — that content stays
    // private to its uploader/session exactly as it always has; only a
    // library item participates in the broader course/shared visibility
    // rules below.
    isLibraryItem: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Optional parent LibraryResource (the educator-facing logical unit —
    // a textbook, a chapter, a past paper) this technical asset belongs to.
    // Null for the pre-existing ad hoc per-generation upload flow, and for
    // any library upload made before this field existed. Never required:
    // a bare ContextSource remains fully usable (list/select/generate) on
    // its own — LibraryResource only adds grouping/metadata on top.
    libraryResourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LibraryResource',
      default: null,
      index: true,
    },
    contentType: {
      type: String,
      enum: ['TEXTBOOK', 'CHAPTER', 'SYLLABUS', 'NOTES', 'WORKSHEET', 'PAST_PAPER', 'QUESTION_MATERIAL', 'REFERENCE_MATERIAL', 'OTHER'],
      default: 'OTHER',
    },
    // PRIVATE: creator only. COURSE: creator + anyone whose academic
    // visibility covers every non-empty academicScope field below (see
    // utils/contentScope.js). SHARED: same scope check, except an empty
    // academicScope is tenant-wide readable (Academic/Tenant Admin
    // publishing something with no narrowing, e.g. a generic template).
    visibility: {
      type: String,
      enum: ['PRIVATE', 'COURSE', 'SHARED'],
      default: 'PRIVATE',
    },
    // Every field optional — a whole textbook may be scoped to just a
    // program+course; a chapter may add more. Mixed (not a strict
    // sub-schema) mirrors Exam.academicContext's existing convention.
    academicScope: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    chapter: { type: String, trim: true, default: '' },
    unit: { type: String, trim: true, default: '' },
    topic: { type: String, trim: true, default: '' },
    // The private S3 pointer for a Content Library upload's original file.
    // Null for URL sources and for the existing ad hoc per-generation
    // upload flow, which has never retained original bytes (text-only,
    // pre-existing behavior, unchanged by this addition).
    originalObject: {
      key: { type: String, default: null },
      sizeBytes: { type: Number, default: 0 },
      mimeType: { type: String, default: '' },
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
    // The raw HTTP Content-Type response header for a fetched URL source
    // (e.g. "text/html; charset=utf-8"). Deliberately named differently
    // from the `contentType` field above (the educator-facing library
    // classification enum) — the two used to share one field name, which
    // silently dropped the enum constraint and let a URL ingestion
    // overwrite the user's chosen classification with this raw header.
    httpContentType: {
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
    // UNSUPPORTED_FOR_AI is additive (Content Library only, Part E): the
    // original file stored successfully in S3, but the current extractor
    // (services/questionImportImageService.js#parseQuestionImportFile)
    // does not support this file type — an honest "Stored / AI indexing
    // unavailable" state rather than a scary FAILED. The existing ad hoc
    // upload flow's multer fileFilter already blocks unsupported
    // extensions before reaching this point, so it never produces this
    // value — pre-existing FAILED behavior there is unchanged.
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'READY', 'FAILED', 'UNSUPPORTED_FOR_AI'],
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
ContextSourceSchema.index({ tenantId: 1, isLibraryItem: 1, visibility: 1 });
ContextSourceSchema.index({ tenantId: 1, isLibraryItem: 1, createdBy: 1 });
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
