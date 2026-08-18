import Answer from '../models/Answer.js';
import ExamAttempt from '../models/ExamAttempt.js';
import WizKidsBatchMember from '../models/WizKidsBatchMember.js';
import WizKidsQuestionBankItem from '../models/WizKidsQuestionBankItem.js';
import WizKidsQuestionLink from '../models/WizKidsQuestionLink.js';
import WizKidsSkillProfile from '../models/WizKidsSkillProfile.js';
import WizKidsFlashAttemptState from '../models/WizKidsFlashAttemptState.js';
import WizKidsFlashRound from '../models/WizKidsFlashRound.js';

// Phase 12 — reliable derived analytics. Only completed attempts with an
// explicit objective outcome participate. Incomplete/unevaluated answers are
// never silently represented as wrong answers.
const round = (value) => Number(Number(value || 0).toFixed(2));

export const buildFlashMetrics = ({ states = [], rounds = [] }) => {
  const roundByQuestionId = new Map(rounds.map((entry) => [String(entry.questionId), entry]));
  const summary = { attempted: 0, correct: 0, responseTimeMs: 0, flashDurationMs: 0 };
  const operations = new Map();
  for (const state of states) {
    for (const timing of state.roundTimings || []) {
      const metadata = roundByQuestionId.get(String(timing.questionId));
      if (!metadata) continue;
      const bucket = operations.get(metadata.operationMode) || { operationMode: metadata.operationMode, attempted: 0, correct: 0, responseTimeMs: 0, flashDurationMs: 0, operandCount: 0, maximumDigits: 0 };
      const flashDurationMs = metadata.operands.length * (metadata.flashDurationMs + metadata.gapDurationMs);
      const maximumDigits = Math.max(...metadata.operands.map((value) => String(Math.abs(value)).length));
      summary.attempted += 1; summary.correct += timing.isCorrect ? 1 : 0; summary.responseTimeMs += timing.responseTimeMs; summary.flashDurationMs += flashDurationMs;
      bucket.attempted += 1; bucket.correct += timing.isCorrect ? 1 : 0; bucket.responseTimeMs += timing.responseTimeMs; bucket.flashDurationMs += flashDurationMs; bucket.operandCount += metadata.operands.length; bucket.maximumDigits = Math.max(bucket.maximumDigits, maximumDigits);
      operations.set(metadata.operationMode, bucket);
    }
  }
  const format = (entry) => ({
    attempted: entry.attempted,
    correct: entry.correct,
    accuracy: entry.attempted ? round((entry.correct / entry.attempted) * 100) : 0,
    averageResponseTime: entry.attempted ? round(entry.responseTimeMs / entry.attempted / 1000) : 0,
    averageFlashDuration: entry.attempted ? round(entry.flashDurationMs / entry.attempted / 1000) : 0,
    ...(entry.operationMode ? { operationMode: entry.operationMode, averageOperandCount: round(entry.operandCount / entry.attempted), maximumDigits: entry.maximumDigits } : {}),
  });
  return { ...format(summary), byOperation: [...operations.values()].map(format) };
};

export const collectFlashMetrics = async ({ tenantId, candidateIds }) => {
  const ids = (Array.isArray(candidateIds) ? candidateIds : [candidateIds]).filter(Boolean);
  if (!ids.length) return buildFlashMetrics({});
  const attempts = await ExamAttempt.find({ tenantId, userId: { $in: ids }, isCompleted: true }).select('_id examId').lean();
  if (!attempts.length) return buildFlashMetrics({});
  const states = await WizKidsFlashAttemptState.find({ tenantId, attemptId: { $in: attempts.map((entry) => entry._id) }, completedAt: { $ne: null } }).select('examId roundTimings').lean();
  const questionIds = states.flatMap((state) => (state.roundTimings || []).map((timing) => timing.questionId));
  const rounds = questionIds.length ? await WizKidsFlashRound.find({ tenantId, questionId: { $in: questionIds } }).select('questionId operationMode operands flashDurationMs gapDurationMs').lean() : [];
  return buildFlashMetrics({ states, rounds });
};

export const calculateMasteryScore = ({ accuracy, averageTime }) => {
  const accuracyWeight = Math.max(0, Math.min(100, Number(accuracy) || 0)) * 0.8;
  // A response time up to 60 seconds is scored linearly as the remaining 20%.
  const speedWeight = Math.max(0, Math.min(20, 20 - (Number(averageTime) || 0) / 3));
  return round(accuracyWeight + speedWeight);
};

export const buildSkillMetrics = ({ answers, linksByQuestionId }) => {
  const grouped = new Map();
  for (const answer of answers) {
    if (typeof answer.isCorrect !== 'boolean') continue;
    const link = linksByQuestionId.get(String(answer.questionId));
    if (!link) continue;
    const domain = link.skillMetadata?.domain || 'UNSPECIFIED';
    const skill = link.skillMetadata?.skill || link.skillMetadata?.topic || domain;
    const key = `${domain}|${skill}`;
    const current = grouped.get(key) || { domain, skill, attempted: 0, correct: 0, totalTime: 0, lastAttemptAt: null };
    current.attempted += 1;
    current.correct += answer.isCorrect ? 1 : 0;
    current.totalTime += Math.max(0, Number(answer.timeSpent) || 0);
    const date = answer.updatedAt || answer.createdAt || null;
    if (date && (!current.lastAttemptAt || new Date(date) > new Date(current.lastAttemptAt))) current.lastAttemptAt = date;
    grouped.set(key, current);
  }
  return [...grouped.values()].map((metric) => {
    const accuracy = metric.attempted ? (metric.correct / metric.attempted) * 100 : 0;
    const averageTime = metric.attempted ? metric.totalTime / metric.attempted : 0;
    return {
      ...metric,
      accuracy: round(accuracy),
      averageTime: round(averageTime),
      masteryScore: calculateMasteryScore({ accuracy, averageTime }),
    };
  });
};

