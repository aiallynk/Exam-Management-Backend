import { normalizeQuestionType } from '../utils/questionTypeRegistry.js';
import { classifyImportMediaRequirement, parseMarksFromText, stripMarksSuffix } from './questionImportMediaService.js';

// This module is deliberately an in-memory representation.  It is the
// boundary between a source document and question drafts: callers may retain
// the provenance on the draft, but a DocumentMap is never a new business
// entity or a reason to persist unreviewed extraction data.

const clean = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const QUESTION_START = /^(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.:)\-]\s+(.+)$/i;
const EXPLICIT_SUBQUESTION_START = /^(?:q(?:uestion)?\s*)?(\d{1,3})\s*\(\s*([a-z]|[ivxlcdm]+)\s*\)\s*[.:)\-]?\s*(.+)$/i;
const BARE_SUBQUESTION_START = /^\(\s*([a-z]|[ivxlcdm]+)\s*\)\s*[.:)\-]?\s*(.+)$/i;
const ROMAN_SUBQUESTION_START = /^([ivxlcdm]+)\.\s+(.+)$/i;
const OPTION_START = /^(?:\(?\s*)?([a-h])\s*(?:\)|\.|:|-)(?:\s+)(.+)$/i;
const PAGE_CHROME = /^(?:page\s*)?\d+\s*(?:of|\/)\s*\d+\s*$/i;
const METADATA = /^(?:maximum\s+marks?|max\.?\s*marks?|time\s*(?:allowed|limit)?|duration|date|academic\s+session|session|class|grade|subject|paper\s*(?:code|no\.?|number)|roll\s*(?:no\.?|number))\b/i;
const INSTRUCTION = /^(?:general\s+)?instructions?\b|^(?:attempt|answer|write|read)\s+(?:all|any|only|the following|each)\b/i;
const QUESTION_WORD = /\b(?:what|which|who|when|where|why|how|define|describe|explain|state|write|draw|give|name|match|choose|select|identify|calculate|find|complete|fill|differentiate|compare|justify|prove|show)\b/i;
const PASSAGE_START = /\b(?:read|study|refer to|based on)\b.{0,90}\b(?:passage|extract|following|given|case study|table)\b/i;
const SOURCE_VISUAL = /\b(?:observe|refer to|study|look at)\b.{0,100}\b(?:diagram|figure|image|picture|graph|chart|table|map)\b|\b(?:diagram|figure|image|picture|graph|chart|map)\s+(?:below|given|shown|above)\b/i;
const DRAWING_REQUIRED = /\b(?:draw|sketch|construct|make)\b.{0,80}\b(?:diagram|figure|graph|chart|map)\b/i;

const toLines = (value) => {
  const source = String(value ?? '').replace(/\r/g, '\n');
  const lines = source
    .split('\n')
    .map(clean)
    .filter(Boolean);

  // Some PDFs provide a single text run.  Recover the important structural
  // boundaries without flattening all content into a destructive single line.
  if (lines.length <= 2 && source.length > 160) {
    return source
      .replace(/\s+(?=(?:q(?:uestion)?\s*)?\d{1,3}\s*(?:[.:)]|\([a-zivxlcdm]+\))\s+)/gi, '\n')
      .replace(/\s+(?=(?:[ivxlcdm]+)\.\s+\S)/gi, '\n')
      .replace(/\s+(?=\([a-z]\)\s+\S)/gi, '\n')
      .split('\n')
      .map(clean)
      .filter(Boolean);
  }
  return lines;
};

const isSectionHeading = (line) =>
  /^(?:section|part|unit)\s*(?:[ivxlcdm]+|\d+|[a-z])\b[:.\-]*/i.test(line) ||
  /^(?:objective|subjective|multiple choice questions?|true\s*\/\s*false|fill in the blanks?|match (?:the )?following|short answer questions?|long answer questions?)\s*[:.\-]*$/i.test(line);

const isChoiceInstruction = (value) => /\b(?:any\s*(?:one|1)|choose\s*(?:one|any)|attempt\s*(?:one|any))\b/i.test(value);
const isQuestionLike = (value) => QUESTION_WORD.test(value) || /[?]$/.test(value) || /\b(?:true\s*\/\s*false|assertion|reason|fill in|odd one out|composition|letter|precis)\b/i.test(value);
const hasSourceVisual = (value) => SOURCE_VISUAL.test(value) && !DRAWING_REQUIRED.test(value);

