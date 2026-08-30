import mongoose from 'mongoose';

// One versioned snapshot of question content under a QuestionBankItem.
// Content fields deliberately mirror models/Question.js's authoring fields
// (questionText/questionType/options/...) so materializing a version into a
// real exam Question is a straight field copy, not a translation layer.
const QuestionVersionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  questionBankItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionBankItem', required: true, index: true },
  version: { type: Number, required: true, min: 1 },

  questionText: { type: String, required: true, trim: true },
  questionType: { type: String, required: true },
  questionFormat: { type: String, default: null },
  options: { type: [String], default: undefined },
  matchingPairs: { type: mongoose.Schema.Types.Mixed, default: undefined },
  correctAnswer: { type: mongoose.Schema.Types.Mixed, default: null },
  passage: { type: String, default: '' },
  paragraphGroupId: { type: String, default: '' },
  codingFields: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Marking scheme / rubric snapshot-or-reference — same free-form shape as
  // Question.evaluationConfig (may carry an embedded `rubric` array).
  evaluationConfig: { type: mongoose.Schema.Types.Mixed, default: {} },

  difficulty: { type: String, default: 'medium' },
  bloomLevel: { type: String, enum: ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE', null], default: null },
  // Independent of difficulty/bloomLevel above (Blueprint section 4B) —
  // see models/Question.js's cognitiveDemand for the full rationale.
  cognitiveDemand: { type: String, enum: ['LOT', 'MOT', 'HOT', null], default: null },
  learningOutcomes: { type: [String], default: [] },

  // Source provenance (generation run, source chunks, novelty signatures) —
  // same shape as Question.provenance so a materialized copy can carry it
  // forward unchanged.
  provenance: { type: mongoose.Schema.Types.Mixed, default: undefined },

  status: { type: String, enum: ['DRAFT', 'REVIEWED', 'APPROVED', 'RETIRED'], default: 'DRAFT', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true, minimize: false });

QuestionVersionSchema.index({ tenantId: 1, questionBankItemId: 1, version: 1 }, { unique: true });
QuestionVersionSchema.index({ tenantId: 1, status: 1 });

export default mongoose.model('QuestionVersion', QuestionVersionSchema);
