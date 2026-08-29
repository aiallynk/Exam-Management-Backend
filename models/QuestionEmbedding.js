import mongoose from 'mongoose';

// One embedding per subject (a legacy exam-delivered Question OR a
// canonical QuestionVersion), kept in its own collection (mirrors
// ContextChunk) rather than on Question/QuestionVersion themselves so the
// hot exam/question read paths never load a 1536-float vector they don't
// need. `questionId` is kept as the field name for `Question` subjects
// (unchanged since Phase 2) so no re-migration is needed for embeddings
// already computed; `questionVersionId` is new, for the canonical bank
// (Part 5/6 convergence — see docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md).
// Exactly one of the two must be set.
const QuestionEmbeddingSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
  questionVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionVersion', default: null },
  embedding: { type: [Number], required: true },
  embeddingModel: { type: String, required: true },
  questionType: { type: String, default: null },
  difficulty: { type: String, default: null },
  computedAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });

QuestionEmbeddingSchema.pre('validate', function enforceExactlyOneSubject(next) {
  if (Boolean(this.questionId) === Boolean(this.questionVersionId)) {
    return next(new Error('QuestionEmbedding requires exactly one of questionId or questionVersionId.'));
  }
  return next();
});

QuestionEmbeddingSchema.index({ tenantId: 1, questionId: 1 }, { unique: true, partialFilterExpression: { questionId: { $type: 'objectId' } } });
QuestionEmbeddingSchema.index({ tenantId: 1, questionVersionId: 1 }, { unique: true, partialFilterExpression: { questionVersionId: { $type: 'objectId' } } });

export default mongoose.model('QuestionEmbedding', QuestionEmbeddingSchema);