const nestedSubquestionParentKey = (sourceQuestionNumber) => {
  const value = String(sourceQuestionNumber || '');
  if (/-[a-z]$/i.test(value)) return value.replace(/-[a-z]$/i, '');
  return value;
};

const detectType = ({ text, options, matchingPairs }) => {
  const normalized = clean(text);
  if (matchingPairs.length || /\bmatch (?:the )?following\b|\bcolumn\s*[ab]\b/i.test(normalized)) return 'MATCHING';
  if (/\btrue\s*(?:\/|or)\s*false\b|\bstate whether\b/i.test(normalized)) return 'TRUE_FALSE';
  if (options.length >= 2) return 'MULTIPLE_CHOICE';
  if (/\bfill (?:in )?(?:the )?blanks?\b|_{3,}/i.test(normalized)) return 'FILL_IN_THE_BLANK';
  if (/\bletter(?: writing)?\b/i.test(normalized)) return 'ESSAY_LETTER';
  if (/\bstory(?: writing)?\b/i.test(normalized)) return 'ESSAY_STORY';
  if (/\b(?:composition|essay|precis)\b/i.test(normalized)) return 'ESSAY';
  if (/\b(?:calculate|find the value|numerical|solve|formula)\b/i.test(normalized)) return 'NUMBER';
  if (/\b(?:explain|describe|elaborate|discuss|differentiate|compare)\b/i.test(normalized) || normalized.length > 280) return 'PARAGRAPH';
  return 'SHORT_ANSWER';
};

const extractMatchingPairs = (lines) => lines
  .filter((line) => /\bcolumn\s*[ab]\b/i.test(line) || /\S+\s{3,}\S+/.test(line))
  .map((line) => clean(line))
  .slice(0, 20);

const buildCandidate = ({ current, order, documentLength }) => {
  if (!current) return null;
  const textLines = current.textLines.filter(Boolean);
  const rawText = clean(textLines.join(' '));
  const questionText = clean(textLines.filter((line) => !OPTION_START.test(line)).join(' '));
  if (questionText && /:\s*$/.test(questionText) && current?.subQuestionLabel && !current.options.length) {
    return { rejected: true, reason: 'section-header', sourcePages: [...current.sourcePages] };
  }
  if (!questionText || questionText.length < 4 || PAGE_CHROME.test(questionText) || METADATA.test(questionText) || INSTRUCTION.test(questionText)) {
    if (current?.subQuestionLabel || current?.parentQuestionNumber) {
      // Parent shell rows like "9." may carry no standalone prompt text.
    } else {
      return { rejected: true, reason: 'not-a-question-region', sourcePages: [...current.sourcePages] };
    }
  }
  if (questionText && !isQuestionLike(questionText) && questionText.length < 28 && !current?.subQuestionLabel) {
    return { rejected: true, reason: 'insufficient-question-signal', sourcePages: [...current.sourcePages] };
  }
  if (documentLength && questionText.length > documentLength * 0.55) {
    return { rejected: true, reason: 'giant-document-as-one-question', sourcePages: [...current.sourcePages] };
  }

  const matchingPairs = extractMatchingPairs(current.matchingLines);
  const questionType = normalizeQuestionType(detectType({ text: questionText, options: current.options, matchingPairs }));
  const options = questionType === 'TRUE_FALSE'
    ? ['True', 'False']
    : questionType === 'MULTIPLE_CHOICE' ? current.options : [];
  const requiresSourceImage = hasSourceVisual(rawText);
  const drawingRequired = DRAWING_REQUIRED.test(rawText);
  const mediaRequirement = classifyImportMediaRequirement({
    questionText,
    sourceImageRequired: requiresSourceImage,
    drawingRequired,
    mediaCandidates: requiresSourceImage ? [{ required: true }] : [],
  });
  const reviewRequired = Boolean(
    current.choiceGroupId ||
    current.passage ||
    requiresSourceImage ||
    !questionType ||
    (questionType === 'MULTIPLE_CHOICE' && options.length < 2)
  );

  return {
    questionText,
    questionType: questionType || 'SHORT_ANSWER',
    options,
    correctAnswer: '',
    points: current.marks || parseMarksFromText(rawText) || 1,
    order,
    sourceQuestionNumber: current.sourceQuestionNumber || null,
    parentQuestionNumber: current.parentQuestionNumber || null,
    subQuestionLabel: current.subQuestionLabel || null,
    sourcePages: [...current.sourcePages],
    boundingRegions: current.boundingRegions,
    groupType: current.choiceGroupId ? 'CHOICE_ALTERNATIVE' : current.passage ? 'PASSAGE_CHILD' : 'ATOMIC_QUESTION',
    choiceGroupId: current.choiceGroupId || null,
    passage: current.passage || '',
    matchingPairs,
    mediaCandidates: requiresSourceImage ? [{ required: true, reason: 'source-visual-stimulus' }] : [],
    sourceImageRequired: requiresSourceImage,
    drawingRequired,
    mediaRequirement,
    confidence: reviewRequired ? 'MEDIUM' : 'HIGH',
    reviewRequired,
    extractionWarnings: [
      ...(current.choiceGroupId ? ['Choice alternative: confirm attempt rule before saving.'] : []),
      ...(requiresSourceImage ? ['Verify the linked source visual in review.'] : []),
      ...(current.passage ? ['Passage is shared context; confirm child association in review.'] : []),
    ],
    provenance: {
      sourcePages: [...current.sourcePages],
      boundingRegions: current.boundingRegions,
      sourceQuestionNumber: current.sourceQuestionNumber || null,
    },
  };
};

