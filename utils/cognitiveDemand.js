// Cognitive demand (LOT/MOT/HOT) — Blueprint section 4B. Three independent
// question dimensions exist: cognitiveDemand (LOT/MOT/HOT), bloomLevel
// (REMEMBER..CREATE), and difficulty (EASY/MEDIUM/HARD). They are never
// synonyms and never inferred from one another as if they were. AI never
// invents the Bloom-to-cognitive-demand mapping or the target distribution
// — this module is the single place the application resolves both, and
// cognitiveDemand on a generated/imported question is always derived here
// from bloomLevel + the resolved mapping, never trusted verbatim from an
// AI-provided cognitiveDemand label.

export const COGNITIVE_DEMAND_LEVELS = Object.freeze(['LOT', 'MOT', 'HOT']);

export const BLOOM_LEVELS = Object.freeze(['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE']);

export const COGNITIVE_DEMAND_DESCRIPTIONS = Object.freeze({
  LOT: 'Recall and basic understanding',
  MOT: 'Application and analytical use',
  HOT: 'Evaluation, reasoning and creation',
});

// Institutions legitimately disagree on where ANALYZE sits — this is a
// starting default only. A framework's own cognitiveDemandMapping always
// wins when present (resolveCognitiveDemandMapping below).
export const DEFAULT_COGNITIVE_DEMAND_MAPPING = Object.freeze({
  LOT: ['REMEMBER', 'UNDERSTAND'],
  MOT: ['APPLY', 'ANALYZE'],
  HOT: ['EVALUATE', 'CREATE'],
});

const isValidMapping = (mapping) => {
  if (!mapping || typeof mapping !== 'object') return false;
  const seen = new Set();
  for (const level of COGNITIVE_DEMAND_LEVELS) {
    const entries = mapping[level];
    if (!Array.isArray(entries) || !entries.length) return false;
    for (const bloom of entries) {
      if (!BLOOM_LEVELS.includes(bloom)) return false;
      if (seen.has(bloom)) return false; // a Bloom level must map to exactly one cognitive demand
      seen.add(bloom);
    }
  }
  return true;
};

// A framework's FrameworkVersion.rules.cognitiveDemandMapping overrides the
// built-in default (Blueprint section 4B / Part B). Falls back to the
// default on anything malformed rather than throwing — a bad mapping must
// never block resolution of an otherwise-valid framework.
export const resolveCognitiveDemandMapping = (rules = {}) => {
  const candidate = rules?.cognitiveDemandMapping;
  return isValidMapping(candidate) ? candidate : DEFAULT_COGNITIVE_DEMAND_MAPPING;
};

const buildBloomToCognitiveIndex = (mapping) => {
  const index = {};
  COGNITIVE_DEMAND_LEVELS.forEach((level) => {
    (mapping[level] || []).forEach((bloom) => { index[bloom] = level; });
  });
  return index;
};

// The single authoritative way a question's cognitiveDemand is computed
// from its bloomLevel. Returns null (not a guess) when bloomLevel is
// missing/unrecognized — callers must not fabricate a value.
export const deriveCognitiveDemandFromBloom = (bloomLevel, mapping = DEFAULT_COGNITIVE_DEMAND_MAPPING) => {
  if (!bloomLevel || !BLOOM_LEVELS.includes(bloomLevel)) return null;
  const resolvedMapping = isValidMapping(mapping) ? mapping : DEFAULT_COGNITIVE_DEMAND_MAPPING;
  return buildBloomToCognitiveIndex(resolvedMapping)[bloomLevel] || null;
};

// { LOT, MOT, HOT } must sum to exactly 100 when a percentage distribution
// is supplied — rejected, never silently normalized (Part C).
export const validateCognitiveDemandDistribution = (distribution) => {
  if (!distribution || typeof distribution !== 'object') {
    return { valid: false, error: 'Cognitive demand distribution must be an object with LOT, MOT, and HOT percentages.' };
  }
  const values = COGNITIVE_DEMAND_LEVELS.map((level) => Number(distribution[level]));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return { valid: false, error: 'LOT, MOT, and HOT must each be a non-negative number.' };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.round(sum) !== 100) {
    return { valid: false, error: `LOT + MOT + HOT must equal 100 (received ${sum}).` };
  }
  return { valid: true, error: null };
};

