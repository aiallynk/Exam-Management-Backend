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

  evaluationStatus: { type: String, enum: ['PENDING', 'EVALUATED', 'SKIPPED'], default: 'PENDING' },
  // Draft result from evaluationRouterService — the OFFICIAL record is the
  // materialized Answer document (Part O); this is carried here only long
  // enough for attemptMaterializationService to write it through.
  evaluationResult: { type: mongoose.Schema.Types.Mixed, default: null },
  materializedAnswerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Answer', default: null },
}, { timestamps: true, minimize: false });

AnswerSegmentSchema.index({ tenantId: 1, answerScriptId: 1, questionId: 1 });
AnswerSegmentSchema.index({ tenantId: 1, answerScriptId: 1, mappingStatus: 1 });

export default mongoose.model('AnswerSegment', AnswerSegmentSchema);
