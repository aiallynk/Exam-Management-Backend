import {
  buildImportLowCoverageError,
  buildQuestionImportDocumentMap,
} from './questionImportDocumentMapService.js';

const clean = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const IMPORT_NUMBER_MARKER_REGEX =
  /(?:^|\s)(?:q(?:uestion)?\s*)?\d{1,3}\s*[\).:\-]\s+/gi;

export const countNumberedQuestionMarkers = (value) => {
  const normalized = clean(value);
  if (!normalized) return 0;
  const matches = normalized.match(IMPORT_NUMBER_MARKER_REGEX);
  return Array.isArray(matches) ? matches.length : 0;
};

export const splitPdfTextIntoPages = (text, pageCount = 0) => {
  const source = String(text ?? '');
  if (!source.trim()) return [];

  if (source.includes('\f')) {
    const pages = source.split('\f').map((page) => page.trim()).filter(Boolean);
    if (pages.length > 1) return pages;
  }

  const pageBreakPattern = /(?:^|\n)\s*(?:page\s*)?(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:\n|$)/gi;
  const breaks = [...source.matchAll(pageBreakPattern)];
  if (breaks.length >= 2) {
    const pages = [];
    let lastIndex = 0;
    breaks.forEach((match, index) => {
      const breakIndex = match.index ?? 0;
      if (index === 0 && breakIndex > 0) {
        const prefix = source.slice(0, breakIndex).trim();
        if (prefix) pages.push(prefix);
      }
      const nextBreak = breaks[index + 1]?.index ?? source.length;
      const slice = source.slice(breakIndex, nextBreak).trim();
      if (slice) pages.push(slice);
      lastIndex = nextBreak;
    });
    if (lastIndex < source.length) {
      const tail = source.slice(lastIndex).trim();
      if (tail) pages.push(tail);
    }
    if (pages.length > 1) return pages;
  }

  if (pageCount > 1) {
    const approxSize = Math.ceil(source.length / pageCount);
    const pages = [];
    for (let index = 0; index < pageCount; index += 1) {
      const slice = source.slice(index * approxSize, (index + 1) * approxSize).trim();
      if (slice) pages.push(slice);
    }
    if (pages.length > 1) return pages;
  }

  return [source.trim()];
};

export const documentMapQuestionsToImportRows = (documentMap) =>
  (documentMap?.questions || []).map((question, index) => ({
    questionText: question.questionText,
    questionType: question.questionType,
    options: Array.isArray(question.options) ? question.options : [],
    correctAnswer: question.correctAnswer || '',
    points: question.points || 1,
    order: index,
    sourceRowIndex: index,
    sourceQuestionNumber: question.sourceQuestionNumber || null,
    parentQuestionNumber: question.parentQuestionNumber || null,
    subQuestionLabel: question.subQuestionLabel || null,
    sourcePages: question.sourcePages || [],
    groupType: question.groupType || 'ATOMIC_QUESTION',
    choiceGroupId: question.choiceGroupId || null,
    passage: question.passage || '',
    matchingPairs: question.matchingPairs || [],
    reviewRequired: Boolean(question.reviewRequired),
    confidence: question.confidence || 'MEDIUM',
    extractionWarnings: question.extractionWarnings || [],
    sourceImageRequired: Boolean(question.sourceImageRequired),
    drawingRequired: Boolean(question.drawingRequired),
    provenance: question.provenance || {},
    mediaRequirement: question.mediaRequirement || null,
    responseRequirement: question.drawingRequired ? 'Diagram required' : '',
    importProvenance: {
      sourcePages: question.sourcePages || [],
      sourceQuestionNumber: question.sourceQuestionNumber || null,
      groupType: question.groupType || 'ATOMIC_QUESTION',
    },
  }));

const PLACEHOLDER_HINT =
  /manual review required|scanned pdf page|imported scanned question|diagram\/manual review/i;

export const isPlaceholderImportRow = (row = {}) =>
  PLACEHOLDER_HINT.test(clean(row?.questionText || row?.question || ''));

export const isGiantDocumentQuestion = (row = {}, documentLength = 0) => {
  const text = clean(row?.questionText || row?.question || '');
  if (!text || !documentLength) return false;
  return text.length > documentLength * 0.55;
};

export const assessVisionCoverage = ({
  visionRowCount = 0,
  pageCount = 0,
  textLength = 0,
  markerCount = 0,
  documentMapCount = 0,
}) => {
  if (visionRowCount <= 0) return { authoritative: false, reason: 'no-vision-rows' };
  if (visionRowCount >= 2) return { authoritative: true, reason: 'multi-vision-rows' };
  if (pageCount <= 1 && markerCount <= 1 && documentMapCount <= 1) {
    return { authoritative: true, reason: 'single-page-document' };
  }
  if (documentMapCount >= 2 && visionRowCount < documentMapCount) {
    return { authoritative: false, reason: 'vision-undercovers-document-map' };
  }
  if (markerCount >= 2 && visionRowCount < markerCount) {
    return { authoritative: false, reason: 'vision-undercovers-numbered-markers' };
  }
  if (pageCount >= 2 && textLength >= 800) {
    return { authoritative: false, reason: 'single-vision-row-on-multi-page-document' };
  }
  return { authoritative: true, reason: 'default' };
};