export const collectCandidateSkillMetrics = async ({ tenantId, candidateId }) => {
  const attempts = await ExamAttempt.find({ tenantId, userId: candidateId, isCompleted: true })
    .select('_id submittedAt updatedAt')
    .lean();
  if (!attempts.length) return [];
  const answers = await Answer.find({ attemptId: { $in: attempts.map((attempt) => attempt._id) } })
    .select('questionId isCorrect timeSpent updatedAt createdAt')
    .lean();
  const questionIds = [...new Set(answers.map((answer) => String(answer.questionId)))];
  if (!questionIds.length) return [];
  const links = await WizKidsQuestionLink.find({ tenantId, questionId: { $in: questionIds } })
    .select('questionId skillMetadata')
    .lean();
  const linksByQuestionId = new Map(links.map((link) => [String(link.questionId), link]));
  return buildSkillMetrics({ answers, linksByQuestionId });
};

export const rebuildCandidateSkillProfile = async ({ tenantId, candidateId }) => {
  const metrics = await collectCandidateSkillMetrics({ tenantId, candidateId });
  if (!metrics.length) return [];
  await WizKidsSkillProfile.bulkWrite(
    metrics.map((metric) => ({
      updateOne: {
        filter: { tenantId, candidateId, skill: metric.skill },
        update: {
          $set: {
            domain: metric.domain,
            attempted: metric.attempted,
            correct: metric.correct,
            accuracy: metric.accuracy,
            averageTime: metric.averageTime,
            masteryScore: metric.masteryScore,
            lastAttemptAt: metric.lastAttemptAt,
          },
        },
        upsert: true,
      },
    }))
  );
  return WizKidsSkillProfile.find({ tenantId, candidateId }).sort({ masteryScore: 1, skill: 1 }).lean();
};

export const getCandidateAnalytics = async ({ tenantId, candidateId, rebuild = false }) => {
  const [profiles, flashMaths] = await Promise.all([
    rebuild
      ? rebuildCandidateSkillProfile({ tenantId, candidateId })
      : WizKidsSkillProfile.find({ tenantId, candidateId }).sort({ masteryScore: 1, skill: 1 }).lean(),
    collectFlashMetrics({ tenantId, candidateIds: [candidateId] }),
  ]);
  const totals = profiles.reduce(
    (result, profile) => {
      result.attempted += profile.attempted;
      result.correct += profile.correct;
      result.totalTime += profile.averageTime * profile.attempted;
      return result;
    },
    { attempted: 0, correct: 0, totalTime: 0 }
  );
  return {
    profiles,
    summary: {
      attempted: totals.attempted,
      correct: totals.correct,
      accuracy: totals.attempted ? round((totals.correct / totals.attempted) * 100) : 0,
      averageResponseTime: totals.attempted ? round(totals.totalTime / totals.attempted) : 0,
      weakestSkill: profiles[0]?.skill || null,
      strongestSkill: profiles.length ? profiles[profiles.length - 1].skill : null,
    },
    flashMaths,
  };
};

export const getBatchAnalytics = async ({ tenantId, batchId }) => {
  const members = await WizKidsBatchMember.find({ tenantId, batchId, role: 'CANDIDATE', status: 'ACTIVE' }).select('userId').lean();
  const candidateIds = members.map((member) => member.userId);
  const [results, flashMaths] = await Promise.all([
    Promise.all(candidateIds.map((candidateId) => getCandidateAnalytics({ tenantId, candidateId }))),
    collectFlashMetrics({ tenantId, candidateIds }),
  ]);
  const allProfiles = results.flatMap((result) => result.profiles);
  const bySkill = new Map();
  for (const profile of allProfiles) {
    const current = bySkill.get(profile.skill) || { skill: profile.skill, domain: profile.domain, attempted: 0, correct: 0, totalTime: 0 };
    current.attempted += profile.attempted;
    current.correct += profile.correct;
    current.totalTime += profile.averageTime * profile.attempted;
    bySkill.set(profile.skill, current);
  }
  return {
    candidateCount: candidateIds.length,
    skills: [...bySkill.values()].map((entry) => ({
      ...entry,
      accuracy: entry.attempted ? round((entry.correct / entry.attempted) * 100) : 0,
      averageTime: entry.attempted ? round(entry.totalTime / entry.attempted) : 0,
    })).sort((left, right) => left.accuracy - right.accuracy),
    flashMaths,
  };
};

export const getAdaptiveRecommendations = async ({ tenantId, candidateId, gradeLevel, limit = 6 }) => {
  const profiles = await WizKidsSkillProfile.find({ tenantId, candidateId }).sort({ masteryScore: 1, lastAttemptAt: 1 }).limit(3).lean();
  const domains = profiles.map((profile) => profile.domain).filter((domain) => domain && domain !== 'UNSPECIFIED');
  const filter = { tenantId, status: 'PUBLISHED', gradeLevel: Number(gradeLevel) };
  if (domains.length) filter.domain = { $in: domains };
  const items = await WizKidsQuestionBankItem.find(filter)
    .select('_id domain gradeLevel topic subTopic skill difficulty interactionType questionContent media')
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(20, Number(limit) || 6)))
    .lean();
  return {
    focusSkills: profiles.map((profile) => ({ skill: profile.skill, domain: profile.domain, masteryScore: profile.masteryScore })),
    items,
  };
};