/**
 * Build a deterministic, page-aware map before any question draft is created.
 * It intentionally keeps uncertain structure reviewable rather than inventing
 * answers, MCQ options, or mandatory question semantics.
 */
export const buildQuestionImportDocumentMap = ({ pageTexts = [], text = '', filename = '' } = {}) => {
  const pages = (Array.isArray(pageTexts) && pageTexts.length ? pageTexts : [text])
    .map((pageText, index) => ({ pageNumber: index + 1, text: String(pageText ?? ''), lines: toLines(pageText) }))
    .filter((page) => page.text.trim() || page.lines.length);
  const documentText = pages.map((page) => page.text).join('\n');
  const documentLength = clean(documentText).length;
  const repeatedLineCounts = new Map();
  pages.forEach((page) => page.lines.forEach((line) => {
    const lineKey = key(line);
    if (lineKey.length >= 5) repeatedLineCounts.set(lineKey, (repeatedLineCounts.get(lineKey) || 0) + 1);
  }));

  const metadataRegions = [];
  const instructionRegions = [];
  const ignoredRegions = [];
  const sections = [];
  const candidates = [];
  let current = null;
  let activePassage = '';
  let activeChoiceGroup = null;

  const rejectCurrent = (reason) => {
    const candidate = buildCandidate({ current, order: candidates.length, documentLength });
    if (candidate?.rejected) {
      ignoredRegions.push({ reason: candidate.reason || reason, sourcePages: candidate.sourcePages || [] });
    } else if (candidate) {
      candidates.push(candidate);
    }
    current = null;
  };

  const startCandidate = ({ pageNumber, sourceQuestionNumber, parentQuestionNumber = null, subQuestionLabel = null, firstLine, choiceGroupId = null, passage = '' }) => {
    current = {
      sourceQuestionNumber,
      parentQuestionNumber,
      subQuestionLabel,
      textLines: [clean(firstLine)],
      options: [],
      matchingLines: [],
      marks: null,
      sourcePages: new Set([pageNumber]),
      boundingRegions: [{ pageNumber, kind: 'text' }],
      choiceGroupId,
      passage: passage || activePassage,
    };
  };

  for (const page of pages) {
    for (const line of page.lines) {
      const normalizedLine = clean(line);
      const lineKey = key(normalizedLine);
      const repeatedChrome = (repeatedLineCounts.get(lineKey) || 0) >= 2 && !QUESTION_START.test(normalizedLine) && !EXPLICIT_SUBQUESTION_START.test(normalizedLine);
      if (PAGE_CHROME.test(normalizedLine) || repeatedChrome || /^(?:copyright|www\.|https?:\/\/)/i.test(normalizedLine)) {
        ignoredRegions.push({ reason: 'header-footer-or-page-chrome', sourcePages: [page.pageNumber] });
        continue;
      }
      if (isSectionHeading(normalizedLine)) {
        rejectCurrent('section-boundary');
        sections.push({ title: normalizedLine, sourcePage: page.pageNumber });
        activeChoiceGroup = null;
        continue;
      }
      if (!current && (METADATA.test(normalizedLine) || INSTRUCTION.test(normalizedLine))) {
        const target = INSTRUCTION.test(normalizedLine) ? instructionRegions : metadataRegions;
        target.push({ sourcePage: page.pageNumber, text: normalizedLine });
        continue;
      }

      const explicitSub = normalizedLine.match(EXPLICIT_SUBQUESTION_START);
      if (explicitSub) {
        if (current && PASSAGE_START.test(current.textLines.join(' '))) {
          activePassage = clean(current.textLines.join(' '));
          current = null;
        } else {
          rejectCurrent('new-subquestion');
        }
        activeChoiceGroup = null;
        startCandidate({
          pageNumber: page.pageNumber,
          sourceQuestionNumber: `${explicitSub[1]}(${explicitSub[2]})`,
          parentQuestionNumber: explicitSub[1],
          subQuestionLabel: explicitSub[2],
          firstLine: explicitSub[3],
        });
        continue;
      }

      const bareParent = normalizedLine.match(/^(\d{1,3})\.\s*$/);
      if (bareParent) {
        rejectCurrent('new-question');
        activePassage = '';
        activeChoiceGroup = null;
        startCandidate({ pageNumber: page.pageNumber, sourceQuestionNumber: bareParent[1], firstLine: '' });
        continue;
      }

      const parent = normalizedLine.match(QUESTION_START);
      if (parent) {
        const previousLooksLikeChoice = current && isChoiceInstruction(current.textLines.join(' '));
        if (previousLooksLikeChoice) {
          const groupId = activeChoiceGroup || `choice-p${page.pageNumber}-q${current.sourceQuestionNumber || parent[1]}`;
          const parentQuestionNumber = current?.sourceQuestionNumber || parent[1];
          if (!activeChoiceGroup) {
            activeChoiceGroup = groupId;
            const sharedInstruction = clean(current.textLines.join(' '));
            current = null;
            startCandidate({
              pageNumber: page.pageNumber,
              sourceQuestionNumber: `${parent[1]}-1`,
              parentQuestionNumber,
              firstLine: parent[2],
              choiceGroupId: groupId,
            });
            if (current) current.passage = sharedInstruction;
          } else {
            rejectCurrent('choice-alternative');
            startCandidate({
              pageNumber: page.pageNumber,
              sourceQuestionNumber: `${parent[1]}-${candidates.length + 1}`,
              parentQuestionNumber,
              firstLine: parent[2],
              choiceGroupId: groupId,
            });
          }
          continue;
        }
        rejectCurrent('new-question');
        activePassage = '';
        activeChoiceGroup = null;
        startCandidate({ pageNumber: page.pageNumber, sourceQuestionNumber: parent[1], firstLine: parent[2] });
        continue;
      }

      const romanSub = normalizedLine.match(ROMAN_SUBQUESTION_START);
      if (romanSub && !current?.options?.length) {
        const parentNumber = current?.sourceQuestionNumber
          ? String(current.sourceQuestionNumber).replace(/\([^)]+\)$/, '')
          : null;
        if (parentNumber) {
          rejectCurrent('new-subquestion');
        }
        startCandidate({
          pageNumber: page.pageNumber,
          sourceQuestionNumber: `${parentNumber || '0'}(${romanSub[1]})`,
          parentQuestionNumber: parentNumber,
          subQuestionLabel: romanSub[1],
          firstLine: romanSub[2],
        });
        continue;
      }

      const bareSub = normalizedLine.match(BARE_SUBQUESTION_START);
      if (current && bareSub && !current.options.length && !/\b(?:choose|select|option|mcq)\b/i.test(current.textLines.join(' '))) {
        const currentText = clean(current.textLines.join(' '));
        const parentNumber = current.sourceQuestionNumber;
        const grandParent = String(parentNumber || '').replace(/\([^)]+\)$/, '') || parentNumber;
        if (PASSAGE_START.test(currentText)) {
          activePassage = currentText;
          current = null;
          startCandidate({
            pageNumber: page.pageNumber,
            sourceQuestionNumber: `${grandParent}(${bareSub[1]})`,
            parentQuestionNumber: grandParent,
            subQuestionLabel: bareSub[1],
            firstLine: bareSub[2],
          });
        } else if (/:\s*$/.test(currentText) || current.subQuestionLabel) {
          const headerPassage = /:\s*$/.test(currentText) ? currentText : current.passage;
          const nestedParent = nestedSubquestionParentKey(parentNumber);
          rejectCurrent('nested-subquestion');
          startCandidate({
            pageNumber: page.pageNumber,
            sourceQuestionNumber: `${nestedParent}-${bareSub[1]}`,
            parentQuestionNumber: grandParent,
            subQuestionLabel: bareSub[1],
            firstLine: bareSub[2],
            passage: headerPassage || '',
          });
        } else {
          rejectCurrent('new-subquestion');
          startCandidate({
            pageNumber: page.pageNumber,
            sourceQuestionNumber: `${parentNumber}(${bareSub[1]})`,
            parentQuestionNumber: grandParent,
            subQuestionLabel: bareSub[1],
            firstLine: bareSub[2],
          });
        }
        continue;
      }

      const option = normalizedLine.match(OPTION_START);
      if (current && option && /[a-h]/i.test(option[1]) && !current.parentQuestionNumber && !current.subQuestionLabel) {
        current.options.push(clean(option[2]));
        current.textLines.push(normalizedLine);
        continue;
      }

      if (current) {
        const lineMarks = parseMarksFromText(normalizedLine);
        if (lineMarks) {
          current.marks = lineMarks;
        }
        const strippedLine = stripMarksSuffix(normalizedLine);
        if (strippedLine && strippedLine !== normalizedLine) {
          current.textLines.push(strippedLine);
        } else {
          current.textLines.push(normalizedLine);
        }
        current.sourcePages.add(page.pageNumber);
        current.boundingRegions.push({ pageNumber: page.pageNumber, kind: 'continuation' });
        if (/\bcolumn\s*[ab]\b/i.test(normalizedLine) || /\S+\s{3,}\S+/.test(line)) current.matchingLines.push(normalizedLine);
      } else if (METADATA.test(normalizedLine) || INSTRUCTION.test(normalizedLine)) {
        const target = INSTRUCTION.test(normalizedLine) ? instructionRegions : metadataRegions;
        target.push({ sourcePage: page.pageNumber, text: normalizedLine });
      } else {
        ignoredRegions.push({ reason: 'unmapped-non-question-region', sourcePages: [page.pageNumber] });
      }
    }
  }
  rejectCurrent('document-end');

  const seen = new Set();
  const questions = candidates.filter((candidate) => {
    const fingerprint = key(candidate.questionText);
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }).map((candidate, index) => ({ ...candidate, order: index }));
  const rejectedCount = ignoredRegions.filter((region) => /question|giant|signal/.test(region.reason)).length;
  const lowCoverage = pages.length >= 2 && documentLength >= 800 && questions.length <= 1;

  return {
    documentMetadata: { filename: clean(filename), pageCount: pages.length, extractedTextLength: documentLength },
    pages: pages.map(({ pageNumber, text }) => ({ pageNumber, textLength: clean(text).length })),
    metadataRegions,
    instructionRegions,
    ignoredRegions,
    sections,
    questionGroups: questions.filter((question) => question.choiceGroupId || question.passage).map((question) => ({
      sourceQuestionNumber: question.sourceQuestionNumber,
      groupType: question.groupType,
      choiceGroupId: question.choiceGroupId,
    })),
    questions,
    diagnostics: {
      pageCount: pages.length,
      pagesSuccessfullyParsed: pages.filter((page) => page.text.trim()).length,
      extractedTextLength: documentLength,
      deterministicCandidateCount: candidates.length,
      acceptedCandidateCount: questions.length,
      rejectedCandidateCount: rejectedCount,
      ignoredRegionCount: ignoredRegions.length,
      reviewRequiredCount: questions.filter((question) => question.reviewRequired).length,
      lowCoverage,
      rejectionReasons: ignoredRegions.reduce((result, region) => {
        result[region.reason] = (result[region.reason] || 0) + 1;
        return result;
      }, {}),
    },
  };
};

export const buildImportLowCoverageError = (documentMap) => {
  const error = new Error('Xamigo could not reliably identify the questions in this document. Please review the detected structure or retry analysis.');
  error.code = 'IMPORT_LOW_COVERAGE';
  error.statusCode = 422;
  error.importReport = documentMap?.diagnostics || {};
  return error;
};