export const reconcileImportQuestionCandidates = ({
  documentMapRows = [],
  numberedRows = [],
  structuredRows = [],
  visionRows = [],
  pageCount = 0,
  textLength = 0,
  markerCount = 0,
}) => {
  const sources = [
    { id: 'documentMap', rows: documentMapRows.filter((row) => !isPlaceholderImportRow(row)) },
    { id: 'numbered', rows: numberedRows.filter((row) => !isPlaceholderImportRow(row)) },
    { id: 'structured', rows: structuredRows.filter((row) => !isPlaceholderImportRow(row)) },
    { id: 'vision', rows: visionRows.filter((row) => !isPlaceholderImportRow(row)) },
  ].filter((source) => source.rows.length > 0);

  const ranked = [...sources].sort((left, right) => right.rows.length - left.rows.length);
  const primary = ranked[0] || { id: 'none', rows: [] };
  const secondary = ranked[1] || { id: 'none', rows: [] };

  let chosen = primary;
  if (
    primary.id === 'vision' &&
    primary.rows.length <= 1 &&
    (documentMapRows.length > primary.rows.length || numberedRows.length > primary.rows.length)
  ) {
    chosen = documentMapRows.length >= numberedRows.length
      ? { id: 'documentMap', rows: documentMapRows }
      : { id: 'numbered', rows: numberedRows };
  } else if (
    primary.id === 'structured' &&
    primary.rows.length <= 1 &&
    (documentMapRows.length > primary.rows.length || numberedRows.length > primary.rows.length)
  ) {
    chosen = documentMapRows.length >= numberedRows.length
      ? { id: 'documentMap', rows: documentMapRows }
      : { id: 'numbered', rows: numberedRows };
  }

  const merged = [];
  const seen = new Set();
  [...chosen.rows, ...secondary.rows].forEach((row) => {
    const fingerprint = key(row?.questionText || '');
    if (!fingerprint || seen.has(fingerprint) || isGiantDocumentQuestion(row, textLength)) return;
    seen.add(fingerprint);
    merged.push(row);
  });

  return {
    questions: merged.map((row, index) => ({ ...row, order: index })),
    primarySource: chosen.id,
    sourceCounts: Object.fromEntries(sources.map((source) => [source.id, source.rows.length])),
  };
};

export const buildImportExtractionReport = ({
  filename = '',
  pageCount = 0,
  textLength = 0,
  documentMap = null,
  reconciliation = null,
  extractionErrors = [],
  processingStages = [],
}) => ({
  filename,
  pageCount,
  extractedTextLength: textLength,
  pagesProcessed: documentMap?.diagnostics?.pagesSuccessfullyParsed ?? pageCount,
  deterministicCandidateCount: documentMap?.diagnostics?.deterministicCandidateCount ?? 0,
  acceptedCandidateCount: reconciliation?.questions?.length ?? 0,
  rejectedCandidateCount: documentMap?.diagnostics?.rejectedCandidateCount ?? 0,
  ignoredRegionCount: documentMap?.diagnostics?.ignoredRegionCount ?? 0,
  reviewRequiredCount: (reconciliation?.questions || []).filter((row) => row.reviewRequired).length,
  primarySource: reconciliation?.primarySource || 'none',
  sourceCounts: reconciliation?.sourceCounts || {},
  rejectionReasons: documentMap?.diagnostics?.rejectionReasons || {},
  lowCoverage: Boolean(documentMap?.diagnostics?.lowCoverage),
  processingStages,
  extractionErrors: Array.isArray(extractionErrors) ? extractionErrors : [],
  sections: documentMap?.sections || [],
});

export const assertImportCoverageOrThrow = ({
  documentMap,
  finalQuestions = [],
  pageCount = 0,
  textLength = 0,
}) => {
  const questionCount = finalQuestions.filter((row) => !isPlaceholderImportRow(row)).length;
  const lowCoverage =
    Boolean(documentMap?.diagnostics?.lowCoverage) ||
    (pageCount >= 2 && textLength >= 800 && questionCount <= 1) ||
    finalQuestions.some((row) => isGiantDocumentQuestion(row, textLength));

  if (!lowCoverage) return;

  throw buildImportLowCoverageError({
    ...documentMap,
    diagnostics: {
      ...(documentMap?.diagnostics || {}),
      lowCoverage: true,
      acceptedCandidateCount: questionCount,
      pageCount,
      extractedTextLength: textLength,
    },
  });
};

export const buildDocumentMapFromImportData = ({
  text = '',
  pageTexts = [],
  filename = '',
} = {}) => buildQuestionImportDocumentMap({ pageTexts, text, filename });
