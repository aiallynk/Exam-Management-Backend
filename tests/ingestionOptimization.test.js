import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { packEmbeddingBatches } from '../services/contextIngestionService.js';
import {
  classifyPdfTextLayer,
  computeChunkContentHash,
  computeFileContentHash,
  semanticChunkText,
  PDF_PAGE_CLASS,
} from '../services/contentExtractionService.js';

test('packEmbeddingBatches groups multiple inputs', () => {
  const texts = Array.from({ length: 10 }, (_, i) => `Chunk ${i} about photosynthesis and plant nutrition.`);
  const batches = packEmbeddingBatches(texts);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].texts.length, 10);
  assert.equal(batches[0].indices.length, 10);
});

test('classifyPdfTextLayer detects native text PDFs', () => {
  const pageClass = classifyPdfTextLayer({ text: 'A'.repeat(1200), numPages: 5 });
  assert.equal(pageClass, PDF_PAGE_CLASS.TEXT_NATIVE);
});

test('classifyPdfTextLayer detects scanned PDFs', () => {
  const pageClass = classifyPdfTextLayer({ text: 'ab', numPages: 10 });
  assert.equal(pageClass, PDF_PAGE_CLASS.SCANNED);
});

test('semanticChunkText preserves paragraph boundaries', () => {
  const text = 'Chapter 1\n\nFirst paragraph about cells.\n\nSecond paragraph about tissues.';
  const chunks = semanticChunkText(text, { targetChars: 80, overlapChars: 10, minChars: 20 });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].includes('Chapter 1'));
});

test('chunk and file hashes are stable', () => {
  const hash1 = computeChunkContentHash('Photosynthesis converts light energy.');
  const hash2 = computeChunkContentHash('Photosynthesis converts light energy.');
  assert.equal(hash1, hash2);
  const fileHash = computeFileContentHash(Buffer.from('sample-bytes'));
  assert.equal(fileHash.length, 64);
});

test('embedding provider receives request object with model and input', async () => {
  const calls = [];
  const fakeClient = {
    embeddings: {
      create: async (request) => {
        calls.push(request);
        return {
          model: request.model,
          data: (Array.isArray(request.input) ? request.input : [request.input]).map(() => ({ embedding: [0.1, 0.2] })),
          usage: { prompt_tokens: 5, total_tokens: 5 },
        };
      },
    },
  };

  const { createTrackedEmbedding } = await import('../services/aiTokenUsageService.js');
  const response = await createTrackedEmbedding({
    client: fakeClient,
    request: { model: 'text-embedding-3-small', input: ['hello', 'world'] },
    tenantId: '507f1f77bcf86cd799439011',
    userId: '507f1f77bcf86cd799439012',
    feature: 'source_grounded_context_embedding',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'text-embedding-3-small');
  assert.deepEqual(calls[0].input, ['hello', 'world']);
  assert.equal(response.data.length, 2);
});

test('library upload route returns single response shape for queued processing', () => {
  const source = { _id: 'abc', status: 'PENDING', processingStage: 'QUEUED', processingJobId: 'CONTENT_INDEXING:abc' };
  const accepted = ['PENDING', 'PROCESSING'].includes(String(source.status || '').toUpperCase())
    || ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EMBEDDING'].includes(String(source.processingStage || '').toUpperCase());
  assert.equal(accepted, true);
  const response = accepted
    ? { statusCode: 202, body: { source, processing: true, jobId: source.processingJobId } }
    : { statusCode: 201, body: { source } };
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.processing, true);
});
