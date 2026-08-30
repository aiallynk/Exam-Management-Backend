import crypto from 'crypto';
import path from 'path';
import pdfParse from 'pdf-parse';
import { runEngineChatCompletion } from './aiEngine/aiEngineClient.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import { isEngineOperationAvailable } from './aiEngine/aiEngineClient.js';
import ingestionConfig from '../config/ingestionConfig.js';
import { parseQuestionImportFile } from './questionImportImageService.js';

export const PDF_PAGE_CLASS = Object.freeze({
  TEXT_NATIVE: 'TEXT_NATIVE',
  MIXED: 'MIXED',
  SCANNED: 'SCANNED',
});

export const computeFileContentHash = (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

export const computeChunkContentHash = (text) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

const sanitizeText = (value) => String(value || '').replace(/\u0000/g, '').trim();

const isPlaceholderKnowledgeText = (text) => {
  const sample = String(text || '').toLowerCase();
  return (
    sample.includes('scanned question block')
    || sample.includes('manual review required')
    || sample.includes('imported scanned question')
    || /option a.*option b.*option c.*option d/i.test(sample)
  );
};

export const classifyPdfTextLayer = ({ text = '', numPages = 1 } = {}) => {
  const pages = Math.max(1, Number(numPages) || 1);
  const charsPerPage = sanitizeText(text).length / pages;
  if (charsPerPage >= ingestionConfig.PDF_TEXT_NATIVE_CHARS_PER_PAGE) return PDF_PAGE_CLASS.TEXT_NATIVE;
  if (charsPerPage < ingestionConfig.PDF_SCANNED_CHARS_PER_PAGE) return PDF_PAGE_CLASS.SCANNED;
  return PDF_PAGE_CLASS.MIXED;
};

const extractPdfNativeText = async (buffer) => {
  const parsed = await pdfParse(buffer);
  return {
    text: sanitizeText(parsed?.text || ''),
    numPages: parsed?.numpages || 1,
    extractionMethod: 'pdf-native',
  };
};

const extractScannedPdfWithVision = async ({ buffer, tenantId, userId }) => {
  if (!isEngineOperationAvailable(AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE)) {
    return { text: '', extractionMethod: 'ocr-unavailable', needsReview: true, confidence: 0 };
  }
  if (buffer.length > 4 * 1024 * 1024) {
    return { text: '', extractionMethod: 'ocr-skipped-large', needsReview: true, confidence: 0 };
  }
  try {
    const dataUri = `data:application/pdf;base64,${buffer.toString('base64')}`;
    const response = await runEngineChatCompletion({
      operation: AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
      feature: 'content_library_ocr',
      tenantId,
      userId,
      request: {
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract all readable text from this document faithfully. Preserve headings, paragraphs, and numbering. Do NOT invent questions, options, or placeholder content. Return only extracted source text.',
            },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        }],
      },
    });
    const text = sanitizeText(response?.choices?.[0]?.message?.content || '');
    if (isPlaceholderKnowledgeText(text)) {
      return { text: '', extractionMethod: 'ocr-rejected-placeholder', needsReview: true, confidence: 0.2 };
    }
    return {
      text,
      extractionMethod: 'pdf-ocr-vision',
      needsReview: text.length < ingestionConfig.PDF_MIN_TOTAL_TEXT_CHARS,
      confidence: text.length >= ingestionConfig.PDF_MIN_TOTAL_TEXT_CHARS ? 0.75 : 0.35,
    };
  } catch {
    return { text: '', extractionMethod: 'ocr-failed', needsReview: true, confidence: 0 };
  }
};

const extractImageTextWithVision = async ({ buffer, extension, tenantId, userId }) => {
  if (!isEngineOperationAvailable(AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE)) {
    return { text: '', extractionMethod: 'ocr-unavailable', needsReview: true };
  }
  const mime = extension === '.png' ? 'image/png' : 'image/jpeg';
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
  try {
    const response = await runEngineChatCompletion({
      operation: AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
      feature: 'content_library_ocr',
      tenantId,
      userId,
      request: {
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract all readable text from this image faithfully. Do NOT invent questions or multiple-choice options. Return only extracted source text.',
            },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        }],
      },
    });
    const text = sanitizeText(response?.choices?.[0]?.message?.content || '');
    if (isPlaceholderKnowledgeText(text)) {
      return { text: '', extractionMethod: 'ocr-rejected-placeholder', needsReview: true };
    }
    return { text, extractionMethod: 'image-ocr-vision', needsReview: !text };
  } catch {
    return { text: '', extractionMethod: 'ocr-failed', needsReview: true };
  }
};

/**
 * Text-first extraction for Content Library knowledge indexing.
 * Must NOT invoke question-import structured OCR pipelines.
 */
