
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import util from 'util';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import config from '../config/env.js';
import { runEngineChatCompletion, runEngineImageGeneration, isEngineOperationAvailable, isImageGenerationEngineConfigured } from './aiEngine/aiEngineClient.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import { getModelForOperation } from './aiEngine/aiConfigService.js';
import {
  sanitizeIndexedQuestionOptionText,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';
import {
  putImage,
  getImageBuffer,
  imageExists,
  moveImage,
  urlToKey as s3UrlToKey,
  keyToUrl as s3KeyToUrl,
  buildImageLocation,
} from './storage/imageStorage.js';
import {
  assessVisionCoverage,
  countNumberedQuestionMarkers,
  splitPdfTextIntoPages,
} from './questionImportExtractionService.js';
import {
  applyImportMediaPolicy,
  classifyImportMediaRequirement,
  logImportMediaClassification,
  MEDIA_REQUIREMENTS,
  shouldAttachSourceMedia,
  validateImportQuestionMedia,
} from './questionImportMediaService.js';

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);
const IMAGE_REFERENCE_KEYS = [
  'image',
  'imageurl',
  'image_url',
  'imagepath',
  'image_path',
  'diagram',
  'figure',
  'fig',
  'picture',
  'photo',
  'asset',
];
const DIAGRAM_KEYWORD_REGEX =
  /\b(diagram|graph|figure|circuit|map|triangle|chart|plot|schematic|flowchart|geometry)\b/i;
const INLINE_IMAGE_MARKER_REGEX = /\[(?:image|img|figure|diagram)\]/i;
const INLINE_IMAGE_MARKER_REPLACE_REGEX = /\[(?:image|img|figure|diagram)\]/gi;
const IMAGE_CONTEXT_HINT_REGEX =
  /\b(?:shown|displayed|pictured|illustrated|depicted)\b|\b(?:refer to|according to|observe|look at|study)\s+(?:the\s+)?(?:image|figure|diagram|graph|chart|map|circuit|plot)\b/i;
const VISION_REJECTION_TEXT_REGEX =
  /\b(unable to (?:view|read|extract)|cannot (?:view|see|read|extract)|can't (?:view|see|read|extract)|i(?:'| a)m unable|cannot access|can't access)\b/i;
const GENERATED_IMAGE_UPLOAD_SEGMENT = '/uploads/generated_images/';
const AI_PLACEHOLDER_MARKER = 'AI Diagram Placeholder';
const AI_PLACEHOLDER_MARKER_LOWER = AI_PLACEHOLDER_MARKER.toLowerCase();

const isVisionConfigured = () => isEngineOperationAvailable(AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE);
const isImageGenConfigured = () => isImageGenerationEngineConfigured();

// Import vision/OCR calls fan out over pages and blocks; a single stuck call
// must not inherit the global 2-retry / 60s budget (which compounds to
// minutes). One retry, 45s ceiling — callers may still override via context.
const IMPORT_VISION_MAX_RETRIES = 1;
const IMPORT_VISION_TIMEOUT_MS = 45000;
let activeImportTrackingContext = { tenantId: null, userId: null };

const engineImportChat = (request, feature = 'question_import_ocr', context = {}) => runEngineChatCompletion({
  operation: AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
  feature,
  tenantId: context.tenantId ?? activeImportTrackingContext.tenantId,
  userId: context.userId ?? activeImportTrackingContext.userId,
  maxRetries: IMPORT_VISION_MAX_RETRIES,
  requestTimeoutMs: IMPORT_VISION_TIMEOUT_MS,
  ...context,
  request,
});

let artifactSequence = 0;
let unzipperModuleCache = null;
const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sanitizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const hasInlineImageMarker = (value) => INLINE_IMAGE_MARKER_REGEX.test(String(value || ''));

const stripInlineImageMarkers = (value) =>
  String(value || '')
    .replace(INLINE_IMAGE_MARKER_REPLACE_REGEX, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const looksLikeVisionRejectionText = (value) => {
  const normalized = sanitizeString(value).replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return false;
  return (
    VISION_REJECTION_TEXT_REGEX.test(normalized) ||
    normalized.includes('if you can provide the text') ||
    normalized.includes('please provide the text')
  );
};

const normalizeTextKey = (value) =>
  stripInlineImageMarkers(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const questionLikelyReferencesImportedImage = (value) => {
  const normalized = stripInlineImageMarkers(value);
  if (!normalized) return false;
  if (hasInlineImageMarker(value)) return true;
  if (IMAGE_CONTEXT_HINT_REGEX.test(normalized)) return true;
  if (/\b(?:study the diagram|observe the (?:diagram|image|figure)|refer to the (?:diagram|figure|image|graph)|in the given image|picture shows|image shows)\b/i.test(normalized)) {
    return true;
  }
  return false;
};

const artifactFingerprint = (artifact) => {
  if (!artifact || !Buffer.isBuffer(artifact.buffer) || !artifact.buffer.length) {
    return '';
  }
  const pageKey = Number.isFinite(Number(artifact.pageNumber)) ? Number(artifact.pageNumber) : 0;
  const digest = crypto.createHash('sha1').update(artifact.buffer).digest('hex');
  return `${pageKey}:${digest}`;
};

const dedupeArtifacts = (artifacts) => {
  const seen = new Set();
  const uniqueArtifacts = [];

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const fingerprint = artifactFingerprint(artifact);
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    uniqueArtifacts.push(artifact);
  }

  return uniqueArtifacts;
};

const makeImportSessionId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const isSupportedImageExt = (extension) =>
  SUPPORTED_IMAGE_EXTENSIONS.has(String(extension || '').toLowerCase());

const normalizeImageExt = (extension) => {
  const raw = String(extension || '').toLowerCase();
  if (!raw) return '.png';
  if (raw === '.jpeg') return '.jpg';
  if (raw === 'jpeg') return '.jpg';
  if (raw === '.jpg' || raw === 'jpg') return '.jpg';
  if (raw === '.png' || raw === 'png') return '.png';
  if (raw === '.svg' || raw === 'svg') return '.svg';
  return raw.startsWith('.') ? raw : `.${raw}`;
};

const sanitizeFilename = (name, fallback = 'image') => {
  const raw = sanitizeString(name);
  const safe = raw
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
};

const getUploadsRoot = () =>
  path.isAbsolute(config.uploadDir)
    ? config.uploadDir
    : path.join(process.cwd(), config.uploadDir);

const decodeXmlEntities = (value) =>
  String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const looksLikeUrl = (value) => /^https?:\/\//i.test(value) || /^\/uploads\//i.test(value);

const looksLikePdfBuffer = (buffer) =>
  Buffer.isBuffer(buffer) &&
  buffer.length >= 5 &&
  buffer.slice(0, 5).toString('latin1') === '%PDF-';

const estimatePdfPageCount = (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return 0;
  const latin1 = buffer.toString('latin1');
  const matches = latin1.match(/\/Type\s*\/Page\b/g);
  return Array.isArray(matches) ? matches.length : 0;
};

const getUnzipper = async () => {
  if (unzipperModuleCache) {
    return unzipperModuleCache;
  }

  try {
    const moduleRef = await import('unzipper');
    unzipperModuleCache = moduleRef?.default || moduleRef;
    return unzipperModuleCache;
  } catch (error) {
    const dependencyError = new Error(
      'DOCX/XLSX image extraction dependency is missing. Install package \"unzipper\".'
    );
    dependencyError.statusCode = 500;
    throw dependencyError;
  }
};

const detectMimeAndExtFromBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { mimeType: '', extension: '' };
  }

  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mimeType: 'image/png', extension: '.png' };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }

  const utf8Start = buffer.slice(0, 128).toString('utf-8').trim().toLowerCase();
  if (utf8Start.startsWith('<svg')) {
    return { mimeType: 'image/svg+xml', extension: '.svg' };
  }

  return { mimeType: '', extension: '' };
};

const artifactToDataUri = (artifact) => {
  if (!artifact || !Buffer.isBuffer(artifact.buffer) || !artifact.buffer.length) {
    return '';
  }
  const mimeType = sanitizeString(artifact.mimeType) || 'image/png';
  const base64 = artifact.buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
};

const decodeTextLikeDataUri = (value) => {
  const normalized = sanitizeString(value);
  if (!/^data:/i.test(normalized)) return '';

  const commaIndex = normalized.indexOf(',');
  if (commaIndex === -1) return '';

  const header = normalized.slice(5, commaIndex).toLowerCase();
  if (!header.includes('svg+xml') && !header.startsWith('text/')) {
    return '';
  }

  const payload = normalized.slice(commaIndex + 1);
  try {
    if (header.includes(';base64')) {
      return Buffer.from(payload, 'base64').toString('utf-8');
    }
    return decodeURIComponent(payload);
  } catch {
    return '';
  }
};

const containsPlaceholderMarker = (value) => {
  const normalized = sanitizeString(value).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes(AI_PLACEHOLDER_MARKER_LOWER)) {
    return true;
  }

  const decodedDataUri = decodeTextLikeDataUri(value).toLowerCase();
  return decodedDataUri.includes(AI_PLACEHOLDER_MARKER_LOWER);
};

const uploadUrlContainsPlaceholderMarker = async (uploadUrl) => {
  const normalizedUploadUrl = normalizeUploadUrl(uploadUrl);
  if (!normalizedUploadUrl) return false;

  if (normalizeImageExt(path.extname(normalizedUploadUrl)) !== '.svg') {
    return false;
  }

  try {
    const buffer = await getImageBuffer({ url: normalizedUploadUrl });
    if (!buffer?.length) return false;
    return buffer.toString('utf-8').toLowerCase().includes(AI_PLACEHOLDER_MARKER_LOWER);
  } catch {
    return false;
  }
};

const isGeneratedImageReference = (value) => {
  const normalized = sanitizeString(value);
  if (!normalized) return false;

  const normalizedUploadUrl = normalizeUploadUrl(normalized);
  if (normalizedUploadUrl.startsWith(GENERATED_IMAGE_UPLOAD_SEGMENT)) {
    return true;
  }

  if (normalized.toLowerCase().includes('/generated_images/')) {
    return true;
  }

  const decodedDataUri = decodeTextLikeDataUri(normalized);
  if (decodedDataUri && decodedDataUri.includes(AI_PLACEHOLDER_MARKER)) {
    return true;
  }

  return normalized.includes(AI_PLACEHOLDER_MARKER);
};

const normalizeUploadUrl = (value) => {
  const normalized = sanitizeString(value);
  if (!normalized) return '';

  if (normalized.startsWith('/uploads/')) {
    return normalized.split('?')[0];
  }

  if (normalized.startsWith('uploads/')) {
    return `/${normalized.split('?')[0]}`;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname;
    }
  } catch {
    return '';
  }

  return '';
};

const detectMimeByPath = (filePath) => {
  const ext = normalizeImageExt(path.extname(filePath));
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
};

// filePathToDataUri reads a genuine local filesystem path (used by the
// scanned-PDF OCR pipeline, whose crop images are read straight off disk
// before/without ever being uploaded — see extractQuestionsFromScannedBlocks).
const filePathToDataUri = async (filePath) => {
  try {
    const buffer = await fs.readFile(filePath);
    if (!buffer.length) return '';
    const mimeType = detectMimeByPath(filePath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
};

// uploadUrlToDataUri fetches an already-S3-stored image (referenced by its
// /uploads/... URL) and returns it as a data URI — the S3 counterpart to
// filePathToDataUri above.
const uploadUrlToDataUri = async (uploadUrl) => {
  const normalized = normalizeUploadUrl(uploadUrl);
  if (!normalized) return '';
  try {
    const buffer = await getImageBuffer({ url: normalized });
    if (!buffer?.length) return '';
    const mimeType = detectMimeByPath(normalized);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
};

const uploadUrlExists = async (uploadUrl) => {
  const normalized = normalizeUploadUrl(uploadUrl);
  if (!normalized) return false;
  try {
    return await imageExists({ url: normalized });
  } catch {
    return false;
  }
};

const persistArtifactToStorage = async ({
  artifact,
  tenantId,
  examId,
  category = 'misc',
  subpath = [],
  fileStem = 'diagram',
}) => {
  if (!artifact || !Buffer.isBuffer(artifact.buffer) || !artifact.buffer.length) {
    return '';
  }

  const extension = normalizeImageExt(artifact.extension || detectMimeAndExtFromBuffer(artifact.buffer).extension || '.png');
  const stem = sanitizeFilename(fileStem || path.parse(artifact.name || 'image').name, 'diagram');
  const stored = await putImage({
    tenantId,
    examId,
    category,
    subpath,
    fileStem: stem,
    extension,
    buffer: artifact.buffer,
  });

  return stored?.url || '';
};

// Reads an already-on-disk image file and uploads it to S3 — used for the
// scanned-PDF OCR pipeline, whose Python subprocess writes crop/page images
// directly to local disk before this module ever sees them (see
// runScannedPdfProcessor). Returns '' only when the local file itself is
// missing/empty; an S3-configuration or upload error still throws (from
// putImage) so callers get a clear hard-fail rather than a silently-broken
// empty image URL.
const uploadLocalImageFile = async ({ tenantId, examId, category = 'misc', subpath = [], absolutePath, fileStem }) => {
  const normalizedPath = sanitizeString(absolutePath);
  if (!normalizedPath) return '';
  let buffer;
  try {
    buffer = await fs.readFile(normalizedPath);
  } catch {
    return '';
  }
  if (!buffer.length) return '';

  const extension = normalizeImageExt(path.extname(normalizedPath)) || '.png';
  const stored = await putImage({
    tenantId,
    examId,
    category,
    subpath,
    fileStem: fileStem || path.parse(normalizedPath).name,
    extension,
    buffer,
  });
  return stored?.url || '';
};

const normalizeOptionValue = (value, index = null) => {
  const normalized = sanitizeString(value).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return Number.isInteger(index) && index >= 0
    ? sanitizeIndexedQuestionOptionText(normalized, index)
    : normalized;
};

const parseOptionsFromText = (text) => {
  const optionMap = { A: '', B: '', C: '', D: '' };
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const lineRegex = /^([A-D])\s*[\)\.\:\-]\s*(.+)$/i;
  for (const line of lines) {
    const match = line.match(lineRegex);
    if (match) {
      optionMap[match[1].toUpperCase()] = normalizeOptionValue(match[2]);
    }
  }

  // Inline fallback: A) ... B) ... C) ... D) ...
  if (!Object.values(optionMap).some(Boolean)) {
    const inlineRegex = /([A-D])\s*[\)\.\:\-]\s*([^A-D]+?)(?=(?:\s+[A-D]\s*[\)\.\:\-])|$)/gi;
    let match;
    while ((match = inlineRegex.exec(raw))) {
      const label = String(match[1] || '').toUpperCase();
      if (optionMap[label]) continue;
      optionMap[label] = normalizeOptionValue(match[2]);
    }
  }

  return optionMap;
};

