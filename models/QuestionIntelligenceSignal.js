import mongoose from 'mongoose';

const QuestionIntelligenceSignalSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    signalType: {
      type: String,
      enum: [
        'QUESTION_APPROVED',
        'QUESTION_REJECTED',
        'QUESTION_HUMAN_EDITED',
        'QUESTION_REGENERATED',
        'QUESTION_USED',
        'QUESTION_REUSED',
        'HIGH_FAILURE_RATE',
        'EVALUATOR_OVERRIDE',
        // Source-Verified Question Intelligence (additive) — this collection
        // IS the "question generation history" event store (spec Part 13).
        'QUESTION_GENERATED',
        'QUESTION_SAVED_TO_BANK',
      ],
      required: true,
      index: true,
    },
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
    questionVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionVersion', default: null },
    // --- additive generation-history / feedback context (spec Parts 12-15) ---
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
    generationRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'AIGenerationRun', default: null },
    // Coarse lifecycle outcome for aggregation without re-deriving from signalType.
    outcome: {
      type: String,
      enum: ['GENERATED', 'ACCEPTED', 'EDITED', 'REJECTED', 'REGENERATED', 'SAVED_TO_BANK', 'USED_IN_EXAM'],
      default: undefined,
      index: true,
    },
    questionType: { type: String, default: undefined },
    difficulty: { type: String, default: undefined },
    bloomLevel: { type: String, default: undefined },
    cognitiveDemand: { type: String, default: undefined },
    topic: { type: String, trim: true, default: undefined },
    generationMode: { type: String, default: undefined },
    // Non-reversible source fingerprints (evidenceHash list) — never chunk text.
    sourceFingerprints: { type: [String], default: undefined },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

QuestionIntelligenceSignalSchema.index({ tenantId: 1, signalType: 1, createdAt: -1 });
QuestionIntelligenceSignalSchema.index({ tenantId: 1, outcome: 1, createdAt: -1 });
QuestionIntelligenceSignalSchema.index({ tenantId: 1, questionType: 1, outcome: 1, createdAt: -1 });

export default mongoose.model('QuestionIntelligenceSignal', QuestionIntelligenceSignalSchema);
