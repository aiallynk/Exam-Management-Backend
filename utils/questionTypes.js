import { hasCodingConfiguration } from './codingQuestions.js';

const STORAGE_QUESTION_TYPES = [
  'MULTIPLE_CHOICE',
  'MULTIPLE_OPTIONS',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'FILL_IN_THE_BLANK',
  'MATCHING',
  'PARAGRAPH',
  'ESSAY',
  'ESSAY_LETTER',
  'ESSAY_STORY',
  'NUMBER',
  'CODING',
];

const QUESTION_FORMATS = [
  'MCQ',
  'IMAGE',
  'PARAGRAPH',
  'SCENARIO',
  'TRUE_FALSE',
  'FILL_IN_THE_BLANK',
  'MATCHING',
  'ESSAY',
  'ESSAY_LETTER',
  'ESSAY_STORY',
  'CODING',
];

const SCENARIO_HINT_REGEX =
  /\b(case study|scenario|situation|context|caselet|read the following|consider the following|based on the passage|based on the scenario)\b/i;

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeUpper = (value) => normalizeString(value).toUpperCase();
const normalizeFormatAlias = (value) => {
  const normalized = normalizeUpper(value);
  if (normalized === 'IMAGE_BASED') return 'IMAGE';
  if (normalized === 'CODE') return 'CODING';
  if (['LETTER_WRITING', 'LETTER'].includes(normalized)) return 'ESSAY_LETTER';
  if (['STORY_WRITING', 'STORY'].includes(normalized)) return 'ESSAY_STORY';
  return normalized;
};

const normalizeEssayTypeAlias = (value) => {
  const normalized = normalizeUpper(value);
  if (!normalized) return '';
  if (['LETTER_WRITING', 'LETTER', 'ESSAYLETTER'].includes(normalized)) {
    return 'ESSAY_LETTER';
  }
  if (['STORY_WRITING', 'STORY', 'ESSAYSTORY'].includes(normalized)) {
    return 'ESSAY_STORY';
  }
  if (['LONG_ANSWER', 'DESCRIPTIVE'].includes(normalized)) {
    return 'ESSAY';
  }
  if (['FILL_BLANK', 'FILL_IN_BLANK', 'FILLINTHEBLANK', 'FIB'].includes(normalized)) {
    return 'FILL_IN_THE_BLANK';
  }
  if (['MATCH', 'MATCH_THE_FOLLOWING', 'MATCHING_PAIRS'].includes(normalized)) {
    return 'MATCHING';
  }
  if (normalized === 'CODE') {
    return 'CODING';
  }
  return normalized;
};

const parseStructuredAnswerList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }

  const normalized = normalizeString(value);
  if (!normalized) return [];

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeString(item)).filter(Boolean);
    }
  } catch {
    // Fall through to delimiter split.
  }

  return normalized
    .split(/[,;|\n]/)
    .map((item) => normalizeString(item))
    .filter(Boolean);
};

const hasImagePayload = (payload = {}) =>
  [
    payload.imageUrl,
    payload.image_path,
    payload.imageBase64,
    payload.image_base64,
    payload.generatedImage,
    payload.generated_image,
    payload.image,
  ].some((value) => normalizeString(value));

const hasContextPayload = (payload = {}) =>
  Boolean(
    normalizeString(payload.passage) ||
      normalizeString(payload.paragraphGroupId) ||
      normalizeString(payload.paragraph_group_id)
  );

const inferObjectiveTypeFromOptions = (options = [], answer = '') => {
  const safeOptions = Array.isArray(options)
    ? options.map((option) => normalizeString(option)).filter(Boolean)
    : [];
  const safeAnswer = normalizeString(answer);
  const parsedAnswers = parseStructuredAnswerList(answer);

  if (safeOptions.length >= 2) {
    const lowerOptions = safeOptions.map((option) => option.toLowerCase());
    const isTrueFalse =
      safeOptions.length === 2 &&
      lowerOptions.includes('true') &&
      lowerOptions.includes('false');
    if (isTrueFalse) {
      return 'TRUE_FALSE';
    }
    if (parsedAnswers.length > 1) {
      return 'MULTIPLE_OPTIONS';
    }
    return 'MULTIPLE_CHOICE';
  }

  if (parsedAnswers.length > 1) {
    return 'MULTIPLE_OPTIONS';
  }

  if (/^(true|false|t|f)$/i.test(safeAnswer)) {
    return 'TRUE_FALSE';
  }

  return '';
};

export const isValidStorageQuestionType = (value) =>
  STORAGE_QUESTION_TYPES.includes(normalizeUpper(value));

