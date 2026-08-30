import mongoose from 'mongoose';

// Source-Grounded AI Question Generation — one audit/trace row per
// POST /api/ai/generate-questions call, regardless of generation mode. Both
// standard and source-grounded modes write to this same collection so support/
// debugging/usage-review has one place to look, matching how
// AITokenUsage is a single collection for every AI feature rather than
// one per feature.
const AIGenerationRunSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      default: null,
      index: true,
    },
    generationMode: {
      type: String,
      enum: ['STANDARD', 'SOURCE_GROUNDED'],
      required: true,
      index: true,
    },
    contextSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ContextSet',
      default: null,
    },
    requestedSourceIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    requestedCount: {
      type: Number,
      required: true,
      min: 0,
    },
    acceptedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Non-STRICT source-grounded runs (SELECTED_CONTEXT / AUTO_CONTEXT) top up
    // any grounded shortfall on the same topic so the request is always
    // fulfilled (Blueprint §4C). This is how many of the delivered questions
    // came from that top-up rather than from grounded retrieval.
    supplementedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    rejectedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // e.g. { NOT_GROUNDED: 3, DUPLICATE_EXACT: 1, DUPLICATE_NEAR: 2 }
    rejectionReasons: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Source-discovery summary (spec Parts 6, 24, 28) — which selected
    // sources actually carried relevant evidence, per-resource coverage,
    // chapters used. Metadata only; never chunk text or prompts.
    evidencePlanSummary: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    insufficientSourceMaterial: {
      type: Boolean,
      default: false,
    },
    oversampleFactor: {
      type: Number,
      default: 1,
    },
    status: {
      type: String,
      enum: ['RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL'],
      default: 'RUNNING',
      index: true,
    },
    errorMessage: {
      type: String,
      trim: true,
      default: '',
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

AIGenerationRunSchema.index({ tenantId: 1, createdAt: -1 });
AIGenerationRunSchema.index({ tenantId: 1, generationMode: 1, createdAt: -1 });

export default mongoose.model('AIGenerationRun', AIGenerationRunSchema);
