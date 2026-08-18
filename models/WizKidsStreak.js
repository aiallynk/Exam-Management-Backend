import mongoose from 'mongoose';

const WizKidsStreakSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    currentDays: { type: Number, default: 0, min: 0 },
    longestDays: { type: Number, default: 0, min: 0 },
    lastActivityDate: { type: String, default: '' },
    totalXp: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

WizKidsStreakSchema.index({ tenantId: 1, candidateId: 1 }, { unique: true });

export default mongoose.model('WizKidsStreak', WizKidsStreakSchema);
