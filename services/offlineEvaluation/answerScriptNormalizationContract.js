export const NORMALIZER_INVALID_RESPONSE = 'ANSWER_SCRIPT_NORMALIZATION_INVALID_RESPONSE';
export const NORMALIZER_NO_PAGES = 'NO_PAGES';
export const NORMALIZER_INVALID_INPUT = 'NORMALIZATION_INVALID_INPUT';
export const NORMALIZER_FAILED = 'NORMALIZATION_FAILED';

export const SAFE_NORMALIZATION_MESSAGE = 'PDF processing failed while preparing page images.';

const preview = (value, limit = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

export const isCanonicalJsonObject = (text) => {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    return parsedObject(trimmed) !== null;
  } catch {
    return false;
  }
};

const parsedObject = (text) => {
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
};

export const validateNormalizerResult = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error(SAFE_NORMALIZATION_MESSAGE);
    error.code = NORMALIZER_INVALID_RESPONSE;
    error.safeMessage = SAFE_NORMALIZATION_MESSAGE;
    throw error;
  }
  if (parsed.error) {
    const error = new Error(String(parsed.error));
    error.code = parsed.errorType === 'ValueError' ? NORMALIZER_INVALID_INPUT : NORMALIZER_FAILED;
    error.safeMessage = SAFE_NORMALIZATION_MESSAGE;
    throw error;
  }
  if (!Array.isArray(parsed.pages) || parsed.pages.length < 1) {
    const error = new Error('Normalization produced no answer-sheet pages.');
    error.code = NORMALIZER_NO_PAGES;
    error.safeMessage = SAFE_NORMALIZATION_MESSAGE;
    throw error;
  }
  if (!parsed.normalizedPdf) {
    const error = new Error('Normalization did not return a working PDF path.');
    error.code = NORMALIZER_INVALID_RESPONSE;
    error.safeMessage = SAFE_NORMALIZATION_MESSAGE;
    throw error;
  }
  return parsed;
};

export const parseNormalizerStdout = ({ stdout, stderr = '', exitCode = 0 } = {}) => {
  const trimmed = String(stdout || '').trim();
  let parsed;
  try {
    parsed = parsedObject(trimmed);
  } catch (parseError) {
    const error = new Error(SAFE_NORMALIZATION_MESSAGE);
    error.code = NORMALIZER_INVALID_RESPONSE;
    error.safeMessage = SAFE_NORMALIZATION_MESSAGE;
    error.diagnostics = {
      exitCode,
      stdoutPreview: preview(trimmed),
      stderrPreview: preview(stderr, 500),
      parseError: parseError.message,
    };
    throw error;
  }
  if (!parsed) {
    const error = new Error(SAFE_NORMALIZATION_MESSAGE);
    error.code = NORMALIZER_INVALID_RESPONSE;
    error.safeMessage = SAFE_NORMALIZATION_MESSAGE;
    error.diagnostics = {
      exitCode,
      stdoutPreview: preview(trimmed),
      stderrPreview: preview(stderr, 500),
      parseError: 'Response was not a JSON object.',
    };
    throw error;
  }
  try {
    return validateNormalizerResult(parsed);
  } catch (error) {
    error.diagnostics = {
      ...(error.diagnostics || {}),
      exitCode,
      stdoutPreview: preview(trimmed),
      stderrPreview: preview(stderr, 500),
    };
    throw error;
  }
};
