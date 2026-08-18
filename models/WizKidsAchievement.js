import mongoose from 'mongoose';

const WizKidsAchievementSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    icon: { type: String, trim: true, default: 'workspace_premium' },
    criteria: { type: mongoose.Schema.Types.Mixed, default: {} },
    xp: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('WizKidsAchievement', WizKidsAchievementSchema);