const buildQuestionFromPlainText = (text, index = 0) => {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const optionMap = parseOptionsFromText(raw);
  const hasOptions = Object.values(optionMap).filter(Boolean).length >= 2;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const optionLinePattern = /^([A-D])\s*[\)\.\:\-]\s*/i;
  const questionLines = lines.filter((line) => !optionLinePattern.test(line));
  const questionBody = questionLines.join(' ').replace(/\s+/g, ' ').trim();
  const questionText = questionBody || raw.slice(0, 450).replace(/\s+/g, ' ').trim();

  if (!questionText) return null;

  const questionNumberMatch = questionText.match(/(?:^|\s)(?:q(?:uestion)?\s*)?(\d{1,3})\s*[\)\.\:\-]/i);
  const options = ['A', 'B', 'C', 'D']
    .map((label) => optionMap[label])
    .filter(Boolean);

  const confidence =
    (questionText.length >= 25 ? 0.45 : 0.25) +
    (hasOptions ? 0.45 : 0.15) +
    (questionNumberMatch ? 0.1 : 0);

  return {
    questionNumber: questionNumberMatch ? Number(questionNumberMatch[1]) : null,
    questionText,
    questionType: hasOptions ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER',
    options: hasOptions ? options : undefined,
    correctAnswer: '',
    points: 1,
    order: index,
    ocrConfidence: Math.min(1, confidence),
  };
};

const ensureUniqueQuestionText = (questions) => {
  const seen = new Set();
  const result = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const key = normalizeTextKey(question?.questionText || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(question);
  }
  return result;
};

// Uploads every block/page crop the Python renderer wrote to local disk,
// filling in the *Url fields alongside the existing *Path fields (the raw
// local paths stay valid — extractQuestionsFromScannedBlocks still reads
// them directly for vision OCR). Deliberately NOT called from inside the
// runtime-retry loop below: an S3-configuration error here must propagate
// as-is, not get swallowed and misreported as "python runtime failed".
const uploadScannedPdfImages = async ({ pages, tenantId, importSessionId }) => {
  const blocks = [];

  for (const page of pages) {
    const rawImagePath = sanitizeString(page?.rawImage || '');
    const preprocessedImagePath = sanitizeString(page?.preprocessedImage || '');
    page.rawImageUrl = rawImagePath
      ? await uploadLocalImageFile({
          tenantId,
          category: 'questions',
          subpath: ['imports', importSessionId, 'scanned'],
          absolutePath: rawImagePath,
          fileStem: 'page-raw',
        })
      : '';
    page.preprocessedImageUrl = preprocessedImagePath
      ? await uploadLocalImageFile({
          tenantId,
          category: 'questions',
          subpath: ['imports', importSessionId, 'scanned'],
          absolutePath: preprocessedImagePath,
          fileStem: 'page-preprocessed',
        })
      : '';

    for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
      const blockImagePath = sanitizeString(block?.blockImage || '');
      const preprocessedPath = sanitizeString(block?.preprocessedBlockImage || '');
      const ocrBlockImagePath = sanitizeString(block?.ocrBlockImage || '');
      const ocrPreprocessedPath = sanitizeString(block?.ocrBlockPreprocessedImage || '');
      const diagramPath = sanitizeString(block?.diagramImage || '');
      const subpath = ['imports', importSessionId, 'scanned'];
      const uploadIfPresent = (absolutePath, fileStem) =>
        absolutePath
          ? uploadLocalImageFile({ tenantId, category: 'questions', subpath, absolutePath, fileStem })
          : Promise.resolve('');

      blocks.push({
        pageNumber: Number.isFinite(Number(page?.pageNumber)) ? Number(page.pageNumber) : 1,
        blockIndex: Number.isFinite(Number(block?.blockIndex)) ? Number(block.blockIndex) : blocks.length + 1,
        bbox: block?.bbox || null,
        blockImagePath,
        preprocessedBlockImagePath: preprocessedPath,
        ocrBlockImagePath,
        ocrBlockPreprocessedImagePath: ocrPreprocessedPath,
        diagramImagePath: diagramPath,
        blockImageUrl: await uploadIfPresent(blockImagePath, 'block'),
        preprocessedBlockImageUrl: await uploadIfPresent(preprocessedPath, 'block-preprocessed'),
        ocrBlockImageUrl: await uploadIfPresent(ocrBlockImagePath, 'block-ocr'),
        ocrBlockPreprocessedImageUrl: await uploadIfPresent(ocrPreprocessedPath, 'block-ocr-preprocessed'),
        diagramImageUrl: await uploadIfPresent(diagramPath, 'block-diagram'),
        layoutRegions:
          block?.layoutRegions && typeof block.layoutRegions === 'object' ? block.layoutRegions : null,
      });
    }
  }

  return blocks;
};

const runScannedPdfProcessor = async ({
  sourceBuffer,
  pdfBuffer,
  inputExtension = '.pdf',
  importSessionId,
  tenantId,
  extractionErrors,
}) => {
  const effectiveBuffer = Buffer.isBuffer(sourceBuffer)
    ? sourceBuffer
    : Buffer.isBuffer(pdfBuffer)
      ? pdfBuffer
      : null;
  if (!effectiveBuffer) {
    extractionErrors.push({
      stage: 'scanned-pdf-processor',
      message: 'No valid input buffer provided for scanned processor.',
    });
    return { blocks: [], pages: [], workingDir: '' };
  }

  const uploadsRoot = getUploadsRoot();
  const workingDir = path.join(uploadsRoot, 'questions', 'imports', importSessionId, 'scanned');
  await fs.mkdir(workingDir, { recursive: true });
  const normalizedInputExt = String(inputExtension || '').toLowerCase();
  const sourceFilename = normalizedInputExt === '.pdf'
    ? 'source.pdf'
    : `source${normalizedInputExt.startsWith('.') ? normalizedInputExt : '.bin'}`;
  const sourceFilePath = path.join(workingDir, sourceFilename);
  await fs.writeFile(sourceFilePath, effectiveBuffer);

  const scriptPath = path.join(__dirname, 'import_scanned_pdf.py');
  const scriptArgs = ['--input', sourceFilePath, '--output', workingDir, '--dpi', '300'];
  const runtimeCandidates =
    os.platform() === 'win32'
      ? [
          { executable: 'python', prefixArgs: [] },
          { executable: 'py', prefixArgs: ['-3'] },
          { executable: 'python3', prefixArgs: [] },
        ]
      : [
          { executable: 'python3', prefixArgs: [] },
          { executable: 'python', prefixArgs: [] },
        ];

  const runtimeErrors = [];
  let pages = null;

  for (const runtime of runtimeCandidates) {
    try {
      const args = [...runtime.prefixArgs, scriptPath, ...scriptArgs];
      const { stdout, stderr } = await execFileAsync(runtime.executable, args, {
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 25,
      });

      if (sanitizeString(stderr)) {
        extractionErrors.push({
          stage: 'scanned-pdf-processor',
          message: sanitizeString(stderr).slice(0, 500),
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(String(stdout || '').trim() || '{}');
      } catch (parseError) {
        throw new Error(`Invalid scanned PDF processor output: ${parseError?.message || 'JSON parse failed'}`);
      }

      if (parsed?.error) {
        extractionErrors.push({
          stage: 'scanned-pdf-processor',
          message: sanitizeString(parsed.error),
        });
        return { blocks: [], pages: [], workingDir };
      }

      pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
      break;
    } catch (error) {
      const runtimeLabel = `${runtime.executable}${runtime.prefixArgs.length ? ` ${runtime.prefixArgs.join(' ')}` : ''}`;
      runtimeErrors.push(`${runtimeLabel}: ${error?.message || 'Execution failed'}`);
    }
  }

  if (pages === null) {
    extractionErrors.push({
      stage: 'scanned-pdf-processor',
      message:
        runtimeErrors.length > 0
          ? `Failed to execute scanned PDF processor via available runtimes. ${runtimeErrors.join(' | ').slice(0, 900)}`
          : 'Failed to execute scanned PDF processor.',
    });
    return { blocks: [], pages: [], workingDir };
  }

  // Outside the runtime-retry try/catch on purpose — an S3-configuration
  // error here is real and must propagate, not be misreported as a failed
  // python runtime.
  const blocks = await uploadScannedPdfImages({ pages, tenantId, importSessionId });
  return { blocks, pages, workingDir };
};

const extractStructuredQuestionWithVision = async ({
  primaryImagePath,
  fallbackImagePath,
  // Pre-built data URIs bypass the local-fs read above — used by callers
  // whose image already lives in S3 rather than on local disk (see the
  // single-image-upload fallback in parseQuestionImportFile).
  primaryDataUri: primaryDataUriOverride,
  fallbackDataUri: fallbackDataUriOverride,
  blockIndex,
  extractionErrors,
}) => {
  if (!isVisionConfigured()) return null;

  const primaryDataUri = primaryDataUriOverride || (await filePathToDataUri(primaryImagePath));
  const fallbackDataUri =
    fallbackDataUriOverride || (fallbackImagePath ? await filePathToDataUri(fallbackImagePath) : '');
  const payloadImage = primaryDataUri || fallbackDataUri;
  if (!payloadImage) return null;

  // Stage 1: OCR-like raw text extraction from the block.
  let ocrQuestion = null;
  try {
    const ocrCompletion = await engineImportChat({
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Read this scanned question block and return only the visible text with original line breaks, including options.',
            },
            {
              type: 'image_url',
              image_url: { url: payloadImage },
            },
          ],
        },
      ],
    });

    const ocrText = sanitizeString(ocrCompletion?.choices?.[0]?.message?.content || '');
    if (ocrText && !looksLikeVisionRejectionText(ocrText)) {
      ocrQuestion = buildQuestionFromPlainText(ocrText, blockIndex);
    }
  } catch (error) {
    extractionErrors.push({
      stage: 'vision-ocr-extraction',
      message: error?.message || 'OCR-style extraction failed for one block.',
    });
  }

  if (ocrQuestion && Number(ocrQuestion.ocrConfidence || 0) >= 0.6) {
    return ocrQuestion;
  }

  // Stage 2: AI structured fallback if OCR text is weak.
  try {
    const completion = await engineImportChat({
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You extract one MCQ question from a scanned exam image. Return JSON with keys: questionText, options (object with A,B,C,D), questionNumber, confidence (0 to 1). Keep text concise and faithful.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract the MCQ question and options from this image block.',
              },
              {
                type: 'image_url',
                image_url: { url: payloadImage },
              },
            ],
          },
        ],
    });

    const parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
    const questionText = sanitizeString(parsed?.questionText || parsed?.question || '');
    const optionsObj = parsed?.options && typeof parsed.options === 'object' ? parsed.options : {};
    const extractedOptions = ['A', 'B', 'C', 'D']
      .map((key, index) =>
        normalizeOptionValue(optionsObj?.[key] || optionsObj?.[key.toLowerCase()] || '', index)
      )
      .filter(Boolean);
    const options =
      extractedOptions.length >= 2
        ? extractedOptions
        : Array.isArray(ocrQuestion?.options) && ocrQuestion.options.length >= 2
          ? sanitizeQuestionOptions(ocrQuestion.options)
          : extractedOptions;

    if (!questionText || looksLikeVisionRejectionText(questionText)) {
      return ocrQuestion;
    }

    return {
      questionNumber: Number.isFinite(Number(parsed?.questionNumber))
        ? Number(parsed.questionNumber)
        : null,
      questionText,
      questionType: options.length >= 2 ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER',
      options: options.length >= 2 ? options : undefined,
      correctAnswer: '',
      points: 1,
      order: blockIndex,
      ocrConfidence: Math.min(
        1,
        Math.max(
          0,
          Number(parsed?.confidence) ||
            Number(ocrQuestion?.ocrConfidence) ||
            0.55
        )
      ),
    };
  } catch (error) {
    extractionErrors.push({
      stage: 'vision-structured-extraction',
      message: error?.message || 'Failed to parse one scanned block with AI vision.',
    });
    return ocrQuestion;
  }
};

