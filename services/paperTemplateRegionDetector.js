// Deterministic classification of a question-paper text line as an
// institutional TEMPLATE region vs. CONTENT (Phase 1A groundwork; the fuller
// layout+geometry pass is Stage 2). Pure and generic — no institution name
// is ever hardcoded. Used to guarantee acceptance items 1, 2 and 14: the
// header / instruction block / footer / "Page X of Y" must never be turned
// into Question Bank drafts.

export const REGION = Object.freeze({
  DOC_CONTROL: 'DOC_CONTROL', // "Document No. ACA/R/08 Rev. 00 Date : 02.02.2022"
  INSTITUTION_NAME: 'INSTITUTION_NAME', // all-caps org line near the top
  SESSION: 'SESSION', // "ACADEMIC SESSION 2025-2026"
  ASSESSMENT_TITLE: 'ASSESSMENT_TITLE', // "ASSESSMENT 1"
  GRADE: 'GRADE', // "GRADE VII" / "Class: VII"
  MARKS_DURATION: 'MARKS_DURATION', // "Maximum Marks: 80 ... Time: 2 Hours"
  INSTRUCTIONS_HEADING: 'INSTRUCTIONS_HEADING',
  INSTRUCTION_LINE: 'INSTRUCTION_LINE',
  SECTION_HEADING: 'SECTION_HEADING', // "SECTION I (40 Marks)"
  SECTION_RULE: 'SECTION_RULE', // "(Attempt all questions)" / "Attempt any four ..."
  FOOTER: 'FOOTER', // running footer path line
  PAGE_NUMBER: 'PAGE_NUMBER', // "Page 1 of 7" (often glued to the footer)
  CONTENT: 'CONTENT',
});

// Every non-CONTENT region is a template region and must be excluded from
// question extraction.
export const isTemplateRegion = (region) => region !== REGION.CONTENT;

const PAGE_NUMBER_RE = /\bpage\s+\d+\s+of\s+\d+\b/i;
const DOC_CONTROL_RE = /document\s*(no\.?|number)?\s*[:.]?\s*[A-Za-z0-9/\-]+.*\brev\.?\s*\d+/i;
const SESSION_RE = /\b(academic\s+session|session)\b.*\b\d{4}\s*[–-]\s*\d{2,4}\b/i;
const ASSESSMENT_TITLE_RE = /^\s*(assessment|examination|exam|test|periodic\s+test|unit\s+test|term\s+(end\s+)?exam(ination)?)\s*[-–]?\s*(i{1,3}|[0-9]{1,2})?\s*$/i;
const GRADE_RE = /^\s*(grade|class|std\.?|standard)\s*[:\-]?\s*(x{0,3}(ix|iv|v?i{0,3})|[0-9]{1,2})\s*$/i;
const MARKS_DURATION_RE = /\b(maximum\s+marks|max\.?\s*marks|total\s+marks)\b\s*[:\-]?\s*\d+/i;
const TIME_RE = /\btime\b\s*[:\-]?\s*\d+\s*(hour|hr|min)/i;
const INSTRUCTIONS_HEADING_RE = /^\s*(instructions?|general\s+instructions?)\s*[:\-]?\s*$/i;
const BULLET_RE = /^\s*(?:[•·▪◦\-*‣]|\(?[ivx]+\)|\d+\.)\s+\S/i;
const SECTION_HEADING_RE = /^\s*(section|part)\s+([ivx]+|[a-d]|[0-9]{1,2})\b.*$/i;
const SECTION_RULE_RE = /\battempt\s+(all|any\s+(\w+|\d+))\b/i;
// A running footer line: a slash-joined path of session/assessment/grade/
// subject fragments, optionally glued to a page-number (common PDF artifact:
// ".../BiologyPage 1 of 7").
const FOOTER_PATH_RE = /^\s*\d{2,4}\s*[-/]\s*\d{2,4}\s*\/.*\/[A-Za-z ]+(page\s+\d+\s+of\s+\d+)?\s*$/i;

