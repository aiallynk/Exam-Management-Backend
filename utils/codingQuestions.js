const SUPPORTED_CODING_LANGUAGES = ['python', 'java', 'cpp', 'javascript'];
const SUPPORTED_CODING_DIFFICULTIES = ['easy', 'medium', 'hard'];
const DEFAULT_CODING_TIME_LIMIT_SECONDS = 2;
const DEFAULT_CODING_MEMORY_LIMIT_MB = 128;

const LANGUAGE_ALIASES = {
  python: 'python',
  py: 'python',
  python3: 'python',
  java: 'java',
  cpp: 'cpp',
  'c++': 'cpp',
  'c++17': 'cpp',
  'c++20': 'cpp',
  cxx: 'cpp',
  javascript: 'javascript',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  'node.js': 'javascript',
};

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

export const normalizeCodingLanguage = (value) => {
  const normalized = normalizeString(value).toLowerCase().replace(/\s+/g, '');
  return LANGUAGE_ALIASES[normalized] || '';
};

export const normalizeCodingLanguages = (value) => {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;|\n]/)
      : [];

  return values
    .map((item) => normalizeCodingLanguage(item))
    .filter((item, index, items) => SUPPORTED_CODING_LANGUAGES.includes(item) && items.indexOf(item) === index);
};

export const normalizeCodingDifficulty = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_CODING_DIFFICULTIES.includes(normalized) ? normalized : 'medium';
};

export const normalizeCodingCategory = (value) => normalizeString(value);

export const normalizeCodingStarterCode = (value, languages = []) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};

  Object.entries(source).forEach(([language, code]) => {
    const normalizedLanguage = normalizeCodingLanguage(language);
    if (!normalizedLanguage) return;
    normalized[normalizedLanguage] = normalizeString(code);
  });

  const safeLanguages = normalizeCodingLanguages(languages);
  safeLanguages.forEach((language) => {
    if (!Object.prototype.hasOwnProperty.call(normalized, language)) {
      normalized[language] = '';
    }
  });

  return normalized;
};

export const normalizeCodingTestCases = (value) => {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const input = normalizeString(item.input);
      const expectedOutput = normalizeString(
        item.expectedOutput ?? item.output ?? item.expected ?? item.expected_output
      );

      if (!input && !expectedOutput) {
        return null;
      }

      const hidden = Boolean(item.hidden);

      return {
        input,
        expectedOutput,
        hidden,
        isSample: !hidden && Boolean(item.isSample),
      };
    })
    .filter(Boolean);

  const hasVisibleSample = normalized.some((item) => !item.hidden && item.isSample);
  if (!hasVisibleSample) {
    const firstVisibleCase = normalized.find((item) => !item.hidden);
    if (firstVisibleCase) {
      firstVisibleCase.isSample = true;
    }
  }

  return normalized;
};

export const extractCodingFields = (payload = {}) => {
  const source = payload?.codingFields && typeof payload.codingFields === 'object'
    ? payload.codingFields
    : {};
  const languages = normalizeCodingLanguages(payload.languages ?? source.languages);
  const starterCode = normalizeCodingStarterCode(
    payload.starterCode ?? source.starterCode,
    languages
  );
  const testCases = normalizeCodingTestCases(payload.testCases ?? source.testCases);
  const timeLimitCandidate = Number(payload.timeLimit ?? source.timeLimit);
  const timeLimit = Number.isFinite(timeLimitCandidate) && timeLimitCandidate > 0
    ? Math.floor(timeLimitCandidate)
    : DEFAULT_CODING_TIME_LIMIT_SECONDS;
  const memoryLimitCandidate = Number(payload.memoryLimit ?? source.memoryLimit);
  const memoryLimit = Number.isFinite(memoryLimitCandidate) && memoryLimitCandidate > 0
    ? Math.floor(memoryLimitCandidate)
    : DEFAULT_CODING_MEMORY_LIMIT_MB;

  return {
    difficulty: normalizeCodingDifficulty(payload.difficulty ?? source.difficulty),
    category: normalizeCodingCategory(payload.category ?? source.category),
    languages,
    starterCode,
    testCases,
    timeLimit,
    memoryLimit,
  };
};

export const getVisibleCodingTestCases = (payload = {}) =>
  extractCodingFields(payload).testCases.filter((testCase) => !testCase.hidden);

export const getCodingExampleCase = (payload = {}) => {
  const codingFields = extractCodingFields(payload);
  const visibleTestCases = codingFields.testCases.filter((testCase) => !testCase.hidden);
  return (
    visibleTestCases.find((testCase) => testCase.isSample) ||
    visibleTestCases[0] ||
    codingFields.testCases[0] ||
    null
  );
};

export const hasCodingConfiguration = (payload = {}) => {
  const normalizedType = normalizeString(
    payload.questionType || payload.questionFormat || payload.question_type || payload.type
  ).toUpperCase();

  if (normalizedType === 'CODING') {
    return true;
  }

  const codingFields = extractCodingFields(payload);
  const source = payload?.codingFields && typeof payload.codingFields === 'object'
    ? payload.codingFields
    : {};
  const hasExplicitTimeLimit = payload.timeLimit !== undefined || source.timeLimit !== undefined;
  const hasExplicitMemoryLimit = payload.memoryLimit !== undefined || source.memoryLimit !== undefined;
  const hasMeaningfulStarterCode = Object.values(codingFields.starterCode || {}).some(
    (code) => normalizeString(code).length > 0
  );
  const hasMeaningfulResourceLimits =
    (hasExplicitTimeLimit &&
      Number.isFinite(Number(payload.timeLimit ?? source.timeLimit)) &&
      Number(payload.timeLimit ?? source.timeLimit) > 0 &&
      Number(payload.timeLimit ?? source.timeLimit) !== DEFAULT_CODING_TIME_LIMIT_SECONDS) ||
    (hasExplicitMemoryLimit &&
      Number.isFinite(Number(payload.memoryLimit ?? source.memoryLimit)) &&
      Number(payload.memoryLimit ?? source.memoryLimit) > 0 &&
      Number(payload.memoryLimit ?? source.memoryLimit) !== DEFAULT_CODING_MEMORY_LIMIT_MB);

  return Boolean(
    codingFields.languages.length ||
      hasMeaningfulStarterCode ||
      codingFields.testCases.length ||
      hasMeaningfulResourceLimits
  );
};

export const getSupportedCodingLanguages = () => [...SUPPORTED_CODING_LANGUAGES];
export const getSupportedCodingDifficulties = () => [...SUPPORTED_CODING_DIFFICULTIES];