export const extractContentLibraryDocument = async (file, { tenantId = null, userId = null } = {}) => {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  const extractionErrors = [];

  if (extension === '.pdf') {
    let native;
    try {
      native = await extractPdfNativeText(file.buffer);
    } catch (error) {
      extractionErrors.push({ stage: 'pdf-native', message: error?.message || 'PDF text extraction failed' });
      native = { text: '', numPages: 1, extractionMethod: 'pdf-native-failed' };
    }

    const pageClass = classifyPdfTextLayer({ text: native.text, numPages: native.numPages });

    if (pageClass === PDF_PAGE_CLASS.TEXT_NATIVE) {
      return {
        text: native.text,
        extractionMethod: 'pdf-native',
        pageClass,
        needsReview: false,
        confidence: 0.95,
        extractionErrors,
        ocrPages: 0,
        nativePages: native.numPages,
      };
    }

    if (pageClass === PDF_PAGE_CLASS.MIXED && native.text.length >= ingestionConfig.PDF_MIN_TOTAL_TEXT_CHARS) {
      return {
        text: native.text,
        extractionMethod: 'pdf-native-mixed',
        pageClass,
        needsReview: false,
        confidence: 0.8,
        extractionErrors,
        ocrPages: 0,
        nativePages: native.numPages,
      };
    }

    const ocr = await extractScannedPdfWithVision({ buffer: file.buffer, tenantId, userId });
    const mergedText = sanitizeText([native.text, ocr.text].filter(Boolean).join('\n\n'));
    return {
      text: mergedText,
      extractionMethod: ocr.extractionMethod,
      pageClass,
      needsReview: ocr.needsReview || !mergedText,
      confidence: ocr.confidence ?? 0.5,
      extractionErrors,
      ocrPages: mergedText && !native.text ? (native.numPages || 1) : 0,
      nativePages: native.text ? native.numPages : 0,
    };
  }

  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    const ocr = await extractImageTextWithVision({ buffer: file.buffer, extension, tenantId, userId });
    return {
      text: ocr.text,
      extractionMethod: ocr.extractionMethod,
      pageClass: PDF_PAGE_CLASS.SCANNED,
      needsReview: ocr.needsReview,
      confidence: ocr.text ? 0.7 : 0,
      extractionErrors,
      ocrPages: ocr.text ? 1 : 0,
      nativePages: 0,
    };
  }

  // Deterministic formats — parseQuestionImportFile does not run PDF vision for these.
  const parsed = await parseQuestionImportFile(file, { tenantId });
  const text = sanitizeText(parsed?.text || '');
  if (isPlaceholderKnowledgeText(text)) {
    return {
      text: '',
      extractionMethod: parsed?.extractionMethod || 'structured-parse',
      pageClass: PDF_PAGE_CLASS.TEXT_NATIVE,
      needsReview: true,
      confidence: 0,
      extractionErrors: parsed?.extractionErrors || extractionErrors,
      ocrPages: 0,
      nativePages: 0,
    };
  }
  return {
    text,
    extractionMethod: parsed?.extractionMethod || 'structured-parse',
    pageClass: PDF_PAGE_CLASS.TEXT_NATIVE,
    needsReview: false,
    confidence: 0.9,
    extractionErrors: parsed?.extractionErrors || extractionErrors,
    ocrPages: 0,
    nativePages: 0,
  };
};

/**
 * Semantic chunking preserving paragraph/heading boundaries where possible.
 */
export const semanticChunkText = (
  text,
  {
    targetChars = ingestionConfig.TARGET_CHUNK_CHARS,
    overlapChars = ingestionConfig.CHUNK_OVERLAP_CHARS,
    minChars = ingestionConfig.MIN_CHUNK_CHARS,
  } = {}
) => {
  const normalized = sanitizeText(text);
  if (!normalized) return [];

  const sections = normalized.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';

  const flush = () => {
    const piece = buffer.trim();
    if (piece.length >= minChars || (piece && !chunks.length)) {
      chunks.push(piece);
    }
    buffer = piece.length > overlapChars ? piece.slice(-overlapChars) : '';
  };

  for (const section of sections) {
    if (!buffer) {
      buffer = section;
    } else if ((buffer + '\n\n' + section).length <= targetChars) {
      buffer = `${buffer}\n\n${section}`;
    } else {
      if (buffer.length >= minChars) flush();
      if (section.length > targetChars) {
        if (buffer) flush();
        let start = 0;
        while (start < section.length) {
          const end = Math.min(start + targetChars, section.length);
          let sliceEnd = end;
          if (end < section.length) {
            const lastSpace = section.lastIndexOf(' ', end);
            if (lastSpace > start) sliceEnd = lastSpace;
          }
          const piece = section.slice(start, sliceEnd).trim();
          if (piece) chunks.push(piece);
          start = Math.max(sliceEnd - overlapChars, start + 1);
        }
        buffer = '';
      } else {
        buffer = buffer ? `${buffer}\n\n${section}` : section;
      }
    }
    if (buffer.length >= targetChars) flush();
  }
  if (buffer.trim()) flush();

  return chunks.filter(Boolean);
};
