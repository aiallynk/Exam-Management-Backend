import mongoose from 'mongoose';

const WizKidsCandidateAchievementSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    achievementId: { type: mongoose.Schema.Types.ObjectId, ref: 'WizKidsAchievement', required: true },
    awardedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

WizKidsCandidateAchievementSchema.index({ tenantId: 1, candidateId: 1, achievementId: 1 }, { unique: true });

export default mongoose.model('WizKidsCandidateAchievement', WizKidsCandidateAchievementSchema);
