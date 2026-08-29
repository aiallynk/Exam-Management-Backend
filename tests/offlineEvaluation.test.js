import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Jimp } from 'jimp';

// Pure-function tests for Master Phase 4 offline evaluation — no DB
// required, matching this repo's existing test convention (see
// tests/noveltySignature.test.js). Route/service integration
// (multer, S3, Mongo, the OpenAI vision call) is exercised in
// docs/XAMIGO_V2_MASTER_PHASE_4_STATUS.md's manual verification log
// instead, since this checkout has no disposable Mongo/S3 test double.

const { canScoreDeterministically, scoreDeterministic } = await import('../services/offlineEvaluation/deterministicOfflineScorer.js');
const { mapSegmentToQuestion } = await import('../services/offlineEvaluation/answerMappingService.js');
const { assessPageQuality } = await import('../services/offlineEvaluation/pageQualityService.js');

describe('deterministicOfflineScorer — canScoreDeterministically', () => {
  test('recognizes every objective type the Evaluation Router should route here', () => {
    ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'MULTIPLE_OPTIONS', 'FILL_IN_THE_BLANK', 'NUMBER', 'MATCHING'].forEach((type) => {
      assert.equal(canScoreDeterministically(type), true, type);
    });
  });
  test('rejects subjective/human-only types', () => {
    ['SHORT_ANSWER', 'ESSAY', 'CODING', 'PRACTICAL', 'DIAGRAM'].forEach((type) => {
      assert.equal(canScoreDeterministically(type), false, type);
    });
  });
});

describe('deterministicOfflineScorer — scoreDeterministic', () => {
  test('MULTIPLE_CHOICE: exact option text match is correct', () => {
    const question = { questionType: 'MULTIPLE_CHOICE', correctAnswer: 'Paris', options: ['London', 'Paris', 'Berlin', 'Madrid'], points: 5 };
    const result = scoreDeterministic({ question, extractedText: 'Paris' });
    assert.equal(result.isCorrect, true);
    assert.equal(result.pointsEarned, 5);
  });
  test('MULTIPLE_CHOICE: a single detected letter matching the option initial counts as correct', () => {
    const question = { questionType: 'MULTIPLE_CHOICE', correctAnswer: 'B', options: ['A. London', 'B. Paris', 'C. Berlin'], points: 2 };
    const result = scoreDeterministic({ question, extractedText: 'b' });
    assert.equal(result.isCorrect, true);
  });
  test('MULTIPLE_CHOICE: wrong option is incorrect and earns 0', () => {
    const question = { questionType: 'MULTIPLE_CHOICE', correctAnswer: 'Paris', options: ['London', 'Paris'], points: 5 };
    const result = scoreDeterministic({ question, extractedText: 'London' });
    assert.equal(result.isCorrect, false);
    assert.equal(result.pointsEarned, 0);
  });
  test('TRUE_FALSE: candidate writing "True"/"T" matches a True key', () => {
    const question = { questionType: 'TRUE_FALSE', correctAnswer: 'True', points: 1 };
    assert.equal(scoreDeterministic({ question, extractedText: 'True' }).isCorrect, true);
    assert.equal(scoreDeterministic({ question, extractedText: 'T' }).isCorrect, true);
    assert.equal(scoreDeterministic({ question, extractedText: 'False' }).isCorrect, false);
  });
  test('NUMBER: numeric equivalence ignores stray non-numeric characters from OCR', () => {
    const question = { questionType: 'NUMBER', correctAnswer: '42', points: 3 };
    assert.equal(scoreDeterministic({ question, extractedText: '= 42' }).isCorrect, true);
    assert.equal(scoreDeterministic({ question, extractedText: '43' }).isCorrect, false);
  });
  test('MULTIPLE_OPTIONS: every expected option must be present in the extracted text', () => {
    const question = { questionType: 'MULTIPLE_OPTIONS', correctAnswer: ['A', 'C'], options: ['A. Alpha', 'B. Beta', 'C. Gamma'], points: 4 };
    const result = scoreDeterministic({ question, extractedText: 'A, C' });
    assert.equal(result.isCorrect, true);
  });
  test('confidence is always returned so the Evaluation Router can compose it with OCR/mapping confidence', () => {
    const question = { questionType: 'TRUE_FALSE', correctAnswer: 'True', points: 1 };
    const result = scoreDeterministic({ question, extractedText: 'True' });
    assert.ok(Number.isFinite(result.confidence) && result.confidence > 0 && result.confidence <= 1);
    assert.equal(result.evaluationMethod, 'DETERMINISTIC');
  });
});

