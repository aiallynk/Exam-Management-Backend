import { normalizeQuestionCorrectAnswer } from '../../utils/questionOptionSanitizer.js';

// A small, purpose-built deterministic scorer for OCR-extracted objective
// answers. NOT a copy of the online submission path's inline scoring logic
// in routes/attempts.js (~2000 lines, deeply coupled to the live
// submit-answer request/response cycle — extracting it would risk the
// online exam path this phase must leave unchanged). It DOES reuse the
// same correctness primitive, normalizeQuestionCorrectAnswer, so the
// actual "what counts as correct" definition is shared, not duplicated.
//
// Honesty: free-text OCR of a handwritten "B" or "True" is simple to
// match; free-text OCR of a handwritten multi-select or matching answer is
// inherently harder, and this scorer's MULTIPLE_OPTIONS/MATCHING handling
// is a best-effort token comparison, not guaranteed equivalent to the
// online path's structured-payload matching. See the Phase 4 status doc.

const DETERMINISTIC_TYPES = ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'MULTIPLE_OPTIONS', 'FILL_IN_THE_BLANK', 'NUMBER', 'MATCHING'];

export const canScoreDeterministically = (questionType) => DETERMINISTIC_TYPES.includes(String(questionType || '').toUpperCase());

const normalizeText = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const scoreDeterministic = ({ question, extractedText }) => {
  const type = String(question.questionType || '').toUpperCase();
  const normalizedCorrect = normalizeQuestionCorrectAnswer({ questionType: type, correctAnswer: question.correctAnswer, options: question.options });
  const candidate = normalizeText(extractedText);
  const maxMarks = Number(question.points) || 0;
  let isCorrect = false;

  if (type === 'MULTIPLE_OPTIONS') {
    const expected = (Array.isArray(normalizedCorrect) ? normalizedCorrect : []).map(normalizeText);
    const detectedTokens = candidate.split(/[,;/\s]+/).filter(Boolean);
    isCorrect = expected.length > 0 && expected.every((entry) => detectedTokens.some((token) => token === entry || entry.includes(token) || token.includes(entry)));
  } else if (type === 'TRUE_FALSE') {
    isCorrect = Boolean(candidate) && candidate.startsWith('t') === normalizeText(normalizedCorrect).startsWith('t');
  } else if (type === 'MULTIPLE_CHOICE') {
    // normalizeQuestionCorrectAnswer resolves an option LETTER (e.g. "B")
    // to that option's full TEXT (e.g. "Paris") — so a candidate who wrote
    // just "B" on their sheet needs the same letter->text resolution
    // applied to what was extracted, via the question's own option list,
    // before comparing. Comparing "b" against "paris" directly would
    // always fail.
    const expected = normalizeText(normalizedCorrect);
    const options = Array.isArray(question.options) ? question.options : [];
    const letterMatch = candidate.match(/^\(?([a-z])\)?[.)]?$/i);
    const resolvedFromLetter = letterMatch
      ? normalizeText(String(options[letterMatch[1].toLowerCase().charCodeAt(0) - 97] || '').replace(/^[a-z][.)]\s*/i, ''))
      : '';
    isCorrect = Boolean(candidate) && Boolean(candidate === expected || (resolvedFromLetter && resolvedFromLetter === expected));
  } else if (type === 'NUMBER') {
    const num = Number.parseFloat(candidate.replace(/[^0-9.-]/g, ''));
    const expectedNum = Number(normalizedCorrect);
    isCorrect = Number.isFinite(num) && Number.isFinite(expectedNum) && Math.abs(num - expectedNum) < 1e-6;
  } else { // FILL_IN_THE_BLANK, MATCHING
    isCorrect = Boolean(candidate) && candidate === normalizeText(normalizedCorrect);
  }

  return {
    isCorrect,
    pointsEarned: isCorrect ? maxMarks : 0,
    // High and fixed: given accurately-extracted text, this comparison
    // logic is deterministic and reliable. The real uncertainty in the
    // pipeline lives in OCR extraction confidence, which the Evaluation
    // Router composes with this separately — not conflated here.
    confidence: 0.95,
    evaluationMethod: 'DETERMINISTIC',
  };
};
