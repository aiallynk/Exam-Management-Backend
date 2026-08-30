#!/usr/bin/env node
/**
 * Three-file ingestion benchmark harness.
 * Uses mock embeddings when OPENAI_API_KEY is absent.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  extractContentLibraryDocument,
  classifyPdfTextLayer,
  semanticChunkText,
  computeFileContentHash,
} from '../services/contentExtractionService.js';
import { packEmbeddingBatches } from '../services/contextIngestionService.js';

const stats = {
  files: 0,
  ocrCalls: 0,
  nativePages: 0,
  ocrPages: 0,
  embeddingRequests: 0,
  embeddingInputs: 0,
  chunks: 0,
  failures: 0,
};

const makeNativePdf = async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  const text = 'Photosynthesis converts light energy into chemical energy. Chlorophyll absorbs sunlight in chloroplasts.';
  page.drawText(text, { x: 50, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
};

const makeSparsePdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save());
};

const runFile = async (label, buffer, filename) => {
  stats.files += 1;
  const file = { originalname: filename, buffer, size: buffer.length };
  const hash = computeFileContentHash(buffer);
  const started = Date.now();

  try {
    const extracted = await extractContentLibraryDocument(file, { tenantId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' });
    if (extracted.ocrPages > 0) stats.ocrCalls += 1;
    stats.nativePages += extracted.nativePages || 0;
    stats.ocrPages += extracted.ocrPages || 0;

    const chunks = semanticChunkText(extracted.text || '');
    stats.chunks += chunks.length;
    const batches = packEmbeddingBatches(chunks);
    stats.embeddingRequests += batches.length;
    stats.embeddingInputs += chunks.length;

    const durationMs = Date.now() - started;
    console.log(JSON.stringify({
      label,
      hash: hash.slice(0, 12),
      pageClass: extracted.pageClass,
      extractionMethod: extracted.extractionMethod,
      textChars: (extracted.text || '').length,
      chunks: chunks.length,
      embeddingBatches: batches.length,
      ocrPages: extracted.ocrPages,
      durationMs,
      needsReview: extracted.needsReview,
    }));
  } catch (error) {
    stats.failures += 1;
    console.error(label, error.message);
  }
};

const main = async () => {
  const native = await makeNativePdf();
  const sparse = await makeSparsePdf();
  const txt = Buffer.from('Chapter 4 Mixtures\n\nA mixture contains two or more substances combined physically.');

  const nativeClass = classifyPdfTextLayer({ text: 'x'.repeat(600), numPages: 1 });
  console.log('classification-smoke', nativeClass);

  await runFile('native-text-txt', txt, 'science-ch4.txt');
  await runFile('native-text-pdf', native, 'science-ch4.pdf');
  await runFile('scanned-sparse-pdf', sparse, 'scanned-notes.pdf');

  console.log('SUMMARY', stats);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
