import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decomposeMaterialFacts,
  verifyGroundingAgainstEvidence,
  scoreGroundingHeuristic,
} from '../services/groundingValidatorService.js';

// LLM-free: an injected escalateFn stands in for the bounded provider call so
// the suite never touches a real AI provider. The stub decides support by
// literal substring — the same signal a human check would give here.

const chunk = (text) => ({ text });

const stubEscalate = ({ units, evidenceChunks }) => {
  const hay = (evidenceChunks || []).map((c) => c.text.toLowerCase()).join(' ');
  const byId = new Map(
    units.map((u) => {
      const terms = u.text.toLowerCase().match(/[a-z]{4,}/g) || [];
      const hit = terms.filter((t) => hay.includes(t)).length;
      return [u.id, terms.length ? hit / terms.length >= 0.6 : true];
    })
  );
  return { byId, answerSupported: byId.get('answer') !== false };
};

describe('decomposeMaterialFacts (spec Part 11)', () => {
  test('splits a compound "X and Y" claim into separate units, plus the answer', () => {
    const units = decomposeMaterialFacts({
      questionText: 'Why do chlorophyll and stomata both help photosynthesis?',
      correctAnswer: 'chlorophyll traps light; stomata admit carbon dioxide',
    });
    const stems = units.filter((u) => u.kind === 'STEM').map((u) => u.text.toLowerCase());
    assert.ok(stems.length >= 2, 'compound claim produced multiple stem units');
    assert.ok(units.some((u) => u.kind === 'ANSWER'), 'the stated answer is its own unit');
  });
});

describe('verifyGroundingAgainstEvidence — 3-way verdict (spec Parts 7, 9, 11)', () => {
  const evidence = [
    chunk('Plants use sunlight, water and carbon dioxide to make glucose during photosynthesis. Chlorophyll in the leaves traps light energy.'),
  ];

  test('fully supported question + answer → SUPPORTED', async () => {
    const r = await verifyGroundingAgainstEvidence({
      questionText: 'What do plants use to make glucose in photosynthesis?',
      correctAnswer: 'sunlight, water and carbon dioxide',
      evidenceChunks: evidence, escalateFn: stubEscalate,
    });
    assert.equal(r.verdict, 'SUPPORTED');
    assert.equal(r.answerSupported, true);
  });

  test('a material fact absent from the evidence ("stomata") → not SUPPORTED', async () => {
    const r = await verifyGroundingAgainstEvidence({
      questionText: 'How do chlorophyll and stomata together enable photosynthesis?',
      correctAnswer: 'chlorophyll traps light and stomata let carbon dioxide in',
      evidenceChunks: evidence, // says nothing about stomata
      escalateFn: stubEscalate,
    });
    assert.notEqual(r.verdict, 'SUPPORTED');
    assert.ok(r.unsupportedUnits.join(' ').toLowerCase().includes('stomata'));
  });

  test('answer unsupported → verdict is UNSUPPORTED even if the stem matches', async () => {
    const r = await verifyGroundingAgainstEvidence({
      questionText: 'What gas is released during photosynthesis?',
      correctAnswer: 'nitrogen',
      evidenceChunks: evidence, escalateFn: stubEscalate,
    });
    assert.notEqual(r.verdict, 'SUPPORTED');
    assert.equal(r.answerSupported, false);
  });

  test('nothing in evidence → UNSUPPORTED', async () => {
    const r = await verifyGroundingAgainstEvidence({
      questionText: 'Explain Newton\'s second law of motion.',
      correctAnswer: 'force equals mass times acceleration',
      evidenceChunks: evidence, escalateFn: stubEscalate,
    });
    assert.equal(r.verdict, 'UNSUPPORTED');
  });

  test('heuristic score still exposed for observability', () => {
    assert.ok(scoreGroundingHeuristic({ questionText: 'photosynthesis glucose', correctAnswer: 'sunlight', retrievedChunks: evidence }) > 0.5);
  });
});
