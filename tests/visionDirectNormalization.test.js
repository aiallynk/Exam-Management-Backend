import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { buildVisionDirectNormalization } from '../services/offlineEvaluation/visionDirectNormalizationService.js';

const makePdf = async (pageCount) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([300, 400]);
  return Buffer.from(await doc.save());
};

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const withTmpDir = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xamigo-vision-direct-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

const isPdfFile = async (filePath) => {
  const head = await fs.readFile(filePath);
  return head.subarray(0, 5).toString('latin1') === '%PDF-';
};

test('splits a multi-page PDF into single-page PDF derivatives handed straight to Gemini', async () => {
  await withTmpDir(async (outputDir) => {
    const source = await makePdf(3);
    const result = await buildVisionDirectNormalization({
      sourceBuffer: source, mimeType: 'application/pdf', outputDir, maxPages: 60,
    });

    assert.equal(result.mode, 'VISION_DIRECT');
    assert.equal(result.normalizedMimeType, 'application/pdf');
    assert.equal(result.pages.length, 3);
    assert.ok(await isPdfFile(result.normalizedPdf));

    for (const [index, page] of result.pages.entries()) {
      assert.equal(page.pageNumber, index + 1);
      assert.equal(page.mimeType, 'application/pdf');
      // No local Python/OpenCV ever runs, so there is nothing to deskew and
      // no rasterized crop — the whole page goes to the vision model.
      assert.equal(page.deskewDegrees, 0);
      assert.deepEqual(page.crop, { x: 0, y: 0, width: 1, height: 1 });
      assert.equal(page.qualityStatus, 'ACCEPTABLE');
      assert.match(page.contentHash, /^[a-f0-9]{64}$/);
      assert.ok(page.working && page.identity && page.preview && page.thumbnail);
      assert.ok(await isPdfFile(page.working), `page ${index + 1} working file is a real PDF`);
      // Each split page carries exactly one page.
      const doc = await PDFDocument.load(await fs.readFile(page.working));
      assert.equal(doc.getPageCount(), 1);
    }
  });
});

test('honours the page cap without erroring', async () => {
  await withTmpDir(async (outputDir) => {
    const source = await makePdf(5);
    const result = await buildVisionDirectNormalization({
      sourceBuffer: source, mimeType: 'application/pdf', outputDir, maxPages: 2,
    });
    assert.equal(result.pages.length, 2);
    const normalized = await PDFDocument.load(await fs.readFile(result.normalizedPdf));
    assert.equal(normalized.getPageCount(), 2);
  });
});

test('wraps a single uploaded image into a one-page answer sheet', async () => {
  await withTmpDir(async (outputDir) => {
    const result = await buildVisionDirectNormalization({
      sourceBuffer: TINY_PNG, mimeType: 'image/png', outputDir, maxPages: 60,
    });
    assert.equal(result.pages.length, 1);
    // The page input stays the original image; the normalized master is a PDF.
    assert.equal(result.pages[0].mimeType, 'image/png');
    assert.equal(result.normalizedMimeType, 'application/pdf');
    assert.ok(await isPdfFile(result.normalizedPdf));
  });
});

test('rejects an unreadable PDF with a safe, typed error (never a raw stack)', async () => {
  await withTmpDir(async (outputDir) => {
    await assert.rejects(
      () => buildVisionDirectNormalization({
        sourceBuffer: Buffer.from('not a pdf at all'), mimeType: 'application/pdf', outputDir, maxPages: 60,
      }),
      (error) => {
        assert.equal(error.code, 'NORMALIZATION_INVALID_INPUT');
        assert.equal(error.safeMessage, 'PDF processing failed while preparing page images.');
        return true;
      },
    );
  });
});

test('rejects an unsupported upload type', async () => {
  await withTmpDir(async (outputDir) => {
    await assert.rejects(
      () => buildVisionDirectNormalization({
        sourceBuffer: Buffer.from('x'), mimeType: 'application/zip', outputDir, maxPages: 60,
      }),
      /Unsupported answer-sheet type/,
    );
  });
});