describe('answerMappingService — mapSegmentToQuestion (Part H)', () => {
  const sequence = [
    { displayNumber: 1, questionId: 'q1', questionType: 'MULTIPLE_CHOICE', points: 2 },
    { displayNumber: 2, questionId: 'q2', questionType: 'SHORT_ANSWER', points: 5 },
    { displayNumber: 3, questionId: 'q3', questionType: 'ESSAY', points: 10 },
  ];

  test('parses a plain number label and maps to the matching frozen question', () => {
    const result = mapSegmentToQuestion({ detectedQuestionNumber: '2', extractionConfidence: 0.9, sequence });
    assert.equal(result.questionId, 'q2');
    assert.equal(result.mappingStatus, 'AUTO_MAPPED');
  });
  test('parses "Q3(a)"-style labels by leading integer, ignoring the sub-part letter', () => {
    const result = mapSegmentToQuestion({ detectedQuestionNumber: 'Q3(a)', extractionConfidence: 0.85, sequence });
    assert.equal(result.questionId, 'q3');
  });
  test('a number outside the paper\'s range needs review rather than guessing', () => {
    const result = mapSegmentToQuestion({ detectedQuestionNumber: '99', extractionConfidence: 0.9, sequence });
    assert.equal(result.questionId, null);
    assert.equal(result.mappingStatus, 'NEEDS_REVIEW');
  });
  test('no detectable number needs review, never a fabricated guess', () => {
    const result = mapSegmentToQuestion({ detectedQuestionNumber: '', extractionConfidence: 0.9, sequence });
    assert.equal(result.questionId, null);
    assert.equal(result.mappingStatus, 'NEEDS_REVIEW');
  });
  test('low OCR extraction confidence keeps the mapping itself uncertain (Part H low tier)', () => {
    const result = mapSegmentToQuestion({ detectedQuestionNumber: '1', extractionConfidence: 0.1, sequence });
    assert.equal(result.mappingStatus, 'NEEDS_REVIEW');
  });
});

describe('pageQualityService — assessPageQuality (Part F)', () => {
  test('a uniform blank white page is flagged isLikelyBlank', async () => {
    const image = new Jimp({ width: 200, height: 200, color: 0xffffffff });
    const buffer = await image.getBuffer('image/png');
    const result = await assessPageQuality(buffer);
    assert.equal(result.isLikelyBlank, true);
  });
  test('a small image is flagged below the readable-resolution floor', async () => {
    const image = new Jimp({ width: 100, height: 100, color: 0xff0000ff });
    const buffer = await image.getBuffer('image/png');
    const result = await assessPageQuality(buffer);
    assert.equal(result.qualityStatus, 'UNREADABLE');
  });
  test('a high-resolution non-blank page is GOOD', async () => {
    const image = new Jimp({ width: 2000, height: 2800, color: 0xff0000ff });
    const buffer = await image.getBuffer('image/png');
    const result = await assessPageQuality(buffer);
    assert.equal(result.qualityStatus, 'GOOD');
    assert.equal(result.isLikelyBlank, false);
  });
  test('an undecodable buffer returns UNREADABLE with an error rather than throwing', async () => {
    const result = await assessPageQuality(Buffer.from('not an image'));
    assert.equal(result.qualityStatus, 'UNREADABLE');
    assert.ok(result.error);
  });
});
