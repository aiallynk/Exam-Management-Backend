import mongoose from 'mongoose';

// One candidate's complete scanned answer booklet — Master Phase 4. See
// docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md. The original file
// itself lives in S3 (services/storage/imageStorage.js); only its
// reference/checksum is stored here, matching the existing convention for
// question images.
const AnswerScriptSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  questionPaperId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionPaper', required: true },
  // Unknown until mapped — a freshly uploaded script is anonymous.
  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment', default: null },
  courseOfferingId: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseOffering', default: null },
  examSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamSession', default: null },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScriptBatch', default: null, index: true },
  mappingTokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScriptMappingToken', default: null },

  // Compatibility alias for Phase-4 callers. New scalable intake writes the
  // same immutable object to originalObject and mirrors it here only after
  // upload finalization; an UPLOADING record therefore has no key yet.
  sourceFile: {
    key: { type: String, default: null },
    url: { type: String, default: '' },
    checksum: { type: String, default: null, index: true }, // sha256 — duplicate-upload detection (Part W)
    sizeBytes: { type: Number, default: 0 },
  },
  originalObject: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    mimeType: { type: String, default: '' },
    etag: { type: String, default: '' },
    storageClass: { type: String, default: 'STANDARD' },
    uploadedAt: { type: Date, default: null },
  },
  normalizedObject: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    mimeType: { type: String, default: 'application/pdf' },
    generatedAt: { type: Date, default: null },
    profile: { type: String, default: '' },
  },
  uploadSession: {
    mode: { type: String, enum: ['SINGLE', 'MULTIPART', null], default: null },
    objectKey: { type: String, default: null },
    uploadId: { type: String, default: null },
    expectedChecksum: { type: String, default: null },
    expectedSizeBytes: { type: Number, default: 0 },
    partSizeBytes: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
  },
  originalFileName: { type: String, trim: true, maxlength: 255 },
  mimeType: { type: String, trim: true },
  pageCount: { type: Number, default: 0 },

  status: {
    type: String,
    enum: [
      'UPLOADING', 'UPLOADED', 'QUEUED', 'NORMALIZING', 'IDENTIFYING_CANDIDATE',
      'NEEDS_MAPPING', 'CANDIDATE_LOCKED', 'SEGMENTING', 'EXTRACTING', 'EVALUATING',
      'NEEDS_REVIEW', 'REVIEWING', 'FINALIZING', 'COMPLETED',
      'POSSIBLE_DUPLICATE', 'FAILED', 'STALE', 'CANCELLED', 'DERIVATIVE_FAILED',
      // Backward-compatible Phase-4 values retained for existing documents.
      'PROCESSING', 'PROCESSED', 'EVALUATED', 'FINALIZED',
    ],
    default: 'UPLOADING',
    index: true,
  },
  statusReason: { type: String, default: '' }, // educator-safe message for FAILED/NEEDS_REVIEW — Part V
  errorCode: { type: String, default: '' },
  failureStage: { type: String, default: '' },
  safeMessage: { type: String, default: '' },

  mappingMethod: { type: String, enum: ['QR', 'BARCODE', 'ROLL_NUMBER', 'CANDIDATE_ID', 'FILE_NAME', 'MANUAL', null], default: null },
  mappingConfidence: { type: Number, default: null, min: 0, max: 1 },
  detectedRollNumber: { type: String, default: '', trim: true },
  detectedCandidateName: { type: String, default: '', trim: true },
  identityExtract: {
    candidateName: { type: String, default: '' },
    rollNumber: { type: String, default: '' },
    externalStudentId: { type: String, default: '' },
    confidence: { type: Number, default: null },
    evidence: { type: mongoose.Schema.Types.Mixed, default: null },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
  },
  mappedAt: { type: Date, default: null },
  mappedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Weak-signal suggestions surfaced to a human for confirmation — never
  // auto-applied above mappingMethod: 'MANUAL' confidence (Part E).
  candidateSuggestions: [{
    _id: false,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    rollNumber: String,
    score: Number,
  }],

  processingMeta: {
    stage: { type: String, default: '' },
    pagesProcessed: { type: Number, default: 0 },
    pagesTotal: { type: Number, default: 0 },
    segmentsExtracted: { type: Number, default: 0 },
    segmentsMapped: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    activeJobId: { type: String, default: '' },
    retryCount: { type: Number, default: 0 },
  },
  stageCheckpoints: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  duplicate: {
    status: { type: String, enum: ['CLEAR', 'POSSIBLE_DUPLICATE'], default: 'CLEAR' },
    existingAnswerScriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScript', default: null },
    detectedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  retention: {
    policyKey: { type: String, default: 'platform-default' },
    lifecycleState: { type: String, enum: ['HOT', 'ARCHIVAL_ELIGIBLE', 'ARCHIVED'], default: 'HOT' },
    transitionEligibleAt: { type: Date, default: null },
  },
  storageMetrics: {
    originalBytes: { type: Number, default: 0 },
    normalizedBytes: { type: Number, default: 0 },
    previewBytes: { type: Number, default: 0 },
    thumbnailBytes: { type: Number, default: 0 },
    annotatedBytes: { type: Number, default: 0 },
    compressionRatio: { type: Number, default: null },
  },
  aiMetrics: {
    identityCalls: { type: Number, default: 0 },
    extractionCalls: { type: Number, default: 0 },
    evaluationCalls: { type: Number, default: 0 },
    visualCalls: { type: Number, default: 0 },
    inputImages: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
    estimatedCost: { type: Number, default: null },
    providers: [{ _id: false, provider: String, model: String, calls: Number }],
  },
  evaluationSummary: {
    totalScore: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    questionCount: { type: Number, default: 0 },
    evaluatedCount: { type: Number, default: 0 },
    needsReviewCount: { type: Number, default: 0 },
    evaluatedAt: { type: Date, default: null },
  },

  // Set once the finalized script has been written through to the
  // existing exam-attempt/result pipeline (Part N/O) — the idempotency
  // guard: re-processing the same script never creates a second attempt.
  materializedAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', default: null },
  finalizedAt: { type: Date, default: null },
  finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // A new private PDF generated from the immutable original plus the final
  // evaluator values. The original sourceFile key is never overwritten.
  evaluatedDerivative: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    mimeType: { type: String, default: 'application/pdf' },
    generatedAt: { type: Date, default: null },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    layoutMode: { type: String, enum: ['GEOMETRY_ANNOTATED', 'STRUCTURED_REVIEW_APPENDIX', null], default: null },
    status: { type: String, enum: ['PENDING', 'READY', 'FAILED', null], default: null },
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

AnswerScriptSchema.index({ tenantId: 1, examId: 1, status: 1 });
AnswerScriptSchema.index({ tenantId: 1, examId: 1, 'sourceFile.checksum': 1 });
AnswerScriptSchema.index({ tenantId: 1, examId: 1, 'originalObject.checksum': 1 });
AnswerScriptSchema.index({ tenantId: 1, candidateId: 1 });
// One candidate-specific machine token must never materialize two scripts.
AnswerScriptSchema.index(
  { mappingTokenId: 1 },
  { unique: true, partialFilterExpression: { mappingTokenId: { $type: 'objectId' } } },
);

export default mongoose.model('AnswerScript', AnswerScriptSchema);
