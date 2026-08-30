const clean = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export const MEDIA_REQUIREMENTS = Object.freeze({
  NO_VISUAL_REQUIRED: 'NO_VISUAL_REQUIRED',
  SOURCE_VISUAL_REQUIRED: 'SOURCE_VISUAL_REQUIRED',
  CANDIDATE_MUST_DRAW: 'CANDIDATE_MUST_DRAW',
  NEW_AI_VISUAL_REQUIRED: 'NEW_AI_VISUAL_REQUIRED',
  VISUAL_REQUIREMENT_UNCERTAIN: 'VISUAL_REQUIREMENT_UNCERTAIN',
});

const SOURCE_VISUAL = /\b(?:observe|refer to|study|look at)\b.{0,100}\b(?:diagram|figure|image|picture|graph|chart|table|map)\b|\b(?:diagram|figure|image|picture|graph|chart|map)\s+(?:below|given|shown|above)\b|\b(?:in|from)\s+the\s+(?:given|following|diagram|figure|image|graph|chart)\b|\b(?:shown|pictured|illustrated|depicted)\s+in\s+the\b/i;
const DRAWING_REQUIRED = /\b(?:draw|sketch|construct|make)\b.{0,80}\b(?:diagram|figure|graph|chart|map|ray|circuit)\b/i;
const PROVIDED_VISUAL_CONTEXT = /\b(?:study the diagram|observe the (?:diagram|image|figure)|refer to the (?:diagram|figure|image|graph)|using the figure|from the diagram shown|in the given image|picture shows|image shows|battery powers the bulb)\b/i;

