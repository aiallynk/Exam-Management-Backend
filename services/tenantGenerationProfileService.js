import TenantGenerationProfile from '../models/TenantGenerationProfile.js';

// Rolling tenant generation profile (spec Part 15). Explainable aggregates
// only; guarded by MIN_SAMPLE_SIZE so it never overfits after one or two
// questions. getPromptStyleHints() returns a tiny object that steers prompt
// STYLE — never facts, never source content.

export const MIN_SAMPLE_SIZE = 12;

const scopeKeyFor = (topicOrContext = {}) => {
  const grade = String(topicOrContext.grade || topicOrContext.className || '').trim().toLowerCase();
  const subject = String(topicOrContext.subject || '').trim().toLowerCase();
  if (!grade && !subject) return 'default';
  return [grade, subject].filter(Boolean).join('|').replace(/\s+/g, '-') || 'default';
};

const bump = (obj, key, by = 1) => {
  if (!key) return obj;
  const next = { ...(obj || {}) };
  next[key] = (next[key] || 0) + by;
  return next;
};

/**
 * Fold one QuestionIntelligenceSignal row into its tenant/scope profile.
 * Only ACCEPTED / EDITED outcomes move the profile (they are the quality
 * signal). Called fire-and-forget from questionHistoryService.
 */
export const updateTenantGenerationProfileFromSignal = async (signal) => {
  if (!signal || !signal.tenantId) return null;
  if (!['ACCEPTED', 'EDITED', 'SAVED_TO_BANK'].includes(signal.outcome)) return null;

  const scopeKey = scopeKeyFor({
    subject: signal.metadata?.subject,
    grade: signal.metadata?.grade,
  });
  const profile =
    (await TenantGenerationProfile.findOne({ tenantId: signal.tenantId, scopeKey })) ||
    new TenantGenerationProfile({ tenantId: signal.tenantId, scopeKey });

  const type = signal.questionType || null;
  const stemLen = Number(signal.metadata?.stemLength);
  const n = profile.sampleSize;

  if (signal.outcome === 'ACCEPTED' || signal.outcome === 'SAVED_TO_BANK') {
    profile.sampleSize = n + 1;
    profile.acceptedQuestionTypeCounts = bump(profile.acceptedQuestionTypeCounts, type);
    profile.acceptedDifficultyCounts = bump(profile.acceptedDifficultyCounts, signal.difficulty);
    profile.cognitiveDemandCounts = bump(profile.cognitiveDemandCounts, signal.cognitiveDemand);
    if (Number.isFinite(stemLen) && stemLen > 0) {
      profile.acceptedStemLengthMean = n > 0 ? (profile.acceptedStemLengthMean * n + stemLen) / (n + 1) : stemLen;
    }
    if (/scenario|situation|imagine|suppose|a plant|a student/i.test(String(signal.metadata?.stemLead || ''))) {
      profile.scenarioAcceptedCount += 1;
    }
  }
  if (type) {
    const stats = { edited: 0, total: 0, ...(profile.editStatsByType?.[type] || {}) };
    stats.total += 1;
    if (signal.outcome === 'EDITED') stats.edited += 1;
    profile.editStatsByType = { ...(profile.editStatsByType || {}), [type]: stats };
    profile.markModified('editStatsByType');
  }
  profile.markModified('acceptedQuestionTypeCounts');
  profile.markModified('acceptedDifficultyCounts');
  profile.markModified('cognitiveDemandCounts');
  profile.updatedAt = new Date();
  await profile.save();
  return profile;
};

/**
 * Small, explainable STYLE hints for a generation prompt. Empty object until
 * MIN_SAMPLE_SIZE reached. Never returns anything about source content.
 */
export const getPromptStyleHints = async ({ tenantId, subject = '', grade = '' } = {}) => {
  if (!tenantId) return {};
  const scopeKey = scopeKeyFor({ subject, grade });
  const profile =
    (await TenantGenerationProfile.findOne({ tenantId, scopeKey }).lean()) ||
    (scopeKey !== 'default' ? await TenantGenerationProfile.findOne({ tenantId, scopeKey: 'default' }).lean() : null);
  if (!profile || profile.sampleSize < MIN_SAMPLE_SIZE) return {};

  const hints = {};
  if (profile.acceptedStemLengthMean > 0) {
    hints.preferredStemLength =
      profile.acceptedStemLengthMean < 90 ? 'concise' : profile.acceptedStemLengthMean > 180 ? 'detailed' : 'moderate';
  }
  const scenarioRate = profile.sampleSize ? profile.scenarioAcceptedCount / profile.sampleSize : 0;
  hints.scenarioPreference = scenarioRate > 0.4 ? 'favour applied scenarios' : scenarioRate < 0.1 ? 'keep direct' : 'mixed';
  const topType = Object.entries(profile.acceptedQuestionTypeCounts || {}).sort((a, b) => b[1] - a[1])[0];
  if (topType) hints.mostAcceptedType = topType[0];
  hints.explain = `Based on ${profile.sampleSize} accepted questions in this tenant/scope.`;
  return hints;
};

export const _internals = { scopeKeyFor, MIN_SAMPLE_SIZE };
