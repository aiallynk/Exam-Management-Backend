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
      ],
      required: true,
      index: true,
    },
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
    questionVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionVersion', default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

QuestionIntelligenceSignalSchema.index({ tenantId: 1, signalType: 1, createdAt: -1 });

export default mongoose.model('QuestionIntelligenceSignal', QuestionIntelligenceSignalSchema);