const buildArtifact = ({
  buffer,
  extension,
  mimeType,
  source,
  name,
  rowIndex,
  pageNumber,
  placementIndex,
  width,
  height,
  pageWidth,
  pageHeight,
}) => {
  const ext = normalizeImageExt(extension || detectMimeAndExtFromBuffer(buffer).extension || '.png');
  if (!isSupportedImageExt(ext)) {
    return null;
  }

  return {
    id: `art-${Date.now()}-${artifactSequence++}`,
    buffer,
    extension: ext,
    mimeType:
      mimeType ||
      (ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg'),
    source: source || 'unknown',
    name: sanitizeFilename(name || `asset${ext}`),
    rowIndex: Number.isInteger(rowIndex) ? rowIndex : null,
    pageNumber: Number.isInteger(pageNumber) ? pageNumber : null,
    placementIndex: Number.isInteger(placementIndex) ? placementIndex : null,
    width: Number.isFinite(Number(width)) ? Number(width) : null,
    height: Number.isFinite(Number(height)) ? Number(height) : null,
    pageWidth: Number.isFinite(Number(pageWidth)) ? Number(pageWidth) : null,
    pageHeight: Number.isFinite(Number(pageHeight)) ? Number(pageHeight) : null,
  };
};

const parseRelationshipsXml = (xmlText, baseDir) => {
  const map = {};
  const text = String(xmlText || '');
  const relationshipRegex = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let match;
  while ((match = relationshipRegex.exec(text))) {
    const relationId = sanitizeString(match[1]);
    const target = sanitizeString(match[2]).replace(/\\/g, '/');
    if (!relationId || !target) continue;

    if (target.startsWith('/')) {
      map[relationId] = target.slice(1);
      continue;
    }

    const resolved = path.posix.normalize(path.posix.join(baseDir || '', target));
    map[relationId] = resolved;
  }
  return map;
};

const getRawQuestionTextFromRow = (row) => {
  if (!row || typeof row !== 'object') return '';
  const loweredKeys = Object.keys(row).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  const get = (name) => {
    const key = loweredKeys[name.toLowerCase()];
    return key ? row[key] : undefined;
  };

  return sanitizeString(
    get('questionText') ||
      get('question') ||
      get('prompt') ||
      get('q') ||
      row.questionText ||
      row.question
  );
};

const extractQuestionTextFromRow = (row) =>
  stripInlineImageMarkers(getRawQuestionTextFromRow(row));

const extractImageReferenceFromRow = (row) => {
  if (!row || typeof row !== 'object') return '';
  const keys = Object.keys(row);
  for (const key of keys) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (IMAGE_REFERENCE_KEYS.includes(normalized)) {
      const value = sanitizeString(row[key]);
      if (value) return value;
    }
  }
  return '';
};

const loadZipEntries = async (fileBuffer, predicate = () => true) => {
  const unzipper = await getUnzipper();
  const directory = await unzipper.Open.buffer(fileBuffer);
  const entries = new Map();

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const filePath = entry.path.replace(/\\/g, '/');
    if (!predicate(filePath)) continue;
    entries.set(filePath, await entry.buffer());
  }

  return entries;
};

const parseCsvRows = (fileBuffer) => {
  const text = fileBuffer.toString('utf-8');
  let rows = [];
  const csvOptions = {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    delimiter: [',', ';', '\t', '|'],
  };

  try {
    rows = parseCsv(text, csvOptions);
  } catch (error) {
    let rawRows = [];
    try {
      rawRows = parseCsv(text, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
        skip_records_with_error: true,
        delimiter: [',', ';', '\t', '|'],
      });
    } catch (fallbackError) {
      const parseError = new Error('Unable to parse CSV file. Please verify delimiters/encoding and try again.');
      parseError.statusCode = 400;
      throw parseError;
    }

    if (rawRows.length > 1) {
      const headers = rawRows[0];
      rows = rawRows.slice(1).map((row) => {
        const obj = {};
        headers.forEach((header, idx) => {
          const key = header || `Column${idx + 1}`;
          obj[key] = row[idx];
        });
        return obj;
      });
    }
  }

  return rows;
};

const parseExcelRows = async (fileBuffer, extension) => {
  try {
    const rows = await readXlsxFile(fileBuffer);
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    const headers = rows[0].map((header, idx) => {
      if (header === undefined || header === null || header === '') {
        return `Column${idx + 1}`;
      }
      return String(header).trim();
    });

    return rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, idx) => {
        const value = row[idx];
        obj[header] = value === undefined || value === null ? '' : String(value);
      });
      return obj;
    });
  } catch (error) {
    if (extension === '.xls') {
      const xlsError = new Error('Legacy .xls files are not supported. Please save and upload as .xlsx.');
      xlsError.statusCode = 400;
      throw xlsError;
    }
    const parseError = new Error(`Unable to parse Excel file: ${error.message}`);
    parseError.statusCode = 400;
    throw parseError;
  }
};

const buildStructuredText = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = Object.keys(rows[0] || {});
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(
      headers
        .map((header) => sanitizeString(row?.[header]).replace(/,/g, ';'))
        .join(',')
    );
  });
  return lines.join('\n');
};
const extractDocxText = (documentXmlBuffer) => {
  if (!Buffer.isBuffer(documentXmlBuffer)) return '';
  const xml = documentXmlBuffer.toString('utf-8');
  const withBreaks = xml
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<\/w:p>/g, '\n');

  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(stripped).replace(/\n{3,}/g, '\n\n').trim();
};

const extractDocxArtifacts = async (fileBuffer, extractionErrors) => {
  const entries = await loadZipEntries(
    fileBuffer,
    (entryPath) =>
      entryPath.startsWith('word/media/') ||
      entryPath === 'word/document.xml' ||
      entryPath === 'word/_rels/document.xml.rels'
  );

  const documentXmlBuffer = entries.get('word/document.xml');
  const documentXmlText = documentXmlBuffer ? documentXmlBuffer.toString('utf-8') : '';
  const relationshipsText = entries.get('word/_rels/document.xml.rels')?.toString('utf-8') || '';
  const relationshipMap = parseRelationshipsXml(relationshipsText, 'word');

  const embeddedRelationshipIds = [];
  const embedRegex = /r:embed="([^"]+)"/g;
  let embedMatch;
  while ((embedMatch = embedRegex.exec(documentXmlText))) {
    embeddedRelationshipIds.push(embedMatch[1]);
  }

  const artifacts = [];
  const usedPaths = new Set();
  for (const relationId of embeddedRelationshipIds) {
    const relatedPath = relationshipMap[relationId];
    if (!relatedPath) continue;
    const buffer = entries.get(relatedPath);
    if (!buffer) continue;

    const extension = normalizeImageExt(path.extname(relatedPath));
    if (!isSupportedImageExt(extension)) continue;

    const artifact = buildArtifact({
      buffer,
      extension,
      source: 'docx-embedded',
      name: path.basename(relatedPath),
    });
    if (artifact) {
      artifacts.push(artifact);
      usedPaths.add(relatedPath);
    }
  }

  for (const [entryPath, buffer] of entries.entries()) {
    if (!entryPath.startsWith('word/media/')) continue;
    if (usedPaths.has(entryPath)) continue;

    const extension = normalizeImageExt(path.extname(entryPath));
    if (!isSupportedImageExt(extension)) continue;

    const artifact = buildArtifact({
      buffer,
      extension,
      source: 'docx-media',
      name: path.basename(entryPath),
    });
    if (artifact) artifacts.push(artifact);
  }

  if (!documentXmlBuffer) {
    extractionErrors.push({
      stage: 'docx',
      message: 'word/document.xml missing in DOCX package.',
    });
  }

  return {
    text: extractDocxText(documentXmlBuffer),
    artifacts,
  };
};

const extractXlsxImageArtifacts = async (fileBuffer, extractionErrors) => {
  const entries = await loadZipEntries(fileBuffer, (entryPath) => entryPath.startsWith('xl/'));
  const rowArtifacts = new Map();
  const looseArtifacts = [];
  const usedMediaPaths = new Set();

  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf-8') || '';
  const workbookRels = parseRelationshipsXml(
    entries.get('xl/_rels/workbook.xml.rels')?.toString('utf-8') || '',
    'xl'
  );

  let firstSheetPath = 'xl/worksheets/sheet1.xml';
  const firstSheetRidMatch = workbookXml.match(/<sheet\b[^>]*r:id="([^"]+)"/i);
  if (firstSheetRidMatch && workbookRels[firstSheetRidMatch[1]]) {
    firstSheetPath = workbookRels[firstSheetRidMatch[1]];
  } else {
    const fallbackSheet = Array.from(entries.keys()).find((key) =>
      /^xl\/worksheets\/sheet\d+\.xml$/i.test(key)
    );
    if (fallbackSheet) {
      firstSheetPath = fallbackSheet;
    }
  }

  const sheetXmlText = entries.get(firstSheetPath)?.toString('utf-8') || '';
  if (!sheetXmlText) {
    extractionErrors.push({
      stage: 'xlsx',
      message: `Worksheet XML not found for ${firstSheetPath}.`,
    });
  }

  const sheetRelsPath = path.posix.join(
    path.posix.dirname(firstSheetPath),
    '_rels',
    `${path.posix.basename(firstSheetPath)}.rels`
  );
  const sheetRels = parseRelationshipsXml(
    entries.get(sheetRelsPath)?.toString('utf-8') || '',
    path.posix.dirname(firstSheetPath)
  );

  const drawingRelationshipIds = [];
  const drawingRefRegex = /<drawing\b[^>]*r:id="([^"]+)"/g;
  let drawingRefMatch;
  while ((drawingRefMatch = drawingRefRegex.exec(sheetXmlText))) {
    drawingRelationshipIds.push(drawingRefMatch[1]);
  }

  for (const drawingRid of drawingRelationshipIds) {
    const drawingPath = sheetRels[drawingRid];
    if (!drawingPath) continue;

    const drawingXmlText = entries.get(drawingPath)?.toString('utf-8') || '';
    if (!drawingXmlText) continue;

    const drawingRelsPath = path.posix.join(
      path.posix.dirname(drawingPath),
      '_rels',
      `${path.posix.basename(drawingPath)}.rels`
    );
    const drawingRels = parseRelationshipsXml(
      entries.get(drawingRelsPath)?.toString('utf-8') || '',
      path.posix.dirname(drawingPath)
    );

    const anchorRegex = /<xdr:(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
    const anchorSegments = drawingXmlText.match(anchorRegex) || [];
    for (const anchorXml of anchorSegments) {
      const rowMatch = anchorXml.match(/<xdr:row>(\d+)<\/xdr:row>/);
      const embedMatch = anchorXml.match(/r:embed="([^"]+)"/);
      if (!rowMatch || !embedMatch) continue;

      const rowIndex = Math.max(0, Number.parseInt(rowMatch[1], 10) - 1);
      const imagePath = drawingRels[embedMatch[1]];
      if (!imagePath) continue;
      const imageBuffer = entries.get(imagePath);
      if (!imageBuffer) continue;

      const extension = normalizeImageExt(path.extname(imagePath));
      if (!isSupportedImageExt(extension)) continue;

      const artifact = buildArtifact({
        buffer: imageBuffer,
        extension,
        source: 'xlsx-anchor',
        name: path.basename(imagePath),
        rowIndex,
      });
      if (!artifact) continue;

      usedMediaPaths.add(imagePath);
      if (!rowArtifacts.has(rowIndex)) {
        rowArtifacts.set(rowIndex, []);
      }
      rowArtifacts.get(rowIndex).push(artifact);
    }
  }

  for (const [entryPath, buffer] of entries.entries()) {
    if (!entryPath.startsWith('xl/media/')) continue;
    if (usedMediaPaths.has(entryPath)) continue;
    const extension = normalizeImageExt(path.extname(entryPath));
    if (!isSupportedImageExt(extension)) continue;

    const artifact = buildArtifact({
      buffer,
      extension,
      source: 'xlsx-media-unmapped',
      name: path.basename(entryPath),
    });
    if (artifact) {
      looseArtifacts.push(artifact);
    }
  }

  return { rowArtifacts, looseArtifacts };
};

