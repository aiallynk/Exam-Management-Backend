import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { validateNormalizerResult, SAFE_NORMALIZATION_MESSAGE } from './answerScriptNormalizationContract.js';

// Python-free answer-sheet "normalization".
//
// The Gemini vision model reads PDFs natively, so preparing an answer sheet
// for evaluation does NOT require rasterizing it with PyMuPDF/OpenCV. This
// path splits the uploaded PDF into single-page PDFs with pdf-lib (pure JS,
// no native libraries, no Python) and hands each page straight to Gemini in
// services/offlineEvaluation/documentVisionProvider.js. An uploaded image is
// wrapped into a one-page PDF so the rest of the pipeline is uniform.
//
// It emits exactly the contract answerScriptNormalizationService.js expects
// from the legacy Python normalizer (see answerScriptNormalizationContract.js:
// validateNormalizerResult) — `{ normalizedPdf, pages: [...] }` — except the
// per-page derivative files are PDFs, not JPEGs, and each page carries a
// `mimeType` so the downstream data: URI is labelled correctly.

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const PDF_MIME = 'application/pdf';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// PDF user-space units are points (1/72"). Downstream only uses these numbers
// for display metadata, so a nominal 150 DPI mapping is fine.
const NOMINAL_DPI = 150;
const ptToPx = (pt) => (Number.isFinite(pt) && pt > 0 ? Math.round((pt / 72) * NOMINAL_DPI) : null);

const invalidInput = (message) => Object.assign(new Error(message || SAFE_NORMALIZATION_MESSAGE), {
  code: 'NORMALIZATION_INVALID_INPUT',
  safeMessage: SAFE_NORMALIZATION_MESSAGE,
});

const pageDerivative = ({ pageNumber, filePath, widthPx, heightPx, mimeType, contentHash }) => ({
  pageNumber,
  // The four derivative slots the normalization service uploads separately.
  // Vision-direct produces one artefact per page; all four point at it.
  working: filePath,
  preview: filePath,
  thumbnail: filePath,
  identity: filePath,
  mimeType,
  widthPx: widthPx ?? null,
  heightPx: heightPx ?? null,
  workingDpi: NOMINAL_DPI,
  colorMode: 'COLOR',
  contentHash,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  qualityStatus: 'ACCEPTABLE',
  isLikelyBlank: false,
  deskewDegrees: 0,
  colorRelevant: true,
});

const splitPdfIntoPages = async ({ sourceBuffer, outputDir, maxPages }) => {
  let sourceDoc;
  try {
    sourceDoc = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true, updateMetadata: false });
  } catch (error) {
    throw invalidInput(`The uploaded PDF could not be opened (${error.message}).`);
  }
  const totalPages = sourceDoc.getPageCount();
  if (!totalPages) throw invalidInput('The uploaded PDF has no pages.');
  const pageCount = Math.min(totalPages, Math.max(1, Number(maxPages) || totalPages));

  const pages = [];
  for (let index = 0; index < pageCount; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const singleDoc = await PDFDocument.create();
    // eslint-disable-next-line no-await-in-loop
    const [copied] = await singleDoc.copyPages(sourceDoc, [index]);
    singleDoc.addPage(copied);
    const { width, height } = copied.getSize();
    // eslint-disable-next-line no-await-in-loop
    const bytes = Buffer.from(await singleDoc.save({ useObjectStreams: false }));
    const filePath = path.join(outputDir, `page-${index + 1}.pdf`);
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(filePath, bytes);
    pages.push(pageDerivative({
      pageNumber: index + 1,
      filePath,
      widthPx: ptToPx(width),
      heightPx: ptToPx(height),
      mimeType: PDF_MIME,
      contentHash: sha256(bytes),
    }));
  }

  // The "normalized working master": the source PDF as-is when it fits the
  // page cap, otherwise a truncated copy so it matches the page rows.
  let normalizedBytes = sourceBuffer;
  if (pageCount < totalPages) {
    const trimmed = await PDFDocument.create();
    const copies = await trimmed.copyPages(sourceDoc, Array.from({ length: pageCount }, (_, i) => i));
    copies.forEach((page) => trimmed.addPage(page));
    normalizedBytes = Buffer.from(await trimmed.save({ useObjectStreams: false }));
  }
  const normalizedPdf = path.join(outputDir, 'normalized.pdf');
  await fs.writeFile(normalizedPdf, normalizedBytes);

  return { normalizedPdf, pages };
};

const wrapImageIntoPage = async ({ sourceBuffer, mimeType, outputDir }) => {
  const doc = await PDFDocument.create();
  let embedded;
  try {
    embedded = mimeType === 'image/png'
      ? await doc.embedPng(sourceBuffer)
      : await doc.embedJpg(sourceBuffer);
  } catch (error) {
    // webp (and any decode failure) — keep the raw image as the page input;
    // Gemini reads webp/jpeg/png directly, we just can't wrap it in a PDF.
    if (mimeType === 'image/webp') {
      const rawPath = path.join(outputDir, 'page-1.webp');
      await fs.writeFile(rawPath, sourceBuffer);
      const pages = [pageDerivative({
        pageNumber: 1, filePath: rawPath, widthPx: null, heightPx: null, mimeType, contentHash: sha256(sourceBuffer),
      })];
      // No PDF master available; use the image itself as the normalized object.
      return { normalizedPdf: rawPath, pages, normalizedMimeType: mimeType };
    }
    throw invalidInput(`The uploaded image could not be read (${error.message}).`);
  }
  const page = doc.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const normalizedPdf = path.join(outputDir, 'normalized.pdf');
  await fs.writeFile(normalizedPdf, bytes);

  // The page input handed to Gemini stays the original image (smaller, no
  // re-encode); the normalized master is the wrapped PDF.
  const rawPath = path.join(outputDir, `page-1.${mimeType === 'image/png' ? 'png' : 'jpg'}`);
  await fs.writeFile(rawPath, sourceBuffer);
  const pages = [pageDerivative({
    pageNumber: 1,
    filePath: rawPath,
    widthPx: embedded.width ? Math.round(embedded.width) : null,
    heightPx: embedded.height ? Math.round(embedded.height) : null,
    mimeType,
    contentHash: sha256(sourceBuffer),
  })];
  return { normalizedPdf, pages, normalizedMimeType: PDF_MIME };
};

export const buildVisionDirectNormalization = async ({ sourceBuffer, mimeType, outputDir, maxPages }) => {
  if (!Buffer.isBuffer(sourceBuffer) || !sourceBuffer.length) {
    throw invalidInput('The uploaded source file is empty.');
  }
  await fs.mkdir(outputDir, { recursive: true });

  let result;
  if (mimeType === PDF_MIME) {
    result = await splitPdfIntoPages({ sourceBuffer, outputDir, maxPages });
    result.normalizedMimeType = PDF_MIME;
  } else if (IMAGE_MIMES.has(mimeType)) {
    result = await wrapImageIntoPage({ sourceBuffer, mimeType, outputDir });
  } else {
    throw invalidInput(`Unsupported answer-sheet type "${mimeType || 'unknown'}".`);
  }

  const contract = {
    mode: 'VISION_DIRECT',
    normalizedPdf: result.normalizedPdf,
    normalizedMimeType: result.normalizedMimeType || PDF_MIME,
    pages: result.pages,
  };
  // Same shape guarantee the legacy Python normalizer's stdout is held to.
  validateNormalizerResult(contract);
  return contract;
};

export default { buildVisionDirectNormalization };
