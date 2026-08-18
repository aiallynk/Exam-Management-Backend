import mongoose from 'mongoose';

// Read-optimised, derived projection. Answers and attempts remain canonical;
// this collection can always be rebuilt from them.
const WizKidsSkillProfileSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    skill: { type: String, required: true, trim: true },
    domain: { type: String, required: true, trim: true },
    attempted: { type: Number, default: 0, min: 0 },
    correct: { type: Number, default: 0, min: 0 },
    accuracy: { type: Number, default: 0, min: 0, max: 100 },
    averageTime: { type: Number, default: 0, min: 0 },
    masteryScore: { type: Number, default: 0, min: 0, max: 100 },
    lastAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WizKidsSkillProfileSchema.index({ tenantId: 1, candidateId: 1, skill: 1 }, { unique: true });
WizKidsSkillProfileSchema.index({ tenantId: 1, candidateId: 1, masteryScore: 1 });

export default mongoose.model('WizKidsSkillProfile', WizKidsSkillProfileSchema);
