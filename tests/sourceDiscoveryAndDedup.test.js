import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractConceptAnchors, summarizeEvidencePlan } from '../services/sourceDiscoveryService.js';
import { classifyRepeatRelationship } from '../services/questionMemoryService.js';
import { SIGNAL_BY_OUTCOME } from '../services/questionHistoryService.js';

describe('extractConceptAnchors (spec Part 17) — deterministic, never fabricated', () => {
  test('anchors come from the actual selected evidence, section titles weighted highest', () => {
    const anchors = extractConceptAnchors([
      {
        contextSourceId: 's1',
        matchedSectionTitles: ['Nutrition in Plants', 'Photosynthesis'],
        _topScored: [
          { text: 'Chlorophyll traps light energy. Carbon dioxide enters through stomata. Glucose is the product.' },
          { text: 'The raw materials for photosynthesis are water and carbon dioxide.' },
        ],
      },
    ]);
    assert.ok(anchors.includes('Nutrition in Plants'));
    assert.ok(anchors.length <= 12);
    // Nothing invented — every anchor substring appears in the supplied text.
    const haystack = 'nutrition in plants photosynthesis chlorophyll traps light energy carbon dioxide enters through stomata glucose is the product the raw materials for photosynthesis are water and carbon dioxide';
    for (const a of anchors) {
      assert.ok(haystack.includes(a.toLowerCase()) || a.split(' ').every((w) => haystack.includes(w.toLowerCase())), `anchor "${a}" is grounded in the evidence`);
    }
  });

  test('empty selection → no anchors', () => {
    assert.deepEqual(extractConceptAnchors([]), []);
  });
});

describe('summarizeEvidencePlan (spec Part 24) — real counts only', () => {
  test('reports selected vs relevant vs dropped from the plan, not intentions', () => {
    const plan = {
      requestedTopic: 'Photosynthesis',
      requestedTypes: ['MULTIPLE_CHOICE'],
      resources: [
        { contextSourceId: 'a', resourceTitle: 'Science Textbook', chapter: 'Nutrition in Plants', coverage: 'HIGH' },
        { contextSourceId: 'b', resourceTitle: 'Reference Biology', chapter: 'Plant Nutrition', coverage: 'MEDIUM' },
        { contextSourceId: 'c', resourceTitle: 'English Grammar', chapter: '', coverage: 'NONE' },
      ],
      selectedContextSourceIds: ['a', 'b'],
      droppedContextSourceIds: ['c'],
    };
    const s = summarizeEvidencePlan(plan);
    assert.equal(s.sourcesSelected, 3);
    assert.equal(s.sourcesRelevant, 2);
    assert.equal(s.sourcesDropped, 1);
    assert.equal(s.chaptersUsed, 2);
  });
});

describe('classifyRepeatRelationship (spec Parts 16, 18) — same concept ≠ duplicate', () => {
  const near = { outcomes: [{ layer: 'SEMANTIC', detail: {} }], novelty: { collision: { layer: 'NEAR', questionText: 'Which pigment is required for photosynthesis?' } } };
  const exact = { outcomes: [{ layer: 'EXACT' }], novelty: { collision: { layer: 'EXACT' } } };
  const concept = { outcomes: [{ layer: 'CONCEPT_PATTERN' }, { layer: 'SEMANTIC_EMBEDDING', matches: [{ similarity: 0.74, questionText: 'Define photosynthesis.' }] }], novelty: {} };
  const unique = { outcomes: [], novelty: {} };

  test('exact collision → EXACT_DUPLICATE (blocking), 100%', () => {
    const r = classifyRepeatRelationship({ questionText: 'x', repeatResult: exact });
    assert.equal(r.relationship, 'EXACT_DUPLICATE');
    assert.equal(r.isBlocking, true);
    assert.equal(r.similarityPercent, 100);
  });

  test('near-dup semantic collision → NEAR_DUPLICATE (blocking), rounded %', () => {
    const r = classifyRepeatRelationship({ questionText: 'x', repeatResult: near });
    assert.equal(r.relationship, 'NEAR_DUPLICATE');
    assert.equal(r.isBlocking, true);
    assert.equal(r.category, 'Similar question found');
  });

  test('"Define photosynthesis." vs a scenario question on the same concept → SAME_CONCEPT_DIFFERENT_QUESTION, NOT blocking', () => {
    const r = classifyRepeatRelationship({
      questionText: 'A plant is kept in light but deprived of carbon dioxide. Predict the effect on food formation.',
      repeatResult: concept,
    });
    assert.equal(r.relationship, 'SAME_CONCEPT_DIFFERENT_QUESTION');
    assert.equal(r.isBlocking, false);
    assert.match(r.category, /same concept/i);
  });

  test('no collisions → UNIQUE', () => {
    assert.equal(classifyRepeatRelationship({ questionText: 'x', repeatResult: unique }).relationship, 'UNIQUE');
  });

  test('never surfaces a raw cosine — only a rounded integer percent', () => {
    const r = classifyRepeatRelationship({ questionText: 'x', repeatResult: concept });
    assert.ok(r.similarityPercent === null || Number.isInteger(r.similarityPercent));
  });
});

describe('feedback signal mapping (spec Part 14)', () => {
  test('every creator outcome maps to a concrete signal type', () => {
    assert.deepEqual(Object.keys(SIGNAL_BY_OUTCOME).sort(), ['ACCEPTED', 'EDITED', 'GENERATED', 'REGENERATED', 'REJECTED', 'SAVED_TO_BANK', 'USED_IN_EXAM']);
    assert.equal(SIGNAL_BY_OUTCOME.ACCEPTED, 'QUESTION_APPROVED');
    assert.equal(SIGNAL_BY_OUTCOME.SAVED_TO_BANK, 'QUESTION_SAVED_TO_BANK');
  });
});
