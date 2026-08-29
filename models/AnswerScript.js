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
  mappingTokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScriptMappingToken', default: null },

  sourceFile: {
    key: { type: String, required: true },
    url: { type: String, required: true },
    checksum: { type: String, required: true, index: true }, // sha256 — duplicate-upload detection (Part W)
    sizeBytes: { type: Number, default: 0 },
  },
  originalFileName: { type: String, trim: true, maxlength: 255 },
  mimeType: { type: String, trim: true },
  pageCount: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['UPLOADED', 'PROCESSING', 'NEEDS_MAPPING', 'NEEDS_REVIEW', 'PROCESSED', 'EVALUATED', 'FINALIZED', 'FAILED'],
    default: 'UPLOADED',
    index: true,
  },
  statusReason: { type: String, default: '' }, // actionable message for FAILED/NEEDS_REVIEW — Part V

  mappingMethod: { type: String, enum: ['QR', 'BARCODE', 'ROLL_NUMBER', 'CANDIDATE_ID', 'FILE_NAME', 'MANUAL', null], default: null },
  mappingConfidence: { type: Number, default: null, min: 0, max: 1 },
  detectedRollNumber: { type: String, default: '', trim: true },
  detectedCandidateName: { type: String, default: '', trim: true },
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
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
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
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

AnswerScriptSchema.index({ tenantId: 1, examId: 1, status: 1 });
AnswerScriptSchema.index({ tenantId: 1, examId: 1, 'sourceFile.checksum': 1 });
AnswerScriptSchema.index({ tenantId: 1, candidateId: 1 });
// One candidate-specific machine token must never materialize two scripts.
AnswerScriptSchema.index(
  { mappingTokenId: 1 },
  { unique: true, partialFilterExpression: { mappingTokenId: { $type: 'objectId' } } },
);

export default mongoose.model('AnswerScript', AnswerScriptSchema);
