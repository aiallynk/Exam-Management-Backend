import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildQueryText, buildUserPrompt, resolveGenerationStrategy } from '../services/groundedGenerationService.js';

// Pure, DB/network-free unit tests covering the Topic-optionality fix
// (master prompt §15/§24/§41): a blank Topic must never produce an empty
// retrieval query or a broken prompt — both previously risked collapsing
// into the generic "insufficient source information" error for a
// perfectly valid "generate broadly from this document" request.

describe('buildQueryText — topic is optional', () => {
  test('combines topic + instructions + questionTypes when all are present', () => {
    const text = buildQueryText({ topic: 'Photosynthesis', instructions: 'Focus on chapter 3', questionTypes: ['MULTIPLE_CHOICE'] });
    assert.match(text, /Photosynthesis/);
    assert.match(text, /Focus on chapter 3/);
    assert.match(text, /MULTIPLE_CHOICE/);
  });

  test('falls back to a generic broad-coverage query when topic and instructions are both blank', () => {
    const text = buildQueryText({ topic: '', instructions: '', questionTypes: [] });
    assert.ok(text.length > 0, 'must never produce an empty string to embed');
    assert.match(text, /broad/i);
  });

  test('uses instructions alone when topic is blank but instructions are present', () => {
    const text = buildQueryText({ topic: '', instructions: 'cover the whole chapter evenly', questionTypes: [] });
    assert.match(text, /cover the whole chapter evenly/);
  });

  test('broadenFocus drops the topic from the retrieval query even when one was given', () => {
    // Regression coverage: a narrow/generic Topic (e.g. "Science and
    // Technology") can embed poorly against specific source passages,
    // causing retrieval to surface weak matches and the model to
    // (wrongly) report insufficient material even though the document is
    // clearly on-topic. On a broadened retry the topic is dropped from
    // the QUERY (though still shown to the model in the user prompt) so
    // retrieval searches for general coverage instead.
    const text = buildQueryText({ topic: 'Science and Technology', instructions: '', questionTypes: [], broadenFocus: true });
    assert.ok(!text.includes('Science and Technology'));
  });

  test('broadenFocus with no instructions falls back to the broad-coverage query, not an empty one', () => {
    const text = buildQueryText({ topic: 'Science and Technology', instructions: '', questionTypes: [], broadenFocus: true });
    assert.match(text, /broad/i);
  });
});

describe('buildUserPrompt — topic is optional', () => {
  test('includes an explicit "no topic specified" line rather than an empty/malformed prompt when topic is blank', () => {
    const prompt = buildUserPrompt({ topic: '', instructions: '', count: 5, questionTypes: ['MULTIPLE_CHOICE'] });
    assert.match(prompt, /none specified/i);
  });

  test('includes creator instructions as a distinct line from Topic (master prompt §16/§63)', () => {
    const prompt = buildUserPrompt({
      topic: 'Newton\'s Laws',
      instructions: 'Prefer application-based scenarios, avoid direct definitions.',
      count: 5,
      questionTypes: ['MULTIPLE_CHOICE'],
    });
    assert.match(prompt, /Topic\/focus: Newton's Laws/);
    assert.match(prompt, /Prefer application-based scenarios/);
  });

  test('omits the instructions line entirely when none were given', () => {
    const prompt = buildUserPrompt({ topic: 'Fractions', instructions: '', count: 5, questionTypes: ['MULTIPLE_CHOICE'] });
    assert.ok(!prompt.includes('Creator instructions'));
  });

  test('broadenFocus still shows the original topic to the model but adds the broaden-interpretation nudge', () => {
    const prompt = buildUserPrompt({
      topic: 'Science and Technology',
      instructions: '',
      count: 10,
      questionTypes: ['MULTIPLE_CHOICE'],
      broadenFocus: true,
    });
    assert.match(prompt, /Topic\/focus: Science and Technology/);
    assert.match(prompt, /interpret the topic broadly/i);
  });

  test('omits the broaden-interpretation nudge on a normal (non-retry) attempt', () => {
    const prompt = buildUserPrompt({ topic: 'Fractions', instructions: '', count: 5, questionTypes: ['MULTIPLE_CHOICE'] });
    assert.ok(!prompt.toLowerCase().includes('interpret the topic broadly'));
  });
});

describe('resolveGenerationStrategy', () => {
  test('is keyed only on generationMode, sharing one pipeline for STANDARD and WIZKIDS productModule', () => {
    assert.equal(resolveGenerationStrategy({ generationMode: 'SOURCE_GROUNDED' }), 'SOURCE_GROUNDED');
    assert.equal(resolveGenerationStrategy({ generationMode: 'source_grounded' }), 'SOURCE_GROUNDED');
    assert.equal(resolveGenerationStrategy({ generationMode: 'STANDARD' }), 'STANDARD');
    assert.equal(resolveGenerationStrategy({}), 'STANDARD');
  });
});