const isAllCapsWords = (line) => {
  const letters = line.replace(/[^A-Za-z]/g, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && /[A-Z]{2,}/.test(line);
};

/**
 * Classify one line. `ctx` carries lightweight running state:
 *   { lineIndex, totalLines, sawInstructionsHeading, sawFirstQuestion }
 * so "near the top" and "inside the instruction block" can be judged without
 * a full layout model.
 */
export const classifyLine = (rawLine, ctx = {}) => {
  const line = String(rawLine || '').trim();
  if (!line) return REGION.CONTENT;

  const { lineIndex = 0, totalLines = 1, sawInstructionsHeading = false, sawFirstQuestion = false } = ctx;
  const nearTop = totalLines > 0 && lineIndex / totalLines < 0.28;
  const nearBottom = totalLines > 0 && lineIndex / totalLines > 0.82;

  if (PAGE_NUMBER_RE.test(line) && line.replace(PAGE_NUMBER_RE, '').replace(/[^A-Za-z0-9]/g, '').length <= 3) {
    return REGION.PAGE_NUMBER;
  }
  if (DOC_CONTROL_RE.test(line)) return REGION.DOC_CONTROL;
  if (FOOTER_PATH_RE.test(line)) return REGION.FOOTER;
  if (SESSION_RE.test(line)) return REGION.SESSION;
  if (INSTRUCTIONS_HEADING_RE.test(line)) return REGION.INSTRUCTIONS_HEADING;

  if (SECTION_HEADING_RE.test(line) && (isAllCapsWords(line) || /\(\s*\d+\s*marks?\s*\)/i.test(line))) {
    return REGION.SECTION_HEADING;
  }
  if (SECTION_RULE_RE.test(line) && line.length <= 120) return REGION.SECTION_RULE;

  if (nearTop) {
    if (ASSESSMENT_TITLE_RE.test(line)) return REGION.ASSESSMENT_TITLE;
    if (GRADE_RE.test(line)) return REGION.GRADE;
    if (MARKS_DURATION_RE.test(line) || TIME_RE.test(line)) return REGION.MARKS_DURATION;
    if (isAllCapsWords(line) && line.split(/\s+/).length <= 8 && !/\?$/.test(line)) {
      return REGION.INSTITUTION_NAME;
    }
  }

  // Bulleted lines that appear after the INSTRUCTIONS heading and before the
  // first real question are instruction lines, not questions.
  if (sawInstructionsHeading && !sawFirstQuestion && BULLET_RE.test(line)) {
    return REGION.INSTRUCTION_LINE;
  }

  if (nearBottom && (MARKS_DURATION_RE.test(line) === false) && FOOTER_PATH_RE.test(line)) {
    return REGION.FOOTER;
  }

  return REGION.CONTENT;
};

const QUESTION_START_RE = /^\s*(?:q\s*\.?\s*\d+|q\d+\s*[:.]|\d+\s*[.)])\s+\S/i;

/**
 * Split a page's text into classified regions and return, per line, whether
 * it should be excluded from question extraction. Convenience wrapper used by
 * the fixture acceptance test and (later) the Stage 2 layout pass.
 */
export const classifyDocumentLines = (text) => {
  const lines = String(text || '').split(/\r?\n/);
  const total = lines.length;
  let sawInstructionsHeading = false;
  let sawFirstQuestion = false;
  const out = [];
  lines.forEach((line, lineIndex) => {
    if (!sawFirstQuestion && QUESTION_START_RE.test(line) && !SECTION_HEADING_RE.test(line)) {
      sawFirstQuestion = true;
    }
    const region = classifyLine(line, {
      lineIndex,
      totalLines: total,
      sawInstructionsHeading,
      sawFirstQuestion,
    });
    if (region === REGION.INSTRUCTIONS_HEADING) sawInstructionsHeading = true;
    out.push({ line, region, isTemplate: isTemplateRegion(region) });
  });
  return out;
};
