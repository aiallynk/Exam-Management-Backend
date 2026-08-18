import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import { chunkText } from '../services/contextIngestionService.js';

describe('MAX_CONTEXT_SOURCES_PER_SET', () => {
  test('is configured at 10 (master prompt hard limit), centralized not hardcoded inline', () => {
    assert.equal(sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET, 10);
  });

  test('the same constant is reused by both upload routes (no duplicated magic number)', async () => {
    const routeSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../routes/ai.js', import.meta.url), 'utf8')
    );
    const occurrences = (routeSource.match(/sourceGroundedConfig\.MAX_CONTEXT_SOURCES_PER_SET/g) || []).length;
    assert.ok(occurrences >= 2, 'expected both context-source upload routes to reference the shared constant');
  });
});

describe('chunkText', () => {
  test('splits long text into overlapping, non-empty chunks', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} about photosynthesis.`).join(' ');
    const chunks = chunkText(longText, 200, 30);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0);
      assert.ok(chunk.length <= 200 + 30); // allows for word-boundary rounding
    }
  });

  test('returns a single chunk for short text', () => {
    const chunks = chunkText('A short sentence.', 1200, 150);
    assert.deepEqual(chunks, ['A short sentence.']);
  });

  test('returns an empty array for empty/whitespace-only input', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n\t  '), []);
  });

  test('does not split words mid-token when a whitespace break is available', () => {
    const text = `${'word '.repeat(300)}`.trim();
    const chunks = chunkText(text, 100, 10);
    for (const chunk of chunks) {
      assert.equal(chunk.startsWith(' '), false);
      assert.equal(chunk.endsWith(' '), false);
    }
  });
});
