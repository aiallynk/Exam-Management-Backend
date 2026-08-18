export const JUNIOR_ALLOWED_QUESTION_TYPES = Object.freeze([
  'MULTIPLE_CHOICE',
  'MULTIPLE_OPTIONS',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'FILL_IN_THE_BLANK',
  'MATCHING',
  'NUMBER',
  'IMAGE_BASED',
]);

const ALLOWED_SET = new Set(JUNIOR_ALLOWED_QUESTION_TYPES);

export const isJuniorQuestionTypeAllowed = (questionType) =>
  ALLOWED_SET.has(String(questionType || '').trim().toUpperCase());

export const findUnsupportedJuniorQuestionType = (questionTypes = []) =>
  (Array.isArray(questionTypes) ? questionTypes : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .find((value) => !isJuniorQuestionTypeAllowed(value)) || null;

