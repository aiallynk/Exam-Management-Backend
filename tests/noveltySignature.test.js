import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// noveltyService's HMAC functions read config.noveltySignatureSecret at
// call time (not just at module load), so setting this before importing
// is sufficient — no live DB/network needed for any assertion below.
process.env.NOVELTY_SIGNATURE_SECRET = 'test-secret-do-not-use-in-production';

const {
  canonicalizeQuestionText,
  buildCanonicalQuestionRepresentation,
  computeExactSignature,
  computeNearSignatureBands,
  computeBlueprintSignature,
} = await import('../services/noveltyService.js');
const NoveltySignature = (await import('../models/NoveltySignature.js')).default;

describe('canonicalizeQuestionText', () => {
  test('is case, punctuation, and whitespace insensitive', () => {
    assert.equal(
      canonicalizeQuestionText('What is the Capital of France?'),
      canonicalizeQuestionText('what is the capital of france')
    );
    assert.equal(
      canonicalizeQuestionText('  What   is  the Capital of France?  '),
      canonicalizeQuestionText('What is the Capital of France?')
    );
  });

  test('different questions canonicalize differently', () => {
    assert.notEqual(
      canonicalizeQuestionText('What is the capital of France?'),
      canonicalizeQuestionText('What is the capital of Germany?')
    );
  });
});

describe('computeExactSignature', () => {
  const question = {
    questionText: 'What is the capital of France?',
    options: ['Paris', 'London', 'Berlin', 'Madrid'],
    correctAnswer: 'Paris',
    questionType: 'MULTIPLE_CHOICE',
  };

  test('is deterministic for identical canonical input', () => {
    const a = computeExactSignature(buildCanonicalQuestionRepresentation(question));
    const b = computeExactSignature(buildCanonicalQuestionRepresentation(question));
    assert.equal(a, b);
  });

  test('is insensitive to option ordering and casing/punctuation variation', () => {
    const reworded = {
      ...question,
      questionText: 'What is the capital of France',
      options: ['London', 'Madrid', 'Berlin', 'Paris'],
    };
    const a = computeExactSignature(buildCanonicalQuestionRepresentation(question));
    const b = computeExactSignature(buildCanonicalQuestionRepresentation(reworded));
    assert.equal(a, b);
  });

  test('differs for a materially different question', () => {
    const other = { ...question, questionText: 'What is the capital of Germany?', correctAnswer: 'Berlin' };
    const a = computeExactSignature(buildCanonicalQuestionRepresentation(question));
    const b = computeExactSignature(buildCanonicalQuestionRepresentation(other));
    assert.notEqual(a, b);
  });

  test('is a 64-character hex HMAC digest, never the raw text itself', () => {
    const signature = computeExactSignature(buildCanonicalQuestionRepresentation(question));
    assert.match(signature, /^[0-9a-f]{64}$/);
    assert.equal(signature.includes('france'), false);
    assert.equal(signature.includes('paris'), false);
  });
});

describe('computeNearSignatureBands', () => {
  test('near-identical phrasing shares at least one band (near-duplicate detectable)', () => {
    const bandsA = computeNearSignatureBands('The mitochondria is the powerhouse of the cell.');
    const bandsB = computeNearSignatureBands('The mitochondria is the powerhouse of a cell.');
    const overlap = bandsA.filter((band) => bandsB.includes(band));
    assert.ok(overlap.length > 0, 'expected at least one shared LSH band for near-identical text');
  });

  test('unrelated questions share no bands', () => {
    const bandsA = computeNearSignatureBands('What is the capital of France?');
    const bandsB = computeNearSignatureBands('Explain the process of photosynthesis in plants.');
    const overlap = bandsA.filter((band) => bandsB.includes(band));
    assert.equal(overlap.length, 0);
  });
});

describe('computeBlueprintSignature', () => {
  test('is deterministic and sensitive to each input field', () => {
    const base = { topic: 'Photosynthesis', concept: 'light reaction', answerFingerprint: 'chlorophyll', questionType: 'MCQ', difficulty: 'medium' };
    assert.equal(computeBlueprintSignature(base), computeBlueprintSignature({ ...base }));
    assert.notEqual(computeBlueprintSignature(base), computeBlueprintSignature({ ...base, concept: 'dark reaction' }));
    assert.notEqual(computeBlueprintSignature(base), computeBlueprintSignature({ ...base, questionType: 'TRUE_FALSE' }));
  });
});

describe('NoveltySignature schema — atomic reservation index', () => {
  test('has a unique compound index on {scope, layer, signature}', () => {
    const indexes = NoveltySignature.schema.indexes();
    assert.ok(
      indexes.some(([key, options]) =>
        key.scope === 1 && key.layer === 1 && key.signature === 1 && options.unique === true
      ),
      'expected a unique {scope, layer, signature} index backing the atomic reservation mechanism'
    );
  });

  test('GLOBAL-scope rows never carry raw text fields (schema has no such field to leak)', () => {
    const paths = Object.keys(NoveltySignature.schema.paths);
    assert.equal(paths.includes('questionText'), false);
    assert.equal(paths.includes('sourceText'), false);
    assert.equal(paths.includes('rawText'), false);
  });
});
