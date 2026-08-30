import { validateRubricWeights } from './rubricWeightService.js';

// The delivered Question is the frozen assessment question in the existing
// Exam -> QuestionPaper -> Question spine. Newer questions may expose an
// explicit rubricSnapshot; older questions retain their frozen rubric in
// evaluationConfig.rubric. Keep that compatibility in one place.
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export const resolveQuestionRubric = (question = {}) => {
  if (hasOwn(question, 'rubricSnapshot') && question.rubricSnapshot !== null && question.rubricSnapshot !== undefined) {
    const snapshot = question.rubricSnapshot;
    return {
      configured: true,
      source: 'RUBRIC_SNAPSHOT',
      criteria: Array.isArray(snapshot) ? snapshot : (Array.isArray(snapshot?.criteria) ? snapshot.criteria : []),
    };
  }

  const config = question.evaluationConfig;
  if (config && typeof config === 'object' && hasOwn(config, 'rubric') && config.rubric !== null && config.rubric !== undefined) {
    return {
      configured: true,
      source: 'EVALUATION_CONFIG',
      criteria: Array.isArray(config.rubric) ? config.rubric : [],
    };
  }

  return { configured: false, source: 'NONE', criteria: [] };
};

/**
 * The only policy resolver for offline answer evaluation. A missing rubric is
 * a valid configuration state; an empty or malformed configured rubric is not.
 */
export const resolveEvaluationStrategy = (question = {}) => {
  const questionType = String(question.questionType || '').toUpperCase();
  const rubric = resolveQuestionRubric(question);

  if ([
    'MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'FILL_IN_THE_BLANK',
    'NUMBER', 'MATCHING',
  ].includes(questionType)) {
    return { scoringMode: 'DETERMINISTIC', rubric, reason: '' };
  }

  if (!rubric.configured) {
    return { scoringMode: 'AI_GENERAL_PROVISIONAL', rubric, reason: '' };
  }

  const validation = validateRubricWeights(rubric.criteria);
  if (!rubric.criteria.length || !validation.valid) {
    return {
      scoringMode: 'EVALUATION_FAILED',
      rubric,
      reason: validation.reason || 'RUBRIC_CONFIGURATION_ERROR',
    };
  }

  return { scoringMode: 'RUBRIC_BASED', rubric, reason: '' };
};

export default resolveEvaluationStrategy;