export const parseMarksFromText = (value) => {
  const text = clean(value);
  if (!text) return null;
  const patterns = [
    /[\(\[](\d{1,3})\s*marks?[\)\]]\s*$/i,
    /[\(\[](\d{1,3})\s*mark[\)\]]\s*$/i,
    /[\(\[](\d{1,3})\s*[\)\]]\s*$/,
    /\b(\d{1,3})\s*marks?\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
};

export const stripMarksSuffix = (value) =>
  clean(String(value ?? '')
    .replace(/[\(\[]\s*\d{1,3}\s*marks?\s*[\)\]]\s*$/i, '')
    .replace(/[\(\[]\s*\d{1,3}\s*[\)\]]\s*$/i, '')
    .replace(/\b\d{1,3}\s*marks?\s*$/i, ''));

export const classifyImportMediaRequirement = (question = {}) => {
  if (question.mediaRequirement && MEDIA_REQUIREMENTS[question.mediaRequirement]) {
    return question.mediaRequirement;
  }
  if (question.newAiVisualRequested) {
    return MEDIA_REQUIREMENTS.NEW_AI_VISUAL_REQUIRED;
  }
  if (question.drawingRequired) {
    return MEDIA_REQUIREMENTS.CANDIDATE_MUST_DRAW;
  }
  if (question.sourceImageRequired) {
    return MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED;
  }

  const text = clean(question.questionText || question.question_text || '');
  if (!text) return MEDIA_REQUIREMENTS.NO_VISUAL_REQUIRED;

  const wantsDraw = DRAWING_REQUIRED.test(text);
  const wantsSourceVisual = (SOURCE_VISUAL.test(text) || PROVIDED_VISUAL_CONTEXT.test(text)) && !wantsDraw;

  if (wantsDraw) return MEDIA_REQUIREMENTS.CANDIDATE_MUST_DRAW;
  if (wantsSourceVisual) return MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED;

  if (Array.isArray(question.mediaCandidates) && question.mediaCandidates.some((item) => item?.required)) {
    return MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED;
  }

  return MEDIA_REQUIREMENTS.NO_VISUAL_REQUIRED;
};

export const shouldAttachSourceMedia = (mediaRequirement) =>
  mediaRequirement === MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED
  || mediaRequirement === MEDIA_REQUIREMENTS.VISUAL_REQUIREMENT_UNCERTAIN;

export const shouldAllowAiImageGeneration = ({
  mediaRequirement,
  aiImageGenerationEnabled = false,
  assessmentImageBudgetAvailable = true,
  questionLevelAttemptsAvailable = true,
  explicitGenerationRequest = false,
} = {}) =>
  explicitGenerationRequest
  && mediaRequirement === MEDIA_REQUIREMENTS.NEW_AI_VISUAL_REQUIRED
  && aiImageGenerationEnabled
  && assessmentImageBudgetAvailable
  && questionLevelAttemptsAvailable;

export const stripQuestionMediaFields = (question = {}) => {
  const next = { ...question };
  delete next.imageUrl;
  delete next.image_path;
  delete next.imagePath;
  delete next.imageBase64;
  delete next.image_base64;
  delete next.generatedImage;
  delete next.generated_image;
  delete next.image;
  return next;
};

export const applyImportMediaPolicy = (question = {}) => {
  const mediaRequirement = classifyImportMediaRequirement(question);
  const next = {
    ...question,
    mediaRequirement,
    sourceImageRequired: mediaRequirement === MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED,
    drawingRequired: mediaRequirement === MEDIA_REQUIREMENTS.CANDIDATE_MUST_DRAW,
  };

  if (mediaRequirement === MEDIA_REQUIREMENTS.NO_VISUAL_REQUIRED
    || mediaRequirement === MEDIA_REQUIREMENTS.CANDIDATE_MUST_DRAW) {
    return stripQuestionMediaFields(next);
  }

  if (mediaRequirement === MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED && !clean(next.imageUrl)) {
    next.reviewRequired = true;
    next.extractionWarnings = [
      ...(Array.isArray(next.extractionWarnings) ? next.extractionWarnings : []),
      'Source visual required but not yet attached — review before saving.',
    ];
  }

  if (mediaRequirement === MEDIA_REQUIREMENTS.VISUAL_REQUIREMENT_UNCERTAIN && !clean(next.imageUrl)) {
    next.reviewRequired = true;
  }

  return next;
};

export const validateImportQuestionMedia = (question = {}) => {
  const mediaRequirement = classifyImportMediaRequirement(question);
  const hasPersistedMedia = Boolean(
    clean(question.imageUrl)
    || clean(question.image_path)
    || clean(question.generatedImage)
    || clean(question.imageBase64)
  );

  if (mediaRequirement === MEDIA_REQUIREMENTS.NO_VISUAL_REQUIRED && hasPersistedMedia) {
    return { ok: false, reason: 'text-only-question-has-media' };
  }
  if (mediaRequirement === MEDIA_REQUIREMENTS.CANDIDATE_MUST_DRAW && hasPersistedMedia) {
    return { ok: false, reason: 'drawing-question-has-stimulus-media' };
  }
  if (mediaRequirement === MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED && !hasPersistedMedia) {
    return { ok: false, reason: 'missing-required-source-visual', reviewRequired: true };
  }
  if (hasPersistedMedia && clean(question.generatedImage) && mediaRequirement !== MEDIA_REQUIREMENTS.NEW_AI_VISUAL_REQUIRED) {
    return { ok: false, reason: 'unexpected-ai-generated-image' };
  }
  return { ok: true, mediaRequirement };
};

export const validateImportedMarks = (question = {}) => {
  const childMarks = Array.isArray(question.subQuestions)
    ? question.subQuestions.map((child) => Number(child.points) || 0).filter((value) => value > 0)
    : [];
  if (!childMarks.length) return { ok: true };
  const childTotal = childMarks.reduce((sum, value) => sum + value, 0);
  const declared = Number(question.points) || 0;
  if (declared > 0 && declared !== childTotal && childTotal >= 2) {
    return { ok: false, reason: 'marks-mismatch', declared, expected: childTotal };
  }
  return { ok: true, expected: childTotal || declared };
};

export const logImportMediaClassification = (questions = []) => {
  if (process.env.NODE_ENV !== 'development') return;
  questions.forEach((question, index) => {
    const mediaRequirement = classifyImportMediaRequirement(question);
    console.log('[question-import-debug] MEDIA CLASSIFICATION:', {
      index: index + 1,
      sourceQuestionNumber: question.sourceQuestionNumber || null,
      questionType: question.questionType || null,
      mediaRequirement,
      points: question.points || null,
      sourceVisualCandidates: Array.isArray(question.mediaCandidates) ? question.mediaCandidates.length : 0,
      sourceVisualAttached: Boolean(clean(question.imageUrl)),
      aiImageGeneration: Boolean(clean(question.generatedImage)),
    });
  });
};