const extractPdfJpegArtifacts = (fileBuffer) => {
  const artifacts = [];
  const latin1 = fileBuffer.toString('latin1');
  const objectRegex = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
  let match;

  while ((match = objectRegex.exec(latin1))) {
    const objectBody = match[3];
    if (!/\/Subtype\s*\/Image/.test(objectBody)) continue;

    const streamIndex = objectBody.indexOf('stream');
    const endStreamIndex = objectBody.indexOf('endstream', streamIndex + 6);
    if (streamIndex === -1 || endStreamIndex === -1) continue;

    let dataStart = streamIndex + 6;
    while (dataStart < endStreamIndex && (objectBody[dataStart] === '\r' || objectBody[dataStart] === '\n')) {
      dataStart += 1;
    }

    let dataEnd = endStreamIndex;
    while (dataEnd > dataStart && (objectBody[dataEnd - 1] === '\r' || objectBody[dataEnd - 1] === '\n')) {
      dataEnd -= 1;
    }

    const rawStream = Buffer.from(objectBody.slice(dataStart, dataEnd), 'latin1');
    if (rawStream.length < 4) continue;
    if (!(rawStream[0] === 0xff && rawStream[1] === 0xd8)) {
      continue;
    }

    const artifact = buildArtifact({
      buffer: rawStream,
      extension: '.jpg',
      source: 'pdf-dctdecode',
      name: `pdf-image-${artifacts.length + 1}.jpg`,
    });
    if (artifact) artifacts.push(artifact);
  }

  return artifacts;
};

const extractPdfArtifactsWithPython = async (pdfBuffer, extractionErrors) => {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) return [];

  const workingDir = path.join(
    os.tmpdir(),
    `question-import-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const sourceFilePath = path.join(workingDir, 'source.pdf');
  const scriptPath = path.join(__dirname, 'extract_pdf_images.py');
  const runtimeCandidates =
    os.platform() === 'win32'
      ? [
          { executable: 'python', prefixArgs: [] },
          { executable: 'py', prefixArgs: ['-3'] },
          { executable: 'python3', prefixArgs: [] },
        ]
      : [
          { executable: 'python3', prefixArgs: [] },
          { executable: 'python', prefixArgs: [] },
        ];
  const runtimeErrors = [];

  await fs.mkdir(workingDir, { recursive: true });
  await fs.writeFile(sourceFilePath, pdfBuffer);

  try {
    for (const runtime of runtimeCandidates) {
      try {
        const args = [...runtime.prefixArgs, scriptPath, '--input', sourceFilePath];
        const { stdout, stderr } = await execFileAsync(runtime.executable, args, {
          timeout: 120000,
          maxBuffer: 1024 * 1024 * 25,
        });

        if (sanitizeString(stderr)) {
          extractionErrors.push({
            stage: 'pdf-image-extraction',
            message: sanitizeString(stderr).slice(0, 500),
          });
        }

        let parsed;
        try {
          parsed = JSON.parse(String(stdout || '').trim() || '{}');
        } catch (parseError) {
          throw new Error(`Invalid PDF image extractor output: ${parseError?.message || 'JSON parse failed'}`);
        }

        if (parsed?.error) {
          extractionErrors.push({
            stage: 'pdf-image-extraction',
            message: sanitizeString(parsed.error),
          });
          return [];
        }

        return (Array.isArray(parsed?.images) ? parsed.images : [])
          .map((item, index) => {
            const base64Payload = sanitizeString(item?.bufferBase64 || item?.base64 || '');
            if (!base64Payload) return null;

            let buffer;
            try {
              buffer = Buffer.from(base64Payload, 'base64');
            } catch {
              return null;
            }
            if (!buffer.length) return null;

            const extension = normalizeImageExt(
              item?.extension ||
                path.extname(sanitizeString(item?.name || '')) ||
                detectMimeAndExtFromBuffer(buffer).extension ||
                '.png'
            );

            return buildArtifact({
              buffer,
              extension,
              mimeType: sanitizeString(item?.mimeType || ''),
              source: sanitizeString(item?.source || 'pdf-pymupdf'),
              name: sanitizeFilename(
                item?.name ||
                  `pdf-image-${Number.isFinite(Number(item?.pageNumber)) ? `page-${Number(item.pageNumber)}-` : ''}${index + 1}${extension}`,
                `pdf-image-${index + 1}${extension}`
              ),
              pageNumber: Number.isFinite(Number(item?.pageNumber)) ? Number(item.pageNumber) : null,
              placementIndex: Number.isFinite(Number(item?.placementIndex))
                ? Number(item.placementIndex)
                : null,
              width: Number.isFinite(Number(item?.width)) ? Number(item.width) : null,
              height: Number.isFinite(Number(item?.height)) ? Number(item.height) : null,
              pageWidth: Number.isFinite(Number(item?.pageWidth)) ? Number(item.pageWidth) : null,
              pageHeight: Number.isFinite(Number(item?.pageHeight)) ? Number(item.pageHeight) : null,
            });
          })
          .filter(Boolean);
      } catch (error) {
        const runtimeLabel = `${runtime.executable}${runtime.prefixArgs.length ? ` ${runtime.prefixArgs.join(' ')}` : ''}`;
        runtimeErrors.push(`${runtimeLabel}: ${error?.message || 'Execution failed'}`);
      }
    }

    if (runtimeErrors.length > 0) {
      extractionErrors.push({
        stage: 'pdf-image-extraction',
        message: `PyMuPDF extractor unavailable. ${runtimeErrors.join(' | ').slice(0, 900)}`,
      });
    }
    return [];
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
};

const extractPdfImageArtifacts = async (pdfBuffer, extractionErrors) => {
  const artifacts = [];

  try {
    artifacts.push(...(await extractPdfArtifactsWithPython(pdfBuffer, extractionErrors)));
  } catch (error) {
    extractionErrors.push({
      stage: 'pdf-image-extraction',
      message: error?.message || 'PyMuPDF image extraction failed.',
    });
  }

  try {
    artifacts.push(...extractPdfJpegArtifacts(pdfBuffer));
  } catch (error) {
    extractionErrors.push({
      stage: 'pdf-image-extraction',
      message: error?.message || 'JPEG fallback PDF image extraction failed.',
    });
  }

  return dedupeArtifacts(artifacts);
};

const persistArtifactForQuestion = async ({ artifact, tenantId, importSessionId, questionIndex, fileStem }) =>
  persistArtifactToStorage({
    artifact,
    tenantId,
    category: 'questions',
    subpath: ['imports', importSessionId, `q${questionIndex + 1}`],
    fileStem,
  });
const decodeDataUriToArtifact = (value, source) => {
  const match = String(value || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  let extension = '.png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) extension = '.jpg';
  if (mimeType.includes('svg')) extension = '.svg';

  const base64Payload = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64Payload, 'base64');
  if (!buffer.length) return null;

  return buildArtifact({
    buffer,
    extension,
    mimeType,
    source: source || 'data-uri',
    name: `embedded${extension}`,
  });
};

const decodeRawBase64ToArtifact = (value, source) => {
  const raw = sanitizeString(value);
  if (!raw || raw.length < 80 || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;

  const buffer = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
  if (!buffer.length) return null;

  const detected = detectMimeAndExtFromBuffer(buffer);
  if (!detected.extension || !isSupportedImageExt(detected.extension)) {
    return null;
  }

  return buildArtifact({
    buffer,
    extension: detected.extension,
    mimeType: detected.mimeType,
    source: source || 'base64',
    name: `embedded${detected.extension}`,
  });
};

const decodeInlineSvgToArtifact = (value, source) => {
  const raw = sanitizeString(value);
  if (!raw || !raw.toLowerCase().startsWith('<svg')) return null;
  const buffer = Buffer.from(raw, 'utf-8');
  return buildArtifact({
    buffer,
    extension: '.svg',
    mimeType: 'image/svg+xml',
    source: source || 'inline-svg',
    name: 'diagram.svg',
  });
};

const detectDiagramType = (questionText) => {
  const normalized = sanitizeString(questionText).toLowerCase();
  if (normalized.includes('triangle')) return 'triangle';
  if (normalized.includes('circuit')) return 'circuit';
  if (normalized.includes('map')) return 'map';
  if (normalized.includes('graph') || normalized.includes('plot')) return 'graph';
  if (normalized.includes('chart')) return 'chart';
  if (normalized.includes('figure') || normalized.includes('diagram')) return 'figure';
  return 'generic';
};

const buildDiagramPrompt = (diagramType, questionText) => {
  const baseInstruction =
    'Create a clean educational exam diagram in PNG style with a pure white background, black line art, clear labels, no watermark, and a 1024x1024 layout suitable for student assessments.';

  switch (diagramType) {
    case 'triangle':
      return `${baseInstruction} Draw a geometric triangle figure relevant to this question: "${questionText}".`;
    case 'circuit':
      return `${baseInstruction} Draw a basic circuit schematic relevant to this question: "${questionText}".`;
    case 'map':
      return `${baseInstruction} Draw a simple map-style figure relevant to this question: "${questionText}".`;
    case 'graph':
      return `${baseInstruction} Draw a graph with x and y axes relevant to this question: "${questionText}".`;
    case 'chart':
      return `${baseInstruction} Draw a clean chart figure relevant to this question: "${questionText}".`;
    case 'object_identification':
      return `Create a clear, realistic educational object image with a clean plain background, no watermark, and a 1024x1024 layout suitable for student assessments. The object must directly support this question: "${questionText}".`;
    case 'figure':
      return `${baseInstruction} Draw a clear instructional figure relevant to this question: "${questionText}".`;
    default:
      return `${baseInstruction} Draw a general instructional diagram relevant to this question: "${questionText}".`;
  }
};

const buildLocalFallbackSvg = (diagramType, questionText) => {
  const safeQuestion = sanitizeString(questionText).slice(0, 90) || 'Generated diagram';
  const label = safeQuestion.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const baseHeader = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="100%" height="100%" fill="white"/><text x="32" y="42" font-size="24" fill="#111" font-family="Arial">AI Diagram Placeholder</text><text x="32" y="76" font-size="18" fill="#222" font-family="Arial">${label}</text>`;
  const footer = `</svg>`;

  if (diagramType === 'triangle') {
    return `${baseHeader}<polygon points="220,520 480,160 740,520" fill="none" stroke="#111" stroke-width="6"/><text x="470" y="145" font-size="20" fill="#111" font-family="Arial">A</text><text x="200" y="545" font-size="20" fill="#111" font-family="Arial">B</text><text x="745" y="545" font-size="20" fill="#111" font-family="Arial">C</text>${footer}`;
  }
  if (diagramType === 'graph' || diagramType === 'chart') {
    return `${baseHeader}<line x1="150" y1="540" x2="820" y2="540" stroke="#111" stroke-width="5"/><line x1="150" y1="540" x2="150" y2="150" stroke="#111" stroke-width="5"/><polyline points="170,500 280,430 390,460 520,320 640,360 760,220" fill="none" stroke="#111" stroke-width="4"/><text x="830" y="550" font-size="18" fill="#111" font-family="Arial">X</text><text x="135" y="135" font-size="18" fill="#111" font-family="Arial">Y</text>${footer}`;
  }
  if (diagramType === 'circuit') {
    return `${baseHeader}<line x1="170" y1="320" x2="300" y2="320" stroke="#111" stroke-width="5"/><rect x="300" y="285" width="160" height="70" fill="none" stroke="#111" stroke-width="4"/><line x1="460" y1="320" x2="610" y2="320" stroke="#111" stroke-width="5"/><line x1="610" y1="320" x2="610" y2="470" stroke="#111" stroke-width="5"/><line x1="610" y1="470" x2="170" y2="470" stroke="#111" stroke-width="5"/><line x1="170" y1="470" x2="170" y2="320" stroke="#111" stroke-width="5"/><line x1="190" y1="395" x2="190" y2="435" stroke="#111" stroke-width="4"/><line x1="210" y1="385" x2="210" y2="445" stroke="#111" stroke-width="4"/><text x="346" y="330" font-size="18" fill="#111" font-family="Arial">R</text>${footer}`;
  }
  if (diagramType === 'map') {
    return `${baseHeader}<path d="M220 190 L430 150 L610 210 L730 340 L670 500 L470 560 L280 520 L190 360 Z" fill="none" stroke="#111" stroke-width="5"/><circle cx="470" cy="340" r="16" fill="#111"/><text x="495" y="348" font-size="18" fill="#111" font-family="Arial">Point A</text>${footer}`;
  }

  return `${baseHeader}<rect x="180" y="170" width="620" height="360" fill="none" stroke="#111" stroke-width="5"/><line x1="180" y1="260" x2="800" y2="260" stroke="#111" stroke-width="3"/><line x1="180" y1="350" x2="800" y2="350" stroke="#111" stroke-width="3"/><line x1="180" y1="440" x2="800" y2="440" stroke="#111" stroke-width="3"/><text x="210" y="235" font-size="18" fill="#111" font-family="Arial">Figure</text>${footer}`;
};

