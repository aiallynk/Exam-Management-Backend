import mongoose from 'mongoose';

// The detected response to ONE question, extracted from one or more
// script pages. `questionId` always points at the frozen, already-
// delivered Question on the paper (never a mutable QuestionVersion — Part
// H's explicit requirement) and stays null until mapping succeeds. Never
// discard low-confidence extractions: they stay here with their raw text
// and page reference for evaluator inspection (Part H).
const AnswerSegmentSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  answerScriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScript', required: true, index: true },
  segmentKey: { type: String, default: null },
  pageIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScriptPage' }],

  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null, index: true },
  detectedQuestionNumber: { type: String, default: '', trim: true }, // e.g. "3(b)" as printed/handwritten
  responseType: { type: String, default: '' }, // Question.questionType at mapping time, drives the Evaluation Router

  extractedText: { type: String, default: '' },
  extractionConfidence: { type: Number, default: null, min: 0, max: 1 },

  mappingConfidence: { type: Number, default: null, min: 0, max: 1 },
  mappingStatus: {
    type: String,
    enum: ['UNMAPPED', 'AUTO_MAPPED', 'NEEDS_REVIEW', 'MANUALLY_MAPPED', 'REJECTED'],
    default: 'UNMAPPED',
    index: true,
  },
  mappedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // set only for MANUALLY_MAPPED

  boundingRegion: { type: mongoose.Schema.Types.Mixed, default: null }, // only when the OCR/vision pass returns reliable geometry — never fabricated
  lineBoxes: [{
    _id: false,
    id: String,
    // Additive page identity keeps continuation geometry associated with the
    // physical page on which the handwritten line appears.
    pageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScriptPage', default: null },
    text: String,
    x: { type: Number, min: 0, max: 1 },
    y: { type: Number, min: 0, max: 1 },
    width: { type: Number, min: 0, max: 1 },
    height: { type: Number, min: 0, max: 1 },
  }],
  cropObject: {
    key: { type: String, default: null },
    checksum: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
  },
  contentHash: { type: String, default: null, index: true },

  evaluationStatus: { type: String, enum: ['PENDING', 'EVALUATED', 'SKIPPED'], default: 'PENDING' },
  // Draft result from evaluationRouterService — the OFFICIAL record is the
  // materialized Answer document (Part O); this is carried here only long
  // enough for attemptMaterializationService to write it through.
  evaluationResult: { type: mongoose.Schema.Types.Mixed, default: null },
  materializedAnswerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Answer', default: null },
  evaluationCheckpoint: {
    inputHash: { type: String, default: null },
    completedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  },
}, { timestamps: true, minimize: false });

AnswerSegmentSchema.index({ tenantId: 1, answerScriptId: 1, questionId: 1 });
AnswerSegmentSchema.index(
  { tenantId: 1, answerScriptId: 1, segmentKey: 1 },
  { unique: true, partialFilterExpression: { segmentKey: { $type: 'string' } } },
);
AnswerSegmentSchema.index({ tenantId: 1, answerScriptId: 1, mappingStatus: 1 });

export default mongoose.model('AnswerSegment', AnswerSegmentSchema);
