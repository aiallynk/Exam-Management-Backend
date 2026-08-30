import mongoose from 'mongoose';

// Lightweight, explainable per-tenant generation profile (spec Part 15).
// This is NOT model fine-tuning and NOT a prompt-history store — only
// stable rolling aggregates of what a tenant's creators have accepted, so
// future prompts can match *style* (stem length, scenario preference,
// concision). It NEVER influences factual source content.

const TenantGenerationProfileSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    // Coarse scope, e.g. "grade-vii|science" or "default". One profile per scope.
    scopeKey: { type: String, required: true, trim: true, default: 'default' },

    sampleSize: { type: Number, default: 0 },
    // { MULTIPLE_CHOICE: 12, SHORT_ANSWER: 4, ... } — accepted counts.
    acceptedQuestionTypeCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    // rolling means / counts
    acceptedStemLengthMean: { type: Number, default: 0 },
    scenarioAcceptedCount: { type: Number, default: 0 },
    acceptedDifficultyCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    cognitiveDemandCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    // { MULTIPLE_CHOICE: { edited: 3, total: 15 }, ... }
    editStatsByType: { type: mongoose.Schema.Types.Mixed, default: {} },

    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

TenantGenerationProfileSchema.index({ tenantId: 1, scopeKey: 1 }, { unique: true });

export default mongoose.model('TenantGenerationProfile', TenantGenerationProfileSchema);
