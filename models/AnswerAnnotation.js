import mongoose from 'mongoose';

const RegionSchema = new mongoose.Schema({
  x: { type: Number, required: true, min: 0, max: 1 },
  y: { type: Number, required: true, min: 0, max: 1 },
  width: { type: Number, required: true, min: 0, max: 1 },
  height: { type: Number, required: true, min: 0, max: 1 },
}, { _id: false });

const AnswerAnnotationSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  answerScriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScript', required: true, index: true },
  pageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerScriptPage', required: true, index: true },
  answerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Answer', default: null, index: true },
  answerSegmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerSegment', default: null, index: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null, index: true },
  type: {
    type: String,
    enum: ['CORRECT', 'INCORRECT', 'PARTIAL', 'SPELLING', 'GRAMMAR', 'MISSING_POINT', 'EXTRA_POINT', 'RUBRIC_NOTE', 'COMMENT', 'SCORE'],
    required: true,
  },
  region: { type: RegionSchema, required: true },
  evidenceText: { type: String, trim: true, maxlength: 500, default: '' },
  lineId: { type: String, trim: true, default: '' },
  message: { type: String, trim: true, maxlength: 1000, default: '' },
  suggestedCorrection: { type: String, trim: true, maxlength: 500, default: '' },
  proposedScore: { type: Number, min: 0, default: null },
  confidence: { type: Number, min: 0, max: 1, default: null },
  source: { type: String, enum: ['AI', 'EVALUATOR'], default: 'AI' },
  status: { type: String, enum: ['PROPOSED', 'APPROVED', 'EDITED', 'REJECTED'], default: 'PROPOSED', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  idempotencyKey: { type: String, required: true },
}, { timestamps: true });

AnswerAnnotationSchema.index({ tenantId: 1, answerScriptId: 1, pageId: 1 });
AnswerAnnotationSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });

export default mongoose.model('AnswerAnnotation', AnswerAnnotationSchema);
