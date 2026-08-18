const OPTION_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Teacher editions often encode a visually highlighted answer into the PDF
// text layer as a trailing tag (for example, "B. Hesitant [CORRECT]"). That
// tag is metadata for the importer, never part of what a candidate should
// see as an option. Keep this deliberately narrow so a legitimate option
// containing the word "correct" is not changed.
const TRAILING_ANSWER_MARKER_PATTERN =
  /\s*(?:\[\s*(?:correct(?:\s+answer)?|right\s+answer|answer)\s*\]|\(\s*(?:correct(?:\s+answer)?|right\s+answer)\s*\))\s*$/i;

const normalizeWhitespace = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
};

const buildIndexedOptionLabelPattern = (label) =>
  new RegExp(`^\\s*(?:\\(${label}\\)\\s*|${label}\\s*[\\)\\.\\:\\-]\\s*)`, 'i');

const ANY_OPTION_LABEL_PATTERN = /^\s*(?:\([A-Z]\)\s*|[A-Z]\s*[\)\.\:\-]\s*)/i;

const stripIndexedOptionLabel = (value, index) => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return '';
  }

  const label = OPTION_LABELS[index];
  if (!label) {
    return normalized;
  }

  return normalized.replace(buildIndexedOptionLabelPattern(label), '').trim();
};

const stripAnyOptionLabel = (value) => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return '';
  }

  return normalized.replace(ANY_OPTION_LABEL_PATTERN, '').trim();
};

const hasIndexedOptionLabel = (value, index) => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }

  const label = OPTION_LABELS[index];
  if (!label) {
    return false;
  }

  return buildIndexedOptionLabelPattern(label).test(normalized);
};

const shouldStripIndexedOptionLabels = (options) => {
  const list = Array.isArray(options) ? options : [];
  if (list.length < 2) {
    return false;
  }

  const labeledCount = list.reduce(
    (count, option, index) => count + (hasIndexedOptionLabel(option, index) ? 1 : 0),
    0
  );

  return labeledCount >= Math.min(2, list.length);
};

export const sanitizeQuestionOptionText = (value) =>
  normalizeWhitespace(value).replace(TRAILING_ANSWER_MARKER_PATTERN, '').trim();

export const sanitizeIndexedQuestionOptionText = (value, index) =>
  sanitizeQuestionOptionText(stripIndexedOptionLabel(value, index));

export const sanitizeQuestionOptions = (value) => {
  const list = Array.isArray(value) ? value : [];
  const stripIndexedLabels = shouldStripIndexedOptionLabels(list);

  return Array.from(
    new Set(
      list
        .map((option, index) =>
          stripIndexedLabels ? stripIndexedOptionLabel(option, index) : sanitizeQuestionOptionText(option)
        )
        .map((option) => sanitizeQuestionOptionText(option))
        .filter(Boolean)
    )
  );
};

export const parseQuestionMultiAnswer = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeQuestionOptionText(item)).filter(Boolean);
  }

  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => sanitizeQuestionOptionText(item)).filter(Boolean);
    }
  } catch {
    // Fall through to delimiter parsing.
  }

  return normalized
    .split(/[,;|\n]/)
    .map((item) => sanitizeQuestionOptionText(item))
    .filter(Boolean);
};

const resolveOptionIndex = (value, options) => {
  const list = Array.isArray(options) ? options : [];
  const normalized = normalizeWhitespace(value);
  if (!normalized || !list.length) {
    return -1;
  }

  if (/^\d+$/.test(normalized)) {
    const numericIndex = Number.parseInt(normalized, 10) - 1;
    if (numericIndex >= 0 && numericIndex < list.length) {
      return numericIndex;
    }
  }

  if (/^[A-Z]$/i.test(normalized)) {
    const alphaIndex = normalized.toUpperCase().charCodeAt(0) - 65;
    if (alphaIndex >= 0 && alphaIndex < list.length) {
      return alphaIndex;
    }
  }

  return -1;
};

// Extracts the first numeric token from arbitrary text — handles a plain
// number, a negative/decimal value, scientific notation, or a number
// embedded in text such as "42 cm" or "Answer: -3.5". Returns '' (never a
// non-numeric string) when nothing numeric can be found, so a NUMBER
// question's correctAnswer can never silently end up as MCQ-shaped text
// like "Option A" — the caller must treat '' as "invalid for this type",
// not paper over it.
const parseNumericAnswer = (value) => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  const match = normalized.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) return '';
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? String(numeric) : '';
};

const resolveObjectiveAnswerValue = (answer, options, { allowFallbackToFirst = false } = {}) => {
  const list = Array.isArray(options) ? options : [];
  const normalized = normalizeWhitespace(answer);
  if (!normalized) {
    return '';
  }

  const sanitized = sanitizeQuestionOptionText(stripAnyOptionLabel(normalized)) || normalized;
  if (list.includes(sanitized)) {
    return sanitized;
  }

  const resolvedIndex = resolveOptionIndex(normalized, list);
  if (resolvedIndex >= 0) {
    return list[resolvedIndex];
  }

  return allowFallbackToFirst ? list[0] || sanitized : sanitized;
};

export const normalizeQuestionCorrectAnswer = ({
  questionType,
  correctAnswer,
  options = [],
}) => {
  const normalizedType = normalizeWhitespace(questionType).toUpperCase();
  const sanitizedOptions = sanitizeQuestionOptions(options);

  if (normalizedType === 'MULTIPLE_OPTIONS') {
    return Array.from(
      new Set(
        parseQuestionMultiAnswer(correctAnswer)
          .map((answer) => resolveObjectiveAnswerValue(answer, sanitizedOptions))
          .filter(Boolean)
      )
    );
  }

  if (normalizedType === 'TRUE_FALSE') {
    const normalized = normalizeWhitespace(correctAnswer).toLowerCase();
    return normalized.startsWith('f') ? 'False' : 'True';
  }

  if (normalizedType === 'MULTIPLE_CHOICE' || normalizedType === 'IMAGE_BASED') {
    return resolveObjectiveAnswerValue(correctAnswer, sanitizedOptions, {
      allowFallbackToFirst: true,
    });
  }

  if (normalizedType === 'NUMBER') {
    return parseNumericAnswer(correctAnswer);
  }

  return normalizeWhitespace(correctAnswer);
};

export { parseNumericAnswer };
