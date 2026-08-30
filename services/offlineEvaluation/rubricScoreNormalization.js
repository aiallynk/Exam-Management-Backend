const normalizeText = (value) => String(value || '').trim().toLowerCase();

export const normalizeRubricCriterionScores = (scores = [], rubric = []) => {
  if (!Array.isArray(scores) || !scores.length) return null;
  const entries = scores.map((item, index) => {
    const rubricEntry = rubric[index] || rubric.find((entry) => (
      normalizeText(entry?.criterion) === normalizeText(item?.criterion)
      || normalizeText(entry?.label) === normalizeText(item?.criterion)
      || normalizeText(entry?.key) === normalizeText(item?.key)
    )) || {};
    const maxMarks = Number(
      item?.maxMarks ?? item?.maxScore ?? rubricEntry?.maxMarks ?? rubricEntry?.points ?? 0,
    ) || 0;
    const marks = Number(item?.marks ?? item?.score ?? 0) || 0;
    return {
      key: item?.key || rubricEntry?.key || `criterion-${index + 1}`,
      criterion: item?.criterion || item?.label || rubricEntry?.criterion || rubricEntry?.label || `Criterion ${index + 1}`,
      marks: Math.min(Math.max(0, marks), maxMarks || marks),
      maxMarks,
      comment: String(item?.comment || item?.rationale || item?.feedback || '').slice(0, 500),
      weight: Number(item?.weight ?? rubricEntry?.weight ?? 0) || 0,
    };
  });
  const total = entries.reduce((sum, item) => sum + Number(item.marks || 0), 0);
  return { entries, total };
};

export const buildRubricEvaluationPayload = ({ rubricScores, questionRubric = [], pointsEarned, overriddenBy = null, overrideReason = '' } = {}) => {
  const normalized = normalizeRubricCriterionScores(rubricScores, questionRubric);
  if (!normalized) return undefined;
  return {
    aiScores: normalized.entries,
    finalScores: normalized.entries,
    finalMark: Number(pointsEarned ?? normalized.total) || 0,
    overriddenBy: overriddenBy || null,
    overrideReason: overrideReason || '',
    updatedAt: new Date(),
  };
};

export const formatRubricRowsForAppendix = (answer, questionRubric = []) => {
  const normalized = normalizeRubricCriterionScores(
    answer?.rubricEvaluation?.finalScores || answer?.rubricEvaluation?.aiScores || answer?.aiEvaluation?.rubricScores,
    questionRubric,
  );
  if (!normalized) return { available: false, rows: [] };
  return {
    available: true,
    rows: normalized.entries.map((item) => ({
      criterion: item.criterion,
      marks: item.marks,
      maxMarks: item.maxMarks,
      comment: item.comment,
    })),
  };
};
