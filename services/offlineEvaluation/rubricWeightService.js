const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const round2 = (value) => Number(Number(value).toFixed(2));

export const DEFAULT_PERFORMANCE_LEVELS = Object.freeze({
  Excellent: 100,
  Good: 75,
  Developing: 50,
  Beginning: 25,
  'No Evidence': 0,
});

export const migrateLegacyCriteriaToWeights = (criteria = []) => {
  const entries = (Array.isArray(criteria) ? criteria : []).map((entry, index) => ({
    key: entry.key || entry.id || `criterion_${index + 1}`,
    label: entry.label || entry.criterion || entry.name || `Criterion ${index + 1}`,
    description: entry.description || '',
    weightPercentage: finite(entry.weightPercentage ?? entry.weight),
    maxMarks: finite(entry.maxMarks ?? entry.maxScore ?? entry.points),
    descriptors: entry.descriptors || entry.performanceLevels || {},
    required: entry.required ?? entry.mandatory ?? true,
  }));

  const hasPercentage = entries.some((entry) => finite(entry.weightPercentage) != null && entry.weightPercentage > 0);
  if (hasPercentage) {
    return {
      criteria: entries.map((entry) => ({
        ...entry,
        weightPercentage: round2(entry.weightPercentage || 0),
      })),
      migrated: false,
      migrationRequired: false,
    };
  }

  const legacyTotal = entries.reduce((sum, entry) => sum + (entry.maxMarks || 0), 0);
  if (!legacyTotal) {
    return { criteria: entries, migrated: false, migrationRequired: true };
  }

  const migrated = entries.map((entry) => ({
    ...entry,
    weightPercentage: round2(((entry.maxMarks || 0) / legacyTotal) * 100),
  }));
  const weightTotal = migrated.reduce((sum, entry) => sum + entry.weightPercentage, 0);
  if (migrated.length && Math.abs(weightTotal - 100) > 0.01) {
    migrated[migrated.length - 1].weightPercentage = round2(
      migrated[migrated.length - 1].weightPercentage + (100 - weightTotal),
    );
  }
  return { criteria: migrated, migrated: true, migrationRequired: false, legacyTotal };
};

export const validateRubricWeights = (criteria = []) => {
  const { criteria: resolved, migrationRequired } = migrateLegacyCriteriaToWeights(criteria);
  if (migrationRequired) {
    return { valid: false, totalWeight: 0, reason: 'MIGRATION_REVIEW_REQUIRED', criteria: resolved };
  }
  const active = resolved.filter((entry) => entry.required !== false);
  const totalWeight = round2(active.reduce((sum, entry) => sum + (entry.weightPercentage || 0), 0));
  if (Math.abs(totalWeight - 100) > 0.01) {
    return { valid: false, totalWeight, reason: 'WEIGHT_SUM_INVALID', criteria: resolved };
  }
  return { valid: true, totalWeight: 100, reason: '', criteria: resolved };
};

export const resolveCriterionMaxContribution = (questionMaxMarks, weightPercentage) => (
  round2((Number(questionMaxMarks) || 0) * (Number(weightPercentage) || 0) / 100)
);

export const resolvePerformanceAchievement = (level, scale = DEFAULT_PERFORMANCE_LEVELS) => {
  const normalized = String(level || '').trim();
  if (!normalized) return null;
  const direct = finite(scale[normalized]);
  if (direct != null) return direct;
  const match = Object.entries(scale).find(([key]) => key.toLowerCase() === normalized.toLowerCase());
  return match ? finite(match[1]) : null;
};

export const computeCriterionContribution = ({
  questionMaxMarks,
  weightPercentage,
  achievementPercentage,
}) => round2(
  (Number(questionMaxMarks) || 0)
  * (Number(weightPercentage) || 0) / 100
  * (Number(achievementPercentage) || 0) / 100,
);

export const computeWeightedQuestionScore = ({
  questionMaxMarks,
  criteria = [],
  achievements = [],
  performanceLevels = DEFAULT_PERFORMANCE_LEVELS,
  strictCriterionRefs = false,
} = {}) => {
  const validation = validateRubricWeights(criteria);
  if (!validation.valid) {
    return {
      valid: false,
      reason: validation.reason,
      total: 0,
      entries: [],
    };
  }

  const normalizedAchievements = Array.isArray(achievements) ? achievements : [];
  const matchingAchievement = (criterion) => normalizedAchievements.find((item) => {
    const keys = [item.criterionId, item.key, item.criterion, item.criterionRef]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return keys.includes(criterion.key) || keys.includes(criterion.label);
  });

  // Rubric evaluation is not permitted to silently turn a malformed provider
  // response into a plausible zero. New strict calls require one identified
  // result for every frozen criterion; legacy callers retain positional
  // compatibility unless they opt in.
  if (strictCriterionRefs && (
    normalizedAchievements.length !== validation.criteria.length
    || validation.criteria.some((criterion) => !matchingAchievement(criterion))
  )) {
    return { valid: false, reason: 'CRITERION_ID_MISMATCH', total: 0, entries: [] };
  }

  const entries = validation.criteria.map((criterion, index) => {
    const achievementInput = matchingAchievement(criterion) || normalizedAchievements[index] || {};

    const achievementPercentage = finite(achievementInput.achievementPercentage)
      ?? resolvePerformanceAchievement(achievementInput.level, performanceLevels)
      ?? finite(achievementInput.score)
      ?? 0;

    const maxContribution = resolveCriterionMaxContribution(questionMaxMarks, criterion.weightPercentage);
    const contribution = computeCriterionContribution({
      questionMaxMarks,
      weightPercentage: criterion.weightPercentage,
      achievementPercentage,
    });

    return {
      key: criterion.key,
      criterion: criterion.label,
      weightPercentage: criterion.weightPercentage,
      achievementPercentage: round2(achievementPercentage),
      maxContribution,
      contribution,
      level: achievementInput.level || null,
      justification: String(achievementInput.justification || achievementInput.rationale || '').slice(0, 500),
    };
  });

  const total = round2(entries.reduce((sum, entry) => sum + entry.contribution, 0));
  return {
    valid: true,
    reason: '',
    total: round2(Math.min(total, Number(questionMaxMarks) || 0)),
    entries,
  };
};

export const buildCriterionReferenceKeys = (criteria = []) => (
  migrateLegacyCriteriaToWeights(criteria).criteria.map((entry, index) => ({
    criterionRef: entry.key || `criterion_${index + 1}`,
    name: entry.label,
    weightPercentage: entry.weightPercentage,
    description: entry.description || '',
    required: entry.required !== false,
  }))
);

export default {
  migrateLegacyCriteriaToWeights,
  validateRubricWeights,
  resolveCriterionMaxContribution,
  computeCriterionContribution,
  computeWeightedQuestionScore,
  buildCriterionReferenceKeys,
  resolvePerformanceAchievement,
};
