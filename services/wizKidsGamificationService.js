import ExamAttempt from '../models/ExamAttempt.js';
import WizKidsAchievement from '../models/WizKidsAchievement.js';
import WizKidsCandidateAchievement from '../models/WizKidsCandidateAchievement.js';
import WizKidsSkillProfile from '../models/WizKidsSkillProfile.js';
import WizKidsStreak from '../models/WizKidsStreak.js';

// Phase 13. Academic marks are never written here: this service creates only
// isolated XP, achievement, and streak records.
export const DEFAULT_ACHIEVEMENTS = Object.freeze([
  { key: 'FIRST_STEPS', name: 'First Steps', description: 'Complete your first WizKids assessment.', icon: 'flag', criteria: { completedAttempts: 1 }, xp: 10 },
  { key: 'SHARP_MIND', name: 'Sharp Mind', description: 'Reach 80% accuracy across at least three answers.', icon: 'psychology', criteria: { accuracy: 80, attempted: 3 }, xp: 25 },
  { key: 'SPEED_STAR', name: 'Speed Star', description: 'Keep average response time under 10 seconds across five answers.', icon: 'bolt', criteria: { averageTime: 10, attempted: 5 }, xp: 30 },
  { key: 'SKILL_BUILDER', name: 'Skill Builder', description: 'Build three tracked WizKids skills.', icon: 'school', criteria: { skills: 3 }, xp: 20 },
]);

const dateKey = (value) => new Date(value).toISOString().slice(0, 10);
const previousDateKey = (value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return dateKey(date);
};

export const ensureDefaultAchievements = async () => {
  await WizKidsAchievement.bulkWrite(
    DEFAULT_ACHIEVEMENTS.map((achievement) => ({
      updateOne: { filter: { key: achievement.key }, update: { $setOnInsert: { ...achievement, active: true } }, upsert: true },
    }))
  );
  return WizKidsAchievement.find({ key: { $in: DEFAULT_ACHIEVEMENTS.map((achievement) => achievement.key) }, active: true }).lean();
};

export const refreshCandidateGamification = async ({ tenantId, candidateId, now = new Date() }) => {
  const [achievements, profiles, completedAttempts] = await Promise.all([
    ensureDefaultAchievements(),
    WizKidsSkillProfile.find({ tenantId, candidateId }).lean(),
    ExamAttempt.find({ tenantId, userId: candidateId, isCompleted: true }).select('submittedAt updatedAt').lean(),
  ]);
  const attempted = profiles.reduce((sum, profile) => sum + profile.attempted, 0);
  const correct = profiles.reduce((sum, profile) => sum + profile.correct, 0);
  const averageTime = attempted
    ? profiles.reduce((sum, profile) => sum + profile.averageTime * profile.attempted, 0) / attempted
    : 0;
  const accuracy = attempted ? (correct / attempted) * 100 : 0;
  const facts = { completedAttempts: completedAttempts.length, attempted, accuracy, averageTime, skills: profiles.length };
  const eligible = achievements.filter((achievement) => {
    const criteria = achievement.criteria || {};
    return (!criteria.completedAttempts || facts.completedAttempts >= criteria.completedAttempts)
      && (!criteria.attempted || facts.attempted >= criteria.attempted)
      && (!criteria.accuracy || facts.accuracy >= criteria.accuracy)
      && (!criteria.averageTime || facts.averageTime <= criteria.averageTime)
      && (!criteria.skills || facts.skills >= criteria.skills);
  });
  if (eligible.length) {
    await WizKidsCandidateAchievement.bulkWrite(
      eligible.map((achievement) => ({
        updateOne: {
          filter: { tenantId, candidateId, achievementId: achievement._id },
          update: { $setOnInsert: { tenantId, candidateId, achievementId: achievement._id, awardedAt: now } },
          upsert: true,
        },
      }))
    );
  }
  const activeDates = [...new Set(completedAttempts.map((attempt) => dateKey(attempt.submittedAt || attempt.updatedAt || now)))].sort();
  const today = dateKey(now);
  const lastActivityDate = activeDates.at(-1) || '';
  let currentDays = 0;
  if (lastActivityDate === today || lastActivityDate === previousDateKey(today)) {
    let cursor = lastActivityDate;
    const dateSet = new Set(activeDates);
    while (dateSet.has(cursor)) {
      currentDays += 1;
      cursor = previousDateKey(cursor);
    }
  }
  const awarded = await WizKidsCandidateAchievement.find({ tenantId, candidateId }).populate('achievementId', 'key name description icon xp').sort({ awardedAt: -1 }).lean();
  const totalXp = awarded.reduce((sum, record) => sum + (Number(record.achievementId?.xp) || 0), 0);
  const existingStreak = await WizKidsStreak.findOne({ tenantId, candidateId }).lean();
  const streak = await WizKidsStreak.findOneAndUpdate(
    { tenantId, candidateId },
    {
      $set: { currentDays, longestDays: Math.max(existingStreak?.longestDays || 0, currentDays), lastActivityDate, totalXp },
      $setOnInsert: { tenantId, candidateId },
    },
    { new: true, upsert: true }
  ).lean();
  return { achievements: awarded, streak, facts: { ...facts, accuracy, averageTime } };
};