const generateDiagramArtifact = async ({
  diagramType,
  questionText,
  extractionErrors,
  allowPlaceholderFallback = true,
  maxRetries = 3,
}) => {
  const warnings = Array.isArray(extractionErrors) ? extractionErrors : [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const safeRetries = Math.max(1, Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 3);

  if (isImageGenConfigured()) {
    for (let attempt = 0; attempt < safeRetries; attempt += 1) {
      try {
        const response = await runEngineImageGeneration({
          feature: 'question_image_generation',
          request: {
            model: getModelForOperation(AI_OPERATIONS.QUESTION_IMAGE_GENERATION),
            prompt: buildDiagramPrompt(diagramType, sanitizeString(questionText).slice(0, 500)),
            size: '1536x1024',
            background: 'opaque',
            output_format: 'png',
            quality: 'high',
            n: 1,
          },
        });

        const responseItem = response?.data?.[0];
        const base64 = responseItem?.b64_json;
        if (base64) {
          const buffer = Buffer.from(base64, 'base64');
          if (buffer.length) {
            const artifact = buildArtifact({
              buffer,
              extension: '.png',
              mimeType: 'image/png',
              source: 'ai-generated',
              name: `ai-${diagramType}.png`,
            });
            if (artifact) {
              artifact.generatedByAI = true;
              return artifact;
            }
          }
        }

        const generatedUrl = sanitizeString(responseItem?.url);
        if (generatedUrl) {
          const imageResponse = await fetch(generatedUrl);
          if (imageResponse.ok) {
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
            if (imageBuffer.length) {
              const detected = detectMimeAndExtFromBuffer(imageBuffer);
              const artifact = buildArtifact({
                buffer: imageBuffer,
                extension: detected.extension || '.png',
                mimeType: detected.mimeType || 'image/png',
                source: 'ai-generated',
                name: `ai-${diagramType}${detected.extension || '.png'}`,
              });
              if (artifact) {
                artifact.generatedByAI = true;
                return artifact;
              }
            }
          } else {
            warnings.push({
              stage: 'ai-image-generation',
              attempt: attempt + 1,
              message: `Generated image URL fetch failed with status ${imageResponse.status}.`,
            });
          }
        }

        warnings.push({
          stage: 'ai-image-generation',
          attempt: attempt + 1,
          message: 'OpenAI image generation returned an empty image payload.',
        });
      } catch (error) {
        warnings.push({
          stage: 'ai-image-generation',
          attempt: attempt + 1,
          message: error.message || 'Unknown AI image generation error',
        });
      }

      if (attempt < safeRetries - 1) {
        await wait((attempt + 1) * 1200);
      }
    }
  }

  if (!allowPlaceholderFallback) {
    return null;
  }

  const fallbackSvg = buildLocalFallbackSvg(diagramType, questionText);
  const fallbackArtifact = buildArtifact({
    buffer: Buffer.from(fallbackSvg, 'utf-8'),
    extension: '.svg',
    mimeType: 'image/svg+xml',
    source: 'local-fallback',
    name: `fallback-${diagramType}.svg`,
  });
  if (fallbackArtifact) {
    fallbackArtifact.generatedByAI = false;
  }
  return fallbackArtifact;
};

export const createGeneratedQuestionImage = async ({
  tenantId = null,
  examId = '',
  questionId = '',
  questionText = '',
  diagramType = '',
  imagePrompt = '',
  fileStem = 'generated-diagram',
}) => {
  const warnings = [];
  const safeExamId = sanitizeString(examId);
  const safeQuestionId =
    sanitizeString(questionId) ||
    `generated-question-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const requestedType = sanitizeString(diagramType).toLowerCase();
  const normalizedDiagramType =
    requestedType || detectDiagramType(questionText);
  const generationPrompt = sanitizeString(imagePrompt) || sanitizeString(questionText);

  const artifact = await generateDiagramArtifact({
    diagramType: normalizedDiagramType,
    questionText: generationPrompt,
    extractionErrors: warnings,
    allowPlaceholderFallback: false,
    maxRetries: 3,
  });

  if (!artifact) {
    return {
      image: '',
      imageUrl: '',
      image_path: '',
      imageBase64: '',
      image_base64: '',
      generatedImage: '',
      generated_image: '',
      warnings,
    };
  }

  const generatedImage = await persistArtifactToStorage({
    artifact,
    tenantId,
    examId: safeExamId || undefined,
    category: 'questions',
    subpath: [safeQuestionId],
    fileStem,
  });
  const imageBase64 = artifactToDataUri(artifact);
  const primaryImage = sanitizeString(generatedImage || imageBase64);
  const storedQuestionImageUrl = sanitizeString(generatedImage);

  return {
    image: primaryImage,
    imageUrl: storedQuestionImageUrl,
    image_path: storedQuestionImageUrl,
    imageBase64,
    image_base64: imageBase64,
    generatedImage: '',
    generated_image: '',
    warnings,
  };
};

const appendToMapArray = (map, key, value) => {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
};

const parseImageRefToArtifact = (imageReference) => {
  const dataUri = decodeDataUriToArtifact(imageReference, 'row-data-uri');
  if (dataUri) return dataUri;

  const inlineSvg = decodeInlineSvgToArtifact(imageReference, 'row-inline-svg');
  if (inlineSvg) return inlineSvg;

  const rawBase64 = decodeRawBase64ToArtifact(imageReference, 'row-base64');
  if (rawBase64) return rawBase64;

  return null;
};

const pickRowIndexForQuestion = ({
  question,
  questionIndex,
  rowTextMap,
  rowUsage,
  structuredRows,
}) => {
  if (Number.isInteger(question?.sourceRowIndex)) {
    return question.sourceRowIndex;
  }

  const questionKey = normalizeTextKey(question?.questionText || '');
  if (questionKey && rowTextMap.has(questionKey)) {
    const options = rowTextMap.get(questionKey);
    for (const rowIndex of options) {
      if (!rowUsage.has(rowIndex)) return rowIndex;
    }
    return options[0];
  }

  if (questionKey) {
    let bestIndex = null;
    let bestScore = 0;
    for (let idx = 0; idx < structuredRows.length; idx += 1) {
      const rowText = extractQuestionTextFromRow(structuredRows[idx]);
      const rowKey = normalizeTextKey(rowText);
      if (!rowKey) continue;
      if (rowUsage.has(idx)) continue;

      if (questionKey.includes(rowKey) || rowKey.includes(questionKey)) {
        const score = Math.min(questionKey.length, rowKey.length) / Math.max(questionKey.length, rowKey.length);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = idx;
        }
      }
    }
    if (bestIndex !== null) return bestIndex;
  }

  if (questionIndex < structuredRows.length && !rowUsage.has(questionIndex)) {
    return questionIndex;
  }

  return null;
};

const extractQuestionsFromScannedBlocks = async ({
  blocks,
  extractionErrors,
}) => {
  const parsedQuestions = [];
  const safeBlocks = Array.isArray(blocks) ? blocks : [];

  for (const block of safeBlocks) {
    const blockPath = sanitizeString(
      block?.ocrBlockPreprocessedImagePath
        || block?.ocrBlockImagePath
        || block?.preprocessedBlockImagePath
        || block?.blockImagePath
        || ''
    );
    if (!blockPath) continue;

    const plainTextResult = await extractStructuredQuestionWithVision({
      primaryImagePath: blockPath,
      fallbackImagePath: sanitizeString(
        block?.ocrBlockImagePath || block?.blockImagePath || ''
      ),
      blockIndex: Number.isFinite(Number(block?.blockIndex)) ? Number(block.blockIndex) : parsedQuestions.length + 1,
      extractionErrors,
    });

    const question = plainTextResult;

    const diagramUrl = sanitizeString(block?.diagramImageUrl || '');
    const blockImageUrl = sanitizeString(block?.blockImageUrl || '');
    const mediaRequirement = classifyImportMediaRequirement({
      questionText: question?.questionText || '',
      sourceImageRequired: questionLikelyReferencesImportedImage(question?.questionText || ''),
    });
    const allowBlockMedia = shouldAttachSourceMedia(mediaRequirement);

    if (!question || !sanitizeString(question.questionText)) {
      // Keep import usable even when OCR/vision cannot parse this block.
      // Admin can edit in preview before saving.
      parsedQuestions.push({
        questionNumber: null,
        questionText: `Scanned question block ${parsedQuestions.length + 1} (OCR review required)`,
        questionType: 'MULTIPLE_CHOICE',
        options: ['Option A', 'Option B', 'Option C', 'Option D'],
        correctAnswer: '',
        points: 1,
        order: parsedQuestions.length,
        ocrConfidence: 0,
        imageUrl: allowBlockMedia ? (diagramUrl || blockImageUrl || undefined) : undefined,
        image_path: allowBlockMedia ? (diagramUrl || blockImageUrl || undefined) : undefined,
        mediaRequirement,
        sourceRowIndex: parsedQuestions.length,
      });
      continue;
    }

    if (allowBlockMedia) {
      if (diagramUrl) {
        question.imageUrl = diagramUrl;
      } else if (blockImageUrl) {
        question.imageUrl = blockImageUrl;
      }
      question.image_path = question.imageUrl || '';
    }
    question.mediaRequirement = mediaRequirement;

    if (!sanitizeString(question.questionText)) {
      extractionErrors.push({
        stage: 'scanned-question-validation',
        message: `Missing OCR text for block ${parsedQuestions.length + 1}.`,
      });
    } else if (question.questionType === 'MULTIPLE_CHOICE') {
      const optionCount = Array.isArray(question.options) ? question.options.filter(Boolean).length : 0;
      if (optionCount < 2) {
        extractionErrors.push({
          stage: 'scanned-question-validation',
          message: `Weak option detection for block ${parsedQuestions.length + 1}.`,
        });
      }
    }

    question.sourceRowIndex = parsedQuestions.length;
    parsedQuestions.push(question);
  }

  return ensureUniqueQuestionText(parsedQuestions).map((question, index) => ({
    ...question,
    order: index,
    sourceRowIndex: index,
  }));
};

// Resolves a model-reported option letter/text into one of the extracted
// option strings, tolerant of the model answering with "A", "Option A",
// or the option's own text.
const resolveCorrectAnswerFromOptions = (rawAnswer, options) => {
  const answer = sanitizeString(rawAnswer);
  if (!answer || !Array.isArray(options) || !options.length) return '';
  const letterMatch = answer.match(/^[ABCD]$/i) || answer.match(/^option\s*([ABCD])$/i);
  if (letterMatch) {
    const index = letterMatch[1].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
    if (options[index]) return options[index];
  }
  const exactMatch = options.find((option) => sanitizeString(option).toLowerCase() === answer.toLowerCase());
  if (exactMatch) return exactMatch;
  return '';
};

const extractQuestionsFromPdfVisionDirect = async ({
  pdfBuffer,
  extractionErrors,
}) => {
  if (!isVisionConfigured()) return [];
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) return [];
  if (pdfBuffer.length > 8 * 1024 * 1024) {
    extractionErrors.push({
      stage: 'pdf-vision-structured',
      message: 'PDF too large for direct AI vision structured extraction.',
    });
    return [];
  }

  try {
    const dataUri = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
    const completion = await engineImportChat({
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Extract MCQ questions from these exam pages, reading the actual rendered page — not just the text layer — ' +
              'so you can see visual formatting. Return JSON with {"questions":[{questionText, options:{A,B,C,D}, ' +
              'questionNumber, correctAnswerLetter, correctAnswerConfidence}]}. ' +
              'For correctAnswerLetter: identify which option (A, B, C, or D) is visually marked as the correct answer — ' +
              'this may be shown via a colored/yellow highlight background behind the option, bold or colored option text, ' +
              'an underline, a circled/boxed option, a checkmark, or an asterisk next to the option. ' +
              'If no option is visually marked, leave correctAnswerLetter empty rather than guessing from content alone. ' +
              'Set correctAnswerConfidence to "high" when a clear visual marking (highlight/bold/circle/checkmark) is present, ' +
              '"low" if you are inferring from wording only, or omit it if correctAnswerLetter is empty. ' +
              'Each options value must contain only the candidate-visible option wording: omit option labels, answer markers ' +
              '(such as [CORRECT]), page headers/footers, document titles, instructions, section headings, and text from the next question. ' +
              'Keep source wording concise.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Read this PDF and extract all visible MCQ questions with options. Pay close attention to any ' +
                  'highlighted, bolded, colored, circled, or checkmarked option — that marks the correct answer. Do not copy ' +
                  'the visual marker, a [CORRECT] text-layer tag, page chrome, or section headings into the option text.',
              },
              {
                type: 'image_url',
                image_url: { url: dataUri },
              },
            ],
          },
        ],
    });

    const parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const normalized = list
      .map((item, index) => {
        const questionText = sanitizeString(item?.questionText || item?.question || item?.text || '');
        if (!questionText) return null;
        const optionsObj = item?.options && typeof item.options === 'object' ? item.options : {};
        const options = ['A', 'B', 'C', 'D']
          .map((key, index) =>
            normalizeOptionValue(optionsObj?.[key] || optionsObj?.[key.toLowerCase()] || '', index)
          )
          .filter(Boolean);
        // Only trust a visually-marked correct answer (high confidence) —
        // a low-confidence content-only guess is not what "highlighted
        // answer" detection promises and would just be a coin-flip fed
        // into the exam.
        const confidence = sanitizeString(item?.correctAnswerConfidence).toLowerCase();
        const correctAnswer =
          confidence === 'high'
            ? resolveCorrectAnswerFromOptions(item?.correctAnswerLetter, options)
            : '';
        return {
          questionNumber: Number.isFinite(Number(item?.questionNumber))
            ? Number(item.questionNumber)
            : null,
          questionText,
          questionType: options.length >= 2 ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER',
          options: options.length >= 2 ? options : undefined,
          correctAnswer,
          points: 1,
          order: index,
          sourceRowIndex: index,
          ocrConfidence: 0.5,
        };
      })
      .filter(Boolean);

    return ensureUniqueQuestionText(normalized);
  } catch (error) {
    extractionErrors.push({
      stage: 'pdf-vision-structured',
      message: error?.message || 'Direct PDF structured extraction with AI vision failed.',
    });
    return [];
  }
};

export const parseQuestionImportFile = async (file, { tenantId, userId } = {}) => {
  activeImportTrackingContext = {
    tenantId: tenantId || null,
    userId: userId || null,
  };
  try {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  const extractionErrors = [];
  const importSessionId = makeImportSessionId();
  const rowImageReferences = new Map();
  const rowEmbeddedArtifacts = new Map();
  let text = '';
  let structuredRows = null;
  let visionCandidates = null;
  let pageTexts = [];
  let pageCount = 0;
  const extractedArtifacts = [];

  if (extension === '.txt') {
    text = file.buffer.toString('utf-8');
  } else if (extension === '.csv') {
    text = file.buffer.toString('utf-8');
    structuredRows = parseCsvRows(file.buffer);
  } else if (extension === '.xlsx' || extension === '.xls') {
    structuredRows = await parseExcelRows(file.buffer, extension);
    text = buildStructuredText(structuredRows);

    try {
      const xlsxImages = await extractXlsxImageArtifacts(file.buffer, extractionErrors);
      for (const [rowIndex, artifacts] of xlsxImages.rowArtifacts.entries()) {
        rowEmbeddedArtifacts.set(rowIndex, artifacts);
      }
      extractedArtifacts.push(...xlsxImages.looseArtifacts);
    } catch (imageExtractionError) {
      extractionErrors.push({
        stage: 'xlsx-image-extraction',
        message: imageExtractionError?.message || 'Failed to extract XLSX images.',
      });
    }
  } else if (extension === '.docx') {
    try {
      const docxData = await extractDocxArtifacts(file.buffer, extractionErrors);
      text = docxData.text;
      extractedArtifacts.push(...docxData.artifacts);
    } catch (docxError) {
      const parseError = new Error(
        docxError?.message || 'Failed to parse DOCX file. Please verify the file and try again.'
      );
      parseError.statusCode =
        Number.isFinite(Number(docxError?.statusCode)) && Number(docxError.statusCode) >= 400 && Number(docxError.statusCode) < 500
          ? Number(docxError.statusCode)
          : 400;
      throw parseError;
    }
  } else if (extension === '.pdf') {
    pageCount = estimatePdfPageCount(file.buffer);
    try {
      const parsed = await pdfParse(file.buffer);
      text = sanitizeString(parsed?.text);
      pageTexts = splitPdfTextIntoPages(text, pageCount);
      if (!pageCount && pageTexts.length) {
        pageCount = pageTexts.length;
      }
    } catch (error) {
      extractionErrors.push({
        stage: 'pdf-text',
        message: error.message || 'Failed to read PDF text',
      });
    }
    try {
      extractedArtifacts.push(...(await extractPdfImageArtifacts(file.buffer, extractionErrors)));
    } catch (imageError) {
      extractionErrors.push({
        stage: 'pdf-image-extraction',
        message: imageError?.message || 'Failed to extract PDF images.',
      });
    }

    const markerCount = countNumberedQuestionMarkers(text);
    // The full-PDF direct-vision pass is a large multimodal call (the whole
    // PDF, base64) and it runs on every PDF. When the embedded text layer is
    // already strong and cleanly numbered, the deterministic structural
    // parsers produce the questions with no AI at all and this call's result
    // is discarded during reconciliation — so skip it and save the round
    // trip. Its unique value (reading a *visually* highlighted answer key)
    // still applies to weak/short/scanned text, where it still runs.
    // Set QUESTION_IMPORT_FORCE_PDF_VISION=true to always run it.
    const pagesForRatio = Math.max(pageCount, pageTexts.length, 1);
    const trimmedTextLength = sanitizeString(text).length;
    const textLayerStrong =
      markerCount >= 3 &&
      trimmedTextLength >= 1200 &&
      trimmedTextLength >= 300 * pagesForRatio;
    const skipDirectVision =
      textLayerStrong && process.env.QUESTION_IMPORT_FORCE_PDF_VISION !== 'true';
    if (skipDirectVision) {
      extractionErrors.push({
        stage: 'pdf-vision-skipped',
        message: 'Strong embedded text layer detected — skipped the full-PDF AI vision pass for speed.',
      });
    }
    const directVisionQuestions = skipDirectVision
      ? []
      : await extractQuestionsFromPdfVisionDirect({
          pdfBuffer: file.buffer,
          extractionErrors,
        });
    if (directVisionQuestions.length > 0) {
      visionCandidates = directVisionQuestions;
      const coverage = assessVisionCoverage({
        visionRowCount: directVisionQuestions.length,
        pageCount,
        textLength: sanitizeString(text).length,
        markerCount,
        documentMapCount: markerCount,
      });
      if (coverage.authoritative) {
        structuredRows = directVisionQuestions;
        if (!text) {
          text = directVisionQuestions.map((q) => q.questionText).join('\n\n');
        }
      } else {
        extractionErrors.push({
          stage: 'pdf-vision-undercoverage',
          message:
            `Direct PDF vision returned ${directVisionQuestions.length} question(s) for a ${pageCount || pageTexts.length || 'multi'}-page document; deferring to structural extraction.`,
        });
      }
    }

    // Scanned PDF fallback: render pages -> detect blocks -> extract question text with vision.
    // Reached when structural extraction is unavailable or direct vision under-covered.
    const needsScannedFallback =
      (!Array.isArray(structuredRows) || structuredRows.length === 0) &&
      (
        !text ||
        (
          (pageCount >= 2 || pageTexts.length >= 2) &&
          markerCount < 2 &&
          (!Array.isArray(visionCandidates) || visionCandidates.length <= 1)
        )
      );
    if (needsScannedFallback) {
      let scanned = { blocks: [], pages: [], workingDir: '' };
      try {
        scanned = await runScannedPdfProcessor({
          sourceBuffer: file.buffer,
          inputExtension: extension,
          importSessionId,
          tenantId,
          extractionErrors,
        });
      } catch (scannedError) {
        extractionErrors.push({
          stage: 'scanned-pdf-processor',
          message: scannedError?.message || 'Failed to persist scanned PDF images.',
        });
      }

      const scannedQuestions = await extractQuestionsFromScannedBlocks({
        blocks: scanned.blocks,
        extractionErrors,
      });
      if (scanned.workingDir) {
        await fs.rm(scanned.workingDir, { recursive: true, force: true }).catch(() => {});
      }

      if (scannedQuestions.length > 0) {
        structuredRows = scannedQuestions;
        const synthesizedText = scannedQuestions
          .map((q, idx) => {
            const optionsText = Array.isArray(q.options)
              ? q.options.map((opt, optIdx) => `${String.fromCharCode(65 + optIdx)}. ${opt}`).join('\n')
              : '';
            return `Q${idx + 1}. ${q.questionText}${optionsText ? `\n${optionsText}` : ''}`;
          })
          .join('\n\n');
        text = synthesizedText;
      }

      // If pages were rendered but text extraction did not succeed, keep import editable.
      if (
        (!Array.isArray(structuredRows) || structuredRows.length === 0) &&
        Array.isArray(scanned?.pages) &&
        scanned.pages.length > 0
      ) {
        const pagePlaceholders = scanned.pages.slice(0, 25).map((page, idx) => {
          const imageUrl = sanitizeString(page?.rawImageUrl || page?.preprocessedImageUrl || '');
          return {
            questionText: `Scanned PDF page ${idx + 1} (diagram/manual review required)`,
            questionType: 'MULTIPLE_CHOICE',
            options: ['Option A', 'Option B', 'Option C', 'Option D'],
            correctAnswer: '',
            points: 1,
            order: idx,
            sourceRowIndex: idx,
            imageUrl: imageUrl || undefined,
          };
        });
        if (pagePlaceholders.length > 0) {
          structuredRows = pagePlaceholders;
          text = pagePlaceholders.map((row) => row.questionText).join('\n');
          extractionErrors.push({
            stage: 'pdf-scanned-placeholder',
            message: 'Scanned PDF imported in manual-review mode because OCR extraction was unavailable.',
          });
        }
      }

      // Last-resort fallback: preserve importability with reviewable placeholders.
      if (!Array.isArray(structuredRows) || structuredRows.length === 0) {
        const placeholderRows = [];
        const estimatedPageCount = estimatePdfPageCount(file.buffer);
        const placeholderTarget = Math.min(
          Math.max(
            extractedArtifacts.length,
            estimatedPageCount,
            looksLikePdfBuffer(file.buffer) ? 1 : 0
          ),
          25
        );

        for (let idx = 0; idx < placeholderTarget; idx += 1) {
          let imageUrl = '';
          const artifact = extractedArtifacts[idx];
          if (artifact) {
            try {
              imageUrl = await persistArtifactForQuestion({
                artifact,
                tenantId,
                importSessionId,
                questionIndex: idx,
                fileStem: 'scanned-page',
              });
            } catch (persistError) {
              extractionErrors.push({
                stage: 'pdf-manual-review-fallback',
                message: persistError?.message || 'Failed to persist placeholder image.',
              });
            }
          }

          placeholderRows.push({
            questionText: `Imported scanned question ${idx + 1} with diagram (manual review required)`,
            questionType: 'MULTIPLE_CHOICE',
            options: ['Option A', 'Option B', 'Option C', 'Option D'],
            correctAnswer: '',
            points: 1,
            order: idx,
            sourceRowIndex: idx,
            imageUrl: imageUrl || undefined,
          });
        }
        if (placeholderRows.length > 0) {
          structuredRows = placeholderRows;
          text = placeholderRows.map((row) => row.questionText).join('\n');
          extractionErrors.push({
            stage: 'pdf-manual-review-fallback',
            message:
              'PDF imported with manual-review placeholders because neither OCR nor direct vision extraction produced structured text.',
          });
        }
      }
    }
  } else if (['.png', '.jpg', '.jpeg', '.svg'].includes(extension)) {
    const uploadedArtifact = buildArtifact({
      buffer: file.buffer,
      extension,
      source: 'uploaded-image',
      name: sanitizeFilename(file?.originalname || `uploaded${extension}`),
    });
    if (uploadedArtifact) {
      extractedArtifacts.push(uploadedArtifact);
    }

    // Image input path: run the same scanned-layout pipeline for raster images.
    if (extension !== '.svg') {
      let scanned = { blocks: [], pages: [], workingDir: '' };
      try {
        scanned = await runScannedPdfProcessor({
          sourceBuffer: file.buffer,
          inputExtension: extension,
          importSessionId,
          tenantId,
          extractionErrors,
        });
      } catch (scannedError) {
        extractionErrors.push({
          stage: 'scanned-pdf-processor',
          message: scannedError?.message || 'Failed to persist scanned image.',
        });
      }

      const scannedQuestions = await extractQuestionsFromScannedBlocks({
        blocks: scanned.blocks,
        extractionErrors,
      });
      if (scanned.workingDir) {
        await fs.rm(scanned.workingDir, { recursive: true, force: true }).catch(() => {});
      }
      if (scannedQuestions.length > 0) {
        structuredRows = scannedQuestions;
        text = scannedQuestions
          .map((q, idx) => {
            const optionsText = Array.isArray(q.options)
              ? q.options.map((opt, optIdx) => `${String.fromCharCode(65 + optIdx)}. ${opt}`).join('\n')
              : '';
            return `Q${idx + 1}. ${q.questionText}${optionsText ? `\n${optionsText}` : ''}`;
          })
          .join('\n\n');
      }
    }

    // Structured fallback for single-image imports while preserving the diagram.
    if ((!Array.isArray(structuredRows) || structuredRows.length === 0) && uploadedArtifact) {
      let uploadedImageUrl = '';
      try {
        uploadedImageUrl = await persistArtifactForQuestion({
          artifact: uploadedArtifact,
          tenantId,
          importSessionId,
          questionIndex: 0,
          fileStem: 'uploaded-question-image',
        });
      } catch (persistError) {
        extractionErrors.push({
          stage: 'image-import',
          message: persistError?.message || 'Failed to persist uploaded image.',
        });
      }

      const uploadedImageDataUri = await uploadUrlToDataUri(uploadedImageUrl);
      if (uploadedImageDataUri) {
        const extracted = await extractStructuredQuestionWithVision({
          primaryDataUri: uploadedImageDataUri,
          fallbackDataUri: uploadedImageDataUri,
          blockIndex: 1,
          extractionErrors,
        });

        if (extracted && sanitizeString(extracted.questionText)) {
          extracted.imageUrl = uploadedImageUrl || undefined;
          extracted.image_path = uploadedImageUrl || undefined;
          extracted.sourceRowIndex = 0;
          extracted.order = 0;
          structuredRows = [extracted];
          const optionsText = Array.isArray(extracted.options)
            ? extracted.options.map((opt, optIdx) => `${String.fromCharCode(65 + optIdx)}. ${opt}`).join('\n')
            : '';
          text = `Q1. ${extracted.questionText}${optionsText ? `\n${optionsText}` : ''}`;
        }
      }
    }
  } else {
    const unsupportedError = new Error(
      'Unsupported file type. Allowed: PDF, TXT, CSV, XLSX, XLS, DOCX, PNG, JPG, JPEG, SVG.'
    );
    unsupportedError.statusCode = 400;
    throw unsupportedError;
  }

  if (Array.isArray(structuredRows)) {
    structuredRows.forEach((row, rowIndex) => {
      const imageRef = extractImageReferenceFromRow(row);
      if (imageRef) {
        appendToMapArray(rowImageReferences, rowIndex, imageRef);
      }
    });
  }

  console.log('[question-import-debug] FILE EXTENSION:', extension);
  console.log('[question-import-debug] RAW TEXT:', text);
  console.log(
    '[question-import-debug] STRUCTURED ROW COUNT:',
    Array.isArray(structuredRows) ? structuredRows.length : 0
  );
  console.log(
    '[question-import-debug] EXTRACTED IMAGE ARTIFACT COUNT:',
    Array.isArray(extractedArtifacts) ? extractedArtifacts.length : 0
  );

  return {
    extension,
    text: sanitizeString(text),
    structuredRows,
    visionCandidates,
    pageTexts,
    pageCount,
    importSessionId,
    extractedArtifacts,
    rowImageReferences,
    rowEmbeddedArtifacts,
    extractionErrors,
  };
  } finally {
    activeImportTrackingContext = { tenantId: null, userId: null };
  }
};

export const attachImagesToImportedQuestions = async ({
  questions,
  structuredRows,
  extractedArtifacts,
  rowImageReferences,
  rowEmbeddedArtifacts,
  extractionErrors,
  importSessionId,
  tenantId,
  // When false, only images actually present in the uploaded file
  // (mapped/extracted artifacts) are attached — no AI-generated diagram
  // and no local-SVG-fallback diagram is ever created for a question
  // whose text merely mentions a diagram/chart. Defaults to true to
  // preserve prior behavior for any other future caller; the
  // /import-questions route explicitly passes false.
  generateMissingDiagrams = true,
}) => {
  const safeQuestions = Array.isArray(questions) ? questions.map((question) => ({ ...question })) : [];
  const safeRows = Array.isArray(structuredRows) ? structuredRows : [];
  const safeArtifacts = Array.isArray(extractedArtifacts) ? [...extractedArtifacts] : [];
  const rowRefMap = rowImageReferences instanceof Map ? rowImageReferences : new Map();
  const rowEmbeddedMap = rowEmbeddedArtifacts instanceof Map ? rowEmbeddedArtifacts : new Map();
  const errors = Array.isArray(extractionErrors) ? extractionErrors : [];

  const rowTextMap = new Map();
  safeRows.forEach((row, rowIndex) => {
    const key = normalizeTextKey(extractQuestionTextFromRow(row));
    if (!key) return;
    appendToMapArray(rowTextMap, key, rowIndex);
  });

  const artifactByName = new Map();
  safeArtifacts.forEach((artifact) => {
    const baseName = sanitizeFilename(path.basename(artifact.name || ''), '').toLowerCase();
    if (baseName) {
      artifactByName.set(baseName, artifact);
    }
  });

  const usedArtifactIds = new Set();
  const rowUsage = new Set();
  const aiDiagramCache = new Map();
  let totalExtractedImageCount = safeArtifacts.length;
  for (const list of rowEmbeddedMap.values()) {
    totalExtractedImageCount += Array.isArray(list) ? list.length : 0;
  }
  let mappedImageCount = 0;
  let aiGeneratedCount = 0;
  let fallbackGeneratedCount = 0;
  let sourceMediaExtractedCount = 0;
  let sourceRegionPreviewCount = 0;
  let mediaValidationFailures = 0;

  for (let index = 0; index < safeQuestions.length; index += 1) {
    const question = safeQuestions[index];
    question.mediaRequirement = classifyImportMediaRequirement(question);
  }

  const persistArtifactSafely = async ({ artifact, questionIndex, fileStem, stage }) => {
    try {
      return await persistArtifactForQuestion({
        artifact,
        tenantId,
        importSessionId,
        questionIndex,
        fileStem,
      });
    } catch (error) {
      errors.push({
        stage,
        message: error?.message || 'Failed to persist extracted image.',
      });
      return '';
    }
  };

  const verifyUploadImageUrlExists = async (imageUrl, stage) => {
    const normalized = sanitizeString(imageUrl);
    if (!normalized) return '';
    if (!normalized.startsWith('/uploads/')) {
      return normalized;
    }

    if (await imageExists({ url: normalized })) {
      return normalized;
    }

    errors.push({
      stage,
      message: `Image file not found during import validation: ${normalized}`,
    });
    return '';
  };

  const consumeRowEmbeddedArtifact = (rowIndex) => {
    if (!rowEmbeddedMap.has(rowIndex)) return null;
    const list = rowEmbeddedMap.get(rowIndex);
    while (list.length) {
      const artifact = list.shift();
      if (!artifact || usedArtifactIds.has(artifact.id)) continue;
      usedArtifactIds.add(artifact.id);
      return artifact;
    }
    return null;
  };

  const consumeLooseArtifact = () => {
    while (safeArtifacts.length) {
      const artifact = safeArtifacts.shift();
      if (!artifact || usedArtifactIds.has(artifact.id)) continue;
      usedArtifactIds.add(artifact.id);
      return artifact;
    }
    return null;
  };

  const rowHasImageMarker = (row) => hasInlineImageMarker(getRawQuestionTextFromRow(row));

  for (let index = 0; index < safeQuestions.length; index += 1) {
    const question = safeQuestions[index];
    const questionText = sanitizeString(question.questionText || question.question_text || '');
    const existingImageValue = sanitizeString(
      question.imageUrl || question.image_path || question.imagePath || ''
    );

    const rowIndex = pickRowIndexForQuestion({
      question,
      questionIndex: index,
      rowTextMap,
      rowUsage,
      structuredRows: safeRows,
    });
    if (rowIndex !== null) {
      rowUsage.add(rowIndex);
    }

    const row = rowIndex !== null ? safeRows[rowIndex] : null;
    const rowText = row ? getRawQuestionTextFromRow(row) : '';
    const mediaRequirement = classifyImportMediaRequirement({
      ...question,
      questionText: questionText || rowText,
    });
    question.mediaRequirement = mediaRequirement;
    const expectsImportedImage = shouldAttachSourceMedia(mediaRequirement)
      || (
        mediaRequirement === MEDIA_REQUIREMENTS.VISUAL_REQUIREMENT_UNCERTAIN
        && (questionLikelyReferencesImportedImage(questionText) || questionLikelyReferencesImportedImage(rowText))
      );

    let resolvedImageUrl = '';

    if (existingImageValue && shouldAttachSourceMedia(mediaRequirement)) {
      if (looksLikeUrl(existingImageValue)) {
        resolvedImageUrl = existingImageValue;
      } else {
        const directArtifact = parseImageRefToArtifact(existingImageValue);
        if (directArtifact) {
          resolvedImageUrl = await persistArtifactSafely({
            artifact: directArtifact,
            questionIndex: index,
            fileStem: 'question',
            stage: 'persist-inline-question-image',
          });
        } else {
          const byName = artifactByName.get(existingImageValue.toLowerCase());
          if (byName) {
            resolvedImageUrl = await persistArtifactSafely({
              artifact: byName,
              questionIndex: index,
              fileStem: 'question',
              stage: 'persist-linked-question-image',
            });
            usedArtifactIds.add(byName.id);
          }
        }
      }
    }

    if (!resolvedImageUrl && shouldAttachSourceMedia(mediaRequirement) && rowIndex !== null) {
      const embedded = consumeRowEmbeddedArtifact(rowIndex);
      if (embedded) {
        resolvedImageUrl = await persistArtifactSafely({
          artifact: embedded,
          questionIndex: index,
          fileStem: 'embedded',
          stage: 'persist-embedded-row-image',
        });
      }
    }

    if (!resolvedImageUrl && shouldAttachSourceMedia(mediaRequirement) && rowIndex !== null && rowRefMap.has(rowIndex)) {
      const refs = rowRefMap.get(rowIndex);
      while (refs.length && !resolvedImageUrl) {
        const reference = sanitizeString(refs.shift());
        if (!reference) continue;

        if (looksLikeUrl(reference)) {
          resolvedImageUrl = reference;
          break;
        }

        const decoded = parseImageRefToArtifact(reference);
        if (decoded) {
          resolvedImageUrl = await persistArtifactSafely({
            artifact: decoded,
            questionIndex: index,
            fileStem: 'row',
            stage: 'persist-row-reference-image',
          });
          break;
        }

        const referencedArtifact = artifactByName.get(reference.toLowerCase());
        if (referencedArtifact) {
          usedArtifactIds.add(referencedArtifact.id);
          resolvedImageUrl = await persistArtifactSafely({
            artifact: referencedArtifact,
            questionIndex: index,
            fileStem: 'row-linked',
            stage: 'persist-row-linked-image',
          });
          break;
        }
      }
    }

    if (!resolvedImageUrl && expectsImportedImage) {
      const looseArtifact = consumeLooseArtifact();
      if (looseArtifact) {
        resolvedImageUrl = await persistArtifactSafely({
          artifact: looseArtifact,
          questionIndex: index,
          fileStem: 'extracted',
          stage: 'persist-loose-question-image',
        });
      }
    }

    if (resolvedImageUrl && !shouldAttachSourceMedia(mediaRequirement)) {
      sourceRegionPreviewCount += 1;
      resolvedImageUrl = '';
    }

    if (resolvedImageUrl) {
      resolvedImageUrl = await verifyUploadImageUrlExists(resolvedImageUrl, 'validate-import-image-path');
      question.imageUrl = resolvedImageUrl;
      if (resolvedImageUrl) {
        mappedImageCount += 1;
        sourceMediaExtractedCount += 1;
      }
    }
  }

  // Never attach leftover PDF images to arbitrary text-only questions.
  // Source visuals must be semantically required before persistence.

  if (generateMissingDiagrams) {
    for (let index = 0; index < safeQuestions.length; index += 1) {
      const question = safeQuestions[index];
      if (sanitizeString(question.imageUrl)) continue;
      if (classifyImportMediaRequirement(question) !== MEDIA_REQUIREMENTS.NEW_AI_VISUAL_REQUIRED) continue;
      if (!DIAGRAM_KEYWORD_REGEX.test(sanitizeString(question.questionText))) continue;

      const diagramType = detectDiagramType(question.questionText);
      let cached = aiDiagramCache.get(diagramType);
      if (!cached) {
        cached = await generateDiagramArtifact({
          diagramType,
          questionText: question.questionText,
          extractionErrors: errors,
        });
        if (cached) aiDiagramCache.set(diagramType, cached);
      }
      if (!cached) continue;

      question.imageUrl = await persistArtifactSafely({
        artifact: cached,
        questionIndex: index,
        fileStem: cached.generatedByAI ? `ai-${diagramType}` : `fallback-${diagramType}`,
        stage: cached.generatedByAI ? 'persist-ai-generated-image' : 'persist-fallback-generated-image',
      });
      if (!question.imageUrl) continue;

      if (cached.generatedByAI) {
        aiGeneratedCount += 1;
      } else {
        fallbackGeneratedCount += 1;
      }
    }
  }

  safeQuestions.forEach((question, index) => {
    const policyApplied = applyImportMediaPolicy(question);
    safeQuestions[index] = policyApplied;
    const validation = validateImportQuestionMedia(policyApplied);
    if (!validation.ok && validation.reason !== 'missing-required-source-visual') {
      mediaValidationFailures += 1;
      errors.push({
        stage: 'import-media-validation',
        message: `Question ${index + 1}: ${validation.reason}`,
      });
    }
  });

  logImportMediaClassification(safeQuestions);

  safeQuestions.forEach((question) => {
    const cleanedQuestionText = stripInlineImageMarkers(
      question.questionText || question.question_text || question.question || ''
    );
    if (cleanedQuestionText) {
      question.questionText = cleanedQuestionText;
      question.question_text = cleanedQuestionText;
    }
    if (sanitizeString(question.imageUrl).includes('/generated_images/')) {
      question.generatedImage = sanitizeString(question.imageUrl);
    }
    if (!sanitizeString(question.imageUrl)) {
      delete question.imageUrl;
    }
    delete question.sourceRowIndex;
  });

  for (const question of safeQuestions) {
    const normalizedImageUrl = normalizeUploadUrl(question.imageUrl || question.generatedImage);
    if (!sanitizeString(question.imageBase64) && normalizedImageUrl) {
      question.imageBase64 = await uploadUrlToDataUri(normalizedImageUrl);
    }
    question.image_path = sanitizeString(question.imageUrl || question.generatedImage || '');
    question.image_base64 = sanitizeString(question.imageBase64);
    question.generated_image = sanitizeString(question.generatedImage);
    delete question.imagePath;
  }

  return {
    questions: safeQuestions,
    report: {
      extractedImageCount: totalExtractedImageCount,
      mappedImageCount,
      sourceMediaExtractedCount,
      sourceRegionPreviewCount,
      aiGeneratedCount,
      aiGeneratedImageCount: aiGeneratedCount,
      aiImageGenerationAttempts: aiGeneratedCount + fallbackGeneratedCount,
      fallbackGeneratedCount,
      mediaValidationFailures,
      extractionErrors: errors.slice(0, 100),
    },
  };
};

export const extractTextFromImageArtifacts = async ({
  artifacts,
  maxImages = 8,
}) => {
  const warnings = [];
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  if (!safeArtifacts.length) {
    return { text: '', warnings };
  }

  if (!isVisionConfigured()) {
    warnings.push({
      stage: 'ocr-images',
      message: 'Gemini API key is not configured for OCR fallback.',
    });
    return { text: '', warnings };
  }

  const selected = safeArtifacts
    .filter((artifact) => artifact?.mimeType?.startsWith('image/'))
    .slice(0, Math.max(1, maxImages));

  const textChunks = [];
  for (const artifact of selected) {
    const dataUri = artifactToDataUri(artifact);
    if (!dataUri) continue;

    try {
      const response = await engineImportChat({
        temperature: 0,
        messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    'Extract all visible exam content exactly from this image. Keep question numbers, options, and line breaks. Return only extracted text.',
                },
                {
                  type: 'image_url',
                  image_url: { url: dataUri },
                },
              ],
            },
          ],
      });

      const extracted = sanitizeString(response?.choices?.[0]?.message?.content || '');
      if (extracted) {
        textChunks.push(extracted);
      }
    } catch (error) {
      warnings.push({
        stage: 'ocr-images',
        message: error?.message || 'Failed to OCR one of the extracted images.',
      });
    }
  }

  return {
    text: textChunks.join('\n\n').trim(),
    warnings,
  };
};

export const extractTextFromPdfBufferWithVision = async ({
  pdfBuffer,
  maxBytes = 4 * 1024 * 1024,
}) => {
  const warnings = [];
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    return { text: '', warnings };
  }

  if (!isVisionConfigured()) {
    warnings.push({
      stage: 'ocr-pdf',
      message: 'Gemini API key is not configured for scanned PDF OCR fallback.',
    });
    return { text: '', warnings };
  }

  if (pdfBuffer.length > maxBytes) {
    warnings.push({
      stage: 'ocr-pdf',
      message: 'PDF is too large for direct OCR fallback payload.',
    });
    return { text: '', warnings };
  }

  try {
    const dataUri = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
    const response = await engineImportChat({
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Extract all visible exam text from this PDF. Preserve question numbering, options, and line breaks. Return only extracted text.',
              },
              {
                type: 'image_url',
                image_url: { url: dataUri },
              },
            ],
          },
        ],
    });

    return {
      text: sanitizeString(response?.choices?.[0]?.message?.content || ''),
      warnings,
    };
  } catch (error) {
    warnings.push({
      stage: 'ocr-pdf',
      message: error?.message || 'Direct scanned PDF OCR fallback failed.',
    });
    return { text: '', warnings };
  }
};
export const questionRequiresImageSupport = (question, { allowKeywordInference = true } = {}) => {
  if (!question || typeof question !== 'object') return false;

  const existingImageValue = [
    question.imageUrl,
    question.image_path,
    question.imagePath,
    question.imageBase64,
    question.image_base64,
    question.generatedImage,
    question.generated_image,
  ].some((value) => sanitizeString(value));

  if (existingImageValue) {
    return true;
  }

  if (!allowKeywordInference) {
    return false;
  }

  return DIAGRAM_KEYWORD_REGEX.test(sanitizeString(question.questionText || question.question_text));
};

const applyQuestionImageUpdates = (question, updates = {}) => {
  if (!question || typeof question !== 'object') {
    return false;
  }

  const normalizedUpdates = {
    imageUrl:
      updates.imageUrl !== undefined
        ? sanitizeString(updates.imageUrl)
        : undefined,
    imageBase64:
      updates.imageBase64 !== undefined
        ? sanitizeString(updates.imageBase64)
        : undefined,
    generatedImage:
      updates.generatedImage !== undefined
        ? sanitizeString(updates.generatedImage)
        : undefined,
  };

  let changed = false;
  Object.entries(normalizedUpdates).forEach(([key, value]) => {
    if (value === undefined) return;
    const current = sanitizeString(question[key]);
    if (current === value) return;
    question[key] = value || '';
    changed = true;
  });

  return changed;
};

export const ensureQuestionImageAvailability = async ({
  question,
  tenantId = null,
  examId,
  questionId = null,
  persist = true,
  forceGenerate = false,
  allowGeneratedImageCreation = false,
  allowKeywordInference = true,
}) => {
  if (!question || typeof question !== 'object') {
    return {
      question,
      changed: false,
      regenerated: false,
      restoredFromBase64: false,
      warnings: [],
    };
  }

  const warnings = [];
  const effectiveForceGenerate = Boolean(forceGenerate && allowGeneratedImageCreation);
  if (forceGenerate && !allowGeneratedImageCreation) {
    warnings.push({
      stage: 'question-image-recovery',
      message: 'AI image generation is disabled for this recovery request.',
    });
  }
  const resolvedQuestionId = sanitizeString(
    questionId ||
      question._id ||
      question.id ||
      question.uniqueId ||
      ''
  );
  const safeExamId = sanitizeString(examId);

  const rawImageUrl = sanitizeString(question.imageUrl || question.image_path || question.imagePath || '');
  const rawGeneratedImage = sanitizeString(question.generatedImage || question.generated_image || '');
  const rawImageBase64 = sanitizeString(question.imageBase64 || question.image_base64 || '');
  const rawImageUrlIsPlaceholder =
    containsPlaceholderMarker(rawImageUrl) ||
    (await uploadUrlContainsPlaceholderMarker(rawImageUrl));
  const rawGeneratedImageIsPlaceholder =
    containsPlaceholderMarker(rawGeneratedImage) ||
    (await uploadUrlContainsPlaceholderMarker(rawGeneratedImage));
  const rawImageBase64IsPlaceholder = containsPlaceholderMarker(rawImageBase64);

  const rawImageUrlLooksGenerated = isGeneratedImageReference(rawImageUrl);
  const restoreBase64IntoGeneratedField =
    (Boolean(rawGeneratedImage) && !rawGeneratedImageIsPlaceholder) ||
    (rawImageUrlLooksGenerated && !rawImageUrlIsPlaceholder) ||
    (isGeneratedImageReference(rawImageBase64) && !rawImageBase64IsPlaceholder);

  let imageUrl = rawImageUrlLooksGenerated || rawImageUrlIsPlaceholder ? '' : rawImageUrl;
  let generatedImage =
    rawGeneratedImageIsPlaceholder
      ? ''
      : rawGeneratedImage || (rawImageUrlLooksGenerated && !rawImageUrlIsPlaceholder ? rawImageUrl : '');
  let imageBase64 = rawImageBase64IsPlaceholder ? '' : rawImageBase64;

  const shouldManageImage =
    effectiveForceGenerate ||
    questionRequiresImageSupport(question, { allowKeywordInference });

  if (!shouldManageImage) {
    applyQuestionImageUpdates(question, {
      imageUrl,
      imageBase64,
      generatedImage,
    });
    return {
      question,
      changed: false,
      regenerated: false,
      restoredFromBase64: false,
      warnings,
    };
  }

  if (!effectiveForceGenerate && safeExamId && resolvedQuestionId && imageUrl) {
    const relocatedImageUrl = await relocateImportedQuestionImage({
      imageUrl,
      tenantId,
      examId: safeExamId,
      questionId: resolvedQuestionId,
    });
    if (sanitizeString(relocatedImageUrl)) {
      imageUrl = sanitizeString(relocatedImageUrl);
    }
  }

  const normalizedImageUploadUrl = normalizeUploadUrl(imageUrl);
  const normalizedGeneratedUploadUrl = normalizeUploadUrl(generatedImage);

  const imageUrlExists =
    !effectiveForceGenerate &&
    Boolean(normalizedImageUploadUrl) &&
    (await uploadUrlExists(normalizedImageUploadUrl));
  const generatedImageExists =
    !effectiveForceGenerate &&
    Boolean(normalizedGeneratedUploadUrl) &&
    (await uploadUrlExists(normalizedGeneratedUploadUrl));

  if (!imageUrlExists && !generatedImageExists && imageBase64) {
    const restoredArtifact = parseImageRefToArtifact(imageBase64);
    if (restoredArtifact) {
      const restoredUrl = await persistArtifactToStorage({
        artifact: restoredArtifact,
        tenantId,
        examId: safeExamId || undefined,
        category: restoreBase64IntoGeneratedField ? 'generated_images' : 'questions',
        subpath: [resolvedQuestionId || 'question-image'],
        fileStem: 'restored-image',
      });
      if (restoredUrl) {
        if (restoreBase64IntoGeneratedField) {
          generatedImage = restoredUrl;
        } else {
          imageUrl = restoredUrl;
        }
      }
    }
  }

  let regenerated = false;
  let restoredFromBase64 = Boolean(!imageUrlExists && !generatedImageExists && imageBase64);

  const resolvedImageUploadUrl = normalizeUploadUrl(imageUrl);
  const resolvedGeneratedUploadUrl = normalizeUploadUrl(generatedImage);
  const hasRemoteImageUrl =
    !effectiveForceGenerate && Boolean(imageUrl) && !resolvedImageUploadUrl;
  const hasRemoteGeneratedImage =
    !effectiveForceGenerate && Boolean(generatedImage) && !resolvedGeneratedUploadUrl;
  const hasResolvedImage =
    hasRemoteImageUrl ||
    hasRemoteGeneratedImage ||
    (!effectiveForceGenerate && Boolean(resolvedImageUploadUrl) && (await uploadUrlExists(resolvedImageUploadUrl))) ||
    (!effectiveForceGenerate && Boolean(resolvedGeneratedUploadUrl) && (await uploadUrlExists(resolvedGeneratedUploadUrl)));

  if (!hasResolvedImage && effectiveForceGenerate) {
    const artifact = await generateDiagramArtifact({
      diagramType: detectDiagramType(question.questionText || question.question_text || ''),
      questionText: sanitizeString(question.questionText || question.question_text || ''),
      extractionErrors: warnings,
      allowPlaceholderFallback: false,
      maxRetries: 3,
    });

    if (artifact) {
      const generatedUrl = await persistArtifactToStorage({
        artifact,
        tenantId,
        examId: safeExamId || undefined,
        category: 'generated_images',
        subpath: [resolvedQuestionId || 'question-image'],
        fileStem: 'generated-diagram',
      });
      const generatedBase64 = artifactToDataUri(artifact);

      if (generatedUrl) {
        generatedImage = generatedUrl;
        imageUrl = '';
      }
      if (generatedBase64) {
        imageBase64 = generatedBase64;
      }
      regenerated = Boolean(generatedUrl || generatedBase64);
      restoredFromBase64 = false;
    }
  }

  if (!imageBase64) {
    const primaryImageSourceUrl = normalizeUploadUrl(imageUrl);
    const fallbackGeneratedSourceUrl = normalizeUploadUrl(generatedImage);

    if (primaryImageSourceUrl) {
      imageBase64 = await uploadUrlToDataUri(primaryImageSourceUrl);
    }

    if (!imageBase64 && fallbackGeneratedSourceUrl) {
      imageBase64 = await uploadUrlToDataUri(fallbackGeneratedSourceUrl);
    }
  }

  const changed = applyQuestionImageUpdates(question, {
    imageUrl,
    imageBase64,
    generatedImage,
  });

  if (persist && changed && typeof question.save === 'function') {
    await question.save();
  }

  return {
    question,
    changed,
    regenerated,
    restoredFromBase64,
    warnings,
  };
};

export const ensureQuestionsImageAvailability = async ({
  questions,
  tenantId = null,
  examId,
  persist = true,
  forceGenerate = false,
  allowGeneratedImageCreation = false,
  allowKeywordInference = true,
}) => {
  const safeQuestions = Array.isArray(questions) ? questions : [];
  const warnings = [];

  for (const question of safeQuestions) {
    const result = await ensureQuestionImageAvailability({
      question,
      tenantId,
      examId,
      persist,
      forceGenerate,
      allowGeneratedImageCreation,
      allowKeywordInference,
    });
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
  }

  return {
    questions: safeQuestions,
    warnings,
  };
};

export const relocateImportedQuestionImage = async ({
  imageUrl,
  tenantId,
  examId,
  questionId,
}) => {
  const normalizedUrl = sanitizeString(imageUrl);
  const localUploadUrl = normalizeUploadUrl(normalizedUrl);
  if (!normalizedUrl) {
    return normalizedUrl;
  }

  if (!localUploadUrl) {
    return normalizedUrl;
  }

  if (localUploadUrl.startsWith('/uploads/generated_images/')) {
    return localUploadUrl;
  }

  if (!(await imageExists({ url: localUploadUrl }))) {
    return normalizedUrl;
  }

  const sourceKey = s3UrlToKey(localUploadUrl);
  const filename = sanitizeFilename(path.basename(sourceKey || localUploadUrl), 'diagram.png');
  const destination = buildImageLocation({
    tenantId,
    examId,
    category: 'questions',
    subpath: [String(questionId)],
    filename,
  });

  if (destination.url === localUploadUrl) {
    return localUploadUrl;
  }

  const moved = await moveImage({ sourceUrl: localUploadUrl, destinationUrl: destination.url });
  return moved?.url || localUploadUrl;
};