export const isValidQuestionFormat = (value) => {
  const normalized = normalizeUpper(value);
  return QUESTION_FORMATS.includes(normalized) || normalized === 'IMAGE_BASED';
};

export const normalizeQuestionFormat = (payload = {}) => {
  const explicitFormat = normalizeFormatAlias(
    payload.questionFormat || payload.question_type || payload.type
  );
  const normalizedType = normalizeEssayTypeAlias(payload.questionType || payload.type);

  if (normalizedType === 'CODING') {
    return 'CODING';
  }

  if (['FILL_IN_THE_BLANK', 'MATCHING'].includes(normalizedType)) {
    return normalizedType;
  }

  if (['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY'].includes(normalizedType)) {
    return normalizedType;
  }

  if (normalizedType === 'IMAGE_BASED') {
    return 'IMAGE';
  }

  if (
    QUESTION_FORMATS.includes(explicitFormat) &&
    !(explicitFormat === 'CODING' && normalizedType && normalizedType !== 'CODING')
  ) {
    return explicitFormat;
  }

  if (!normalizedType && hasCodingConfiguration(payload)) {
    return 'CODING';
  }

  if (hasContextPayload(payload) || normalizedType === 'PARAGRAPH') {
    const scenarioHintSource = [
      payload.questionText,
      payload.question_text,
      payload.passage,
      payload.description,
    ]
      .map((value) => normalizeString(value))
      .filter(Boolean)
      .join(' ');

    return SCENARIO_HINT_REGEX.test(scenarioHintSource) ? 'SCENARIO' : 'PARAGRAPH';
  }

  if (normalizedType === 'TRUE_FALSE') {
    return 'TRUE_FALSE';
  }

  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'MCQ'].includes(normalizedType)) {
    return 'MCQ';
  }

  if (hasImagePayload(payload)) {
    return 'IMAGE';
  }

  return '';
};

export const normalizeQuestionTypeForStorage = (payload = {}) => {
  const normalizedType = normalizeEssayTypeAlias(payload.questionType || payload.type);
  const explicitFormat = normalizeFormatAlias(
    payload.questionFormat || payload.question_type || payload.type
  );
  const normalizedFormat = normalizeQuestionFormat(payload);
  const inferredObjectiveType = inferObjectiveTypeFromOptions(payload.options, payload.correctAnswer);

  if (STORAGE_QUESTION_TYPES.includes(normalizedType)) {
    return normalizedType;
  }

  if (['MULTI_SELECT_MCQ', 'MULTI_SELECT', 'MULTISELECT'].includes(normalizedType)) {
    return 'MULTIPLE_OPTIONS';
  }

  if (['FILL_BLANK', 'FILL_IN_BLANK', 'FILLINTHEBLANK', 'FIB'].includes(normalizedType)) {
    return 'FILL_IN_THE_BLANK';
  }

  if (['MATCH', 'MATCH_THE_FOLLOWING', 'MATCHING_PAIRS'].includes(normalizedType)) {
    return 'MATCHING';
  }

  if (
    normalizedFormat === 'CODING' ||
    (!normalizedType && !explicitFormat && hasCodingConfiguration(payload))
  ) {
    return 'CODING';
  }

  if (normalizedType === 'MCQ') {
    return 'MULTIPLE_CHOICE';
  }

  if (normalizedType === 'IMAGE' || normalizedType === 'IMAGE_BASED') {
    return inferredObjectiveType || 'MULTIPLE_CHOICE';
  }

  if (normalizedType === 'SCENARIO') {
    return inferredObjectiveType || 'PARAGRAPH';
  }

  if (['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY'].includes(normalizedFormat)) {
    return normalizedFormat;
  }

  if (normalizedFormat === 'TRUE_FALSE') {
    return 'TRUE_FALSE';
  }

  if (normalizedFormat === 'IMAGE') {
    return inferredObjectiveType || 'MULTIPLE_CHOICE';
  }

  if (normalizedFormat === 'SCENARIO') {
    return inferredObjectiveType || 'PARAGRAPH';
  }

  if (normalizedFormat === 'PARAGRAPH' && inferredObjectiveType) {
    return inferredObjectiveType;
  }

  if (inferredObjectiveType) {
    return inferredObjectiveType;
  }

  if (hasContextPayload(payload)) {
    return 'PARAGRAPH';
  }

  if (/^-?\d+(?:\.\d+)?$/.test(normalizeString(payload.correctAnswer))) {
    return 'NUMBER';
  }

  return 'SHORT_ANSWER';
};

export const questionTypeMetadata = {
  STORAGE_QUESTION_TYPES,
  QUESTION_FORMATS,
};
