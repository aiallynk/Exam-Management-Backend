const normalizeText = (value) => String(value || '').trim().toLowerCase();

const finiteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const criterionIds = (entry = {}) => [
  entry.key,
  entry.id,
  entry.criterionId,
  entry.criterion,
  entry.label,
].map(normalizeText).filter(Boolean);

const criterionMaximum = (entry = {}) => finiteNumber(
  entry.maxMarks ?? entry.maxScore ?? entry.points,
);

const awardedMarks = (entry = {}) => finiteNumber(entry.marks ?? entry.score);

const findScoreForCriterion = (scores, rubricEntry, index) => {
  const ids = new Set(criterionIds(rubricEntry));
  const byIdentifier = scores.find((score) => criterionIds(score).some((id) => ids.has(id)));
  if (byIdentifier) return byIdentifier;

  // Older stored overrides were positional and carried no criterion id/key.
  // Retain that compatibility only when there is no conflicting identity.
  const positional = scores[index];
  return positional && criterionIds(positional).length === 0 ? positional : null;
};

export const normalizeRubricCriterionScores = (scores = [], rubric = []) => {
  if (!Array.isArray(scores) || !scores.length) return null;
  const configured = Array.isArray(rubric) ? rubric : [];

  if (configured.length) {
    const entries = configured.map((rubricEntry, index) => {
      const score = findScoreForCriterion(scores, rubricEntry, index);
      const marks = awardedMarks(score);
      const maxMarks = criterionMaximum(rubricEntry) ?? criterionMaximum(score);
      if (!score || marks == null || maxMarks == null || maxMarks < 0 || marks < 0 || marks > maxMarks + 0.001) return null;
      return {
        key: score.key || rubricEntry.key || rubricEntry.id || `criterion-${index + 1}`,
        criterion: rubricEntry.criterion || rubricEntry.label || score.criterion || score.label || `Criterion ${index + 1}`,
        marks,
        maxMarks,
        comment: String(score.comment || score.rationale || score.feedback || '').slice(0, 500),
        weight: finiteNumber(score.weight ?? rubricEntry.weight) ?? 0,
      };
    });
    if (entries.some((entry) => !entry)) return null;
    return { entries, total: entries.reduce((sum, item) => sum + item.marks, 0) };
  }

  const entries = scores.map((score, index) => {
    const marks = awardedMarks(score);
    const maxMarks = criterionMaximum(score);
    if (marks == null || maxMarks == null || maxMarks < 0 || marks < 0 || marks > maxMarks + 0.001) return null;
    return {
      key: score.key || score.id || `criterion-${index + 1}`,
      criterion: score.criterion || score.label || `Criterion ${index + 1}`,
      marks,
      maxMarks,
      comment: String(score.comment || score.rationale || score.feedback || '').slice(0, 500),
      weight: finiteNumber(score.weight) ?? 0,
    };
  });
  if (entries.some((entry) => !entry)) return null;
  return { entries, total: entries.reduce((sum, item) => sum + item.marks, 0) };
};

export const buildRubricEvaluationPayload = ({ rubricScores, questionRubric = [], pointsEarned, overriddenBy = null, overrideReason = '' } = {}) => {
  const normalized = normalizeRubricCriterionScores(rubricScores, questionRubric);
  if (!normalized) return undefined;
  return {
    aiScores: normalized.entries,
    finalScores: normalized.entries,
    finalMark: finiteNumber(pointsEarned) ?? normalized.total,
    overriddenBy: overriddenBy || null,
    overrideReason: overrideReason || '',
    updatedAt: new Date(),
  };
};

const sameMarks = (left, right) => Math.abs(Number(left) - Number(right)) < 0.001;

const populatedScoreArray = (value) => Array.isArray(value) && value.length > 0;

// A breakdown is supplementary evidence for the one authoritative question
// mark. Never turn missing/mismatched data into a row of plausible zeroes.
export const formatRubricRowsForAppendix = (answer, questionRubric = []) => {
  const finalScores = answer?.rubricEvaluation?.finalScores;
  const aiScores = answer?.rubricEvaluation?.aiScores;
  const legacyScores = answer?.aiEvaluation?.rubricScores;
  const candidates = [
    { source: 'FINAL', scores: finalScores },
    { source: 'AI', scores: aiScores },
    { source: 'AI', scores: legacyScores },
  ];
  const authoritativeMark = finiteNumber(answer?.pointsEarned);
  const explicitQuestionOverride = Boolean(
    answer?.rubricEvaluation?.overriddenBy || answer?.rubricEvaluation?.overrideReason,
  );
  let foundMalformed = false;

  for (const candidate of candidates) {
    if (!populatedScoreArray(candidate.scores)) continue;
    const normalized = normalizeRubricCriterionScores(candidate.scores, questionRubric);
    if (!normalized) {
      foundMalformed = true;
      continue;
    }
    if (authoritativeMark != null && !sameMarks(normalized.total, authoritativeMark)) {
      return {
        available: false,
        rows: [],
        source: candidate.source,
        reason: explicitQuestionOverride ? 'QUESTION_LEVEL_OVERRIDE' : 'FINAL_SCORE_MISMATCH',
      };
    }
    return {
      available: true,
      source: candidate.source,
      rows: normalized.entries.map((item) => ({
        criterion: item.criterion,
        marks: item.marks,
        maxMarks: item.maxMarks,
        comment: item.comment,
      })),
    };
  }

  return {
    available: false,
    rows: [],
    source: '',
    reason: explicitQuestionOverride ? 'QUESTION_LEVEL_OVERRIDE' : foundMalformed ? 'MALFORMED' : 'UNAVAILABLE',
  };
};
