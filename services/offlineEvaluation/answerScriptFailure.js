const SAFE_BY_CODE = {
  ANSWER_SCRIPT_NORMALIZATION_INVALID_RESPONSE: 'PDF processing failed while preparing page images.',
  NORMALIZATION_INVALID_INPUT: 'This file could not be read as an answer-sheet PDF.',
  NORMALIZATION_FAILED: 'PDF processing failed while preparing page images.',
  NO_PAGES: 'PDF processing failed while preparing page images.',
  SOURCE_UNREADABLE: 'The uploaded answer sheet could not be read from private storage.',
  FILE_TOO_LARGE: 'This answer sheet exceeds the configured file-size limit.',
  CHECKSUM_MISMATCH: 'The uploaded file does not match the registered checksum.',
  IDENTITY_INPUT_MISSING: 'Page images were prepared, but the first page is missing for student identification.',
  EXTRACTION_INPUT_MISSING: 'A prepared page image is missing, so answers could not be read.',
  AI_PROVIDER_UNAVAILABLE: 'Handwriting reading is unavailable because the vision provider is not configured.',
  AI_PROVIDER_TRANSIENT: 'Handwriting reading failed temporarily. Retry this answer sheet.',
  QUESTION_NOT_FOUND: 'A mapped question is no longer available on this assessment.',
  DERIVATIVE_FAILED: 'Review is complete, but the evaluated paper could not be generated.',
};

const STAGE_FROM_CODE = {
  ANSWER_SCRIPT_NORMALIZATION_INVALID_RESPONSE: 'NORMALIZING',
  NORMALIZATION_INVALID_INPUT: 'NORMALIZING',
  NORMALIZATION_FAILED: 'NORMALIZING',
  NO_PAGES: 'NORMALIZING',
  SOURCE_UNREADABLE: 'NORMALIZING',
  FILE_TOO_LARGE: 'NORMALIZING',
  CHECKSUM_MISMATCH: 'NORMALIZING',
  IDENTITY_INPUT_MISSING: 'IDENTIFYING_CANDIDATE',
  EXTRACTION_INPUT_MISSING: 'EXTRACTING',
  AI_PROVIDER_UNAVAILABLE: 'EXTRACTING',
  AI_PROVIDER_TRANSIENT: 'EXTRACTING',
  QUESTION_NOT_FOUND: 'EVALUATING',
  DERIVATIVE_FAILED: 'RENDERING_EVALUATED_PAPER',
};

const looksLikeParserGarbage = (message) => /unexpected token|is not valid json|json\.parse/i.test(String(message || ''));

export const educatorMessageForError = (error, stage = '') => {
  if (error?.safeMessage) return error.safeMessage;
  if (error?.code && SAFE_BY_CODE[error.code]) return SAFE_BY_CODE[error.code];
  if (looksLikeParserGarbage(error?.message) || String(stage || '').includes('NORMAL')) {
    return SAFE_BY_CODE.ANSWER_SCRIPT_NORMALIZATION_INVALID_RESPONSE;
  }
  return 'Answer-sheet processing failed. Retry this script, or open intake for support details.';
};

export const describeAnswerScriptFailure = (error, stage = '') => {
  const errorCode = error?.code || (looksLikeParserGarbage(error?.message) ? 'ANSWER_SCRIPT_NORMALIZATION_INVALID_RESPONSE' : 'ANSWER_SCRIPT_FAILED');
  const failureStage = stage || STAGE_FROM_CODE[errorCode] || 'PROCESSING';
  return {
    errorCode,
    failureStage,
    safeMessage: educatorMessageForError(error, failureStage),
    technicalMessage: String(error?.message || 'Answer-sheet processing failed.'),
    diagnostics: error?.diagnostics || null,
  };
};

export const applyAnswerScriptFailure = (script, error, stage = '') => {
  const described = describeAnswerScriptFailure(error, stage || script?.processingMeta?.stage);
  script.status = described.errorCode === 'DERIVATIVE_FAILED' ? 'DERIVATIVE_FAILED' : 'FAILED';
  script.errorCode = described.errorCode;
  script.failureStage = described.failureStage;
  script.safeMessage = described.safeMessage;
  script.statusReason = described.safeMessage;
  script.processingMeta = {
    ...script.processingMeta,
    stage: described.failureStage,
    lastError: described.technicalMessage,
    completedAt: new Date(),
    diagnostics: described.diagnostics,
  };
  return described;
};

export const clearAnswerScriptFailure = (script) => {
  script.errorCode = '';
  script.failureStage = '';
  script.safeMessage = '';
  script.statusReason = '';
  if (script.processingMeta) {
    script.processingMeta.lastError = '';
    script.processingMeta.diagnostics = null;
    script.processingMeta.completedAt = null;
  }
};