// Largest-remainder apportionment — same style as
// services/responseDistributionService.js#computeBalancedSplit — so
// percentages that don't divide evenly still sum to exactly `count`.
const apportion = (percentagesByKey, count) => {
  const keys = Object.keys(percentagesByKey);
  const raw = keys.map((key) => ({ key, exact: (Number(percentagesByKey[key]) || 0) / 100 * count }));
  const base = raw.map((entry) => ({ key: entry.key, count: Math.floor(entry.exact), remainder: entry.exact - Math.floor(entry.exact) }));
  let assigned = base.reduce((total, entry) => total + entry.count, 0);
  const byRemainder = [...base].sort((a, b) => b.remainder - a.remainder);
  let cursor = 0;
  while (assigned < count && byRemainder.length) {
    byRemainder[cursor % byRemainder.length].count += 1;
    assigned += 1;
    cursor += 1;
  }
  return Object.fromEntries(base.map((entry) => [entry.key, entry.count]));
};

// Turns a paper-level { LOT, MOT, HOT } percentage target into concrete
// per-Bloom-level question counts the generation prompt can state
// explicitly (e.g. "3 REMEMBER, 2 UNDERSTAND, 4 APPLY, 1 EVALUATE") — each
// cognitive-demand bucket's count is split evenly across its mapped Bloom
// levels. Buckets/levels with zero count are omitted.
export const buildBloomTargetsFromCognitiveDistribution = ({ distribution, mapping = DEFAULT_COGNITIVE_DEMAND_MAPPING, count }) => {
  const safeCount = Math.max(0, Number.parseInt(count, 10) || 0);
  if (!safeCount) return [];
  const resolvedMapping = isValidMapping(mapping) ? mapping : DEFAULT_COGNITIVE_DEMAND_MAPPING;
  const perLevelCounts = apportion(
    Object.fromEntries(COGNITIVE_DEMAND_LEVELS.map((level) => [level, distribution?.[level] ?? 0])),
    safeCount
  );
  const targets = [];
  COGNITIVE_DEMAND_LEVELS.forEach((level) => {
    const levelCount = perLevelCounts[level] || 0;
    if (!levelCount) return;
    const bloomLevels = resolvedMapping[level] || [];
    if (!bloomLevels.length) return;
    const perBloom = apportion(Object.fromEntries(bloomLevels.map((bloom) => [bloom, 100 / bloomLevels.length])), levelCount);
    bloomLevels.forEach((bloom) => {
      if (perBloom[bloom] > 0) targets.push({ bloomLevel: bloom, cognitiveDemand: level, count: perBloom[bloom] });
    });
  });
  return targets;
};

// Target-vs-actual diagnostics, mirroring
// utils/questionTypeRegistry.js#computeDistributionDiagnostics's shape —
// only counts questions whose cognitiveDemand is known (derived from a
// recognized bloomLevel); a question with no bloomLevel/cognitiveDemand is
// excluded from "generated" counts rather than guessed into a bucket.
export const computeCognitiveDemandDiagnostics = ({ targetDistribution, questions, mapping = DEFAULT_COGNITIVE_DEMAND_MAPPING }) => {
  const resolvedMapping = isValidMapping(mapping) ? mapping : DEFAULT_COGNITIVE_DEMAND_MAPPING;
  const generatedCounts = { LOT: 0, MOT: 0, HOT: 0 };
  let classifiedCount = 0;
  (Array.isArray(questions) ? questions : []).forEach((question) => {
    const cognitiveDemand = question?.cognitiveDemand && COGNITIVE_DEMAND_LEVELS.includes(question.cognitiveDemand)
      ? question.cognitiveDemand
      : deriveCognitiveDemandFromBloom(question?.bloomLevel, resolvedMapping);
    if (cognitiveDemand) {
      generatedCounts[cognitiveDemand] += 1;
      classifiedCount += 1;
    }
  });
  const totalQuestions = Array.isArray(questions) ? questions.length : 0;
  const generatedPercentages = COGNITIVE_DEMAND_LEVELS.reduce((acc, level) => {
    acc[level] = classifiedCount ? Math.round((generatedCounts[level] / classifiedCount) * 100) : 0;
    return acc;
  }, {});
  let validationStatus = 'unspecified';
  if (targetDistribution) {
    if (classifiedCount === 0) {
      validationStatus = 'unclassified';
    } else {
      const withinTolerance = COGNITIVE_DEMAND_LEVELS.every((level) => Math.abs(generatedPercentages[level] - (Number(targetDistribution[level]) || 0)) <= 15);
      validationStatus = withinTolerance ? 'valid' : 'mismatch';
    }
  }
  return {
    target: targetDistribution || null,
    generatedCounts,
    generatedPercentages,
    classifiedCount,
    unclassifiedCount: totalQuestions - classifiedCount,
    totalQuestions,
    validationStatus,
  };
};
