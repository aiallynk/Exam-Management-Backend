import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import AnswerScript from '../../models/AnswerScript.js';
import AnswerScriptPage from '../../models/AnswerScriptPage.js';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';
import { getPrivateObjectBuffer, putPrivateObject } from '../storage/imageStorage.js';
import { parseNormalizerStdout } from './answerScriptNormalizationContract.js';
import { PYTHON_CANDIDATES, looksLikePythonEnvProblem, PYTHON_ENV_HINT } from './pythonRuntime.js';
import { buildVisionDirectNormalization } from './visionDirectNormalizationService.js';
import { logError } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NORMALIZER_PATH = path.join(__dirname, 'normalize_answer_script.py');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export const runPythonJsonProcess = ({ executable, args, timeoutMs = 8 * 60 * 1000, maxBuffer = 4 * 1024 * 1024 }) => new Promise((resolve) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = { stdout: [], stderr: [] };
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    resolve(payload);
  };
  const collect = (stream, key) => {
    stream.on('data', (chunk) => {
      const next = (key === 'stdout' ? stdoutBytes : stderrBytes) + chunk.length;
      if (next > maxBuffer) {
        child.kill('SIGTERM');
        finish({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'), exitCode: null, error: new Error('Normalizer output exceeded the capture buffer.') });
        return;
      }
      chunks[key].push(chunk);
      if (key === 'stdout') stdoutBytes = next;
      else stderrBytes = next;
    });
  };
  collect(child.stdout, 'stdout');
  collect(child.stderr, 'stderr');
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'), exitCode: null, error: new Error('Answer-sheet normalization timed out.') });
  }, timeoutMs);
  child.on('error', (error) => {
    clearTimeout(timer);
    finish({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'), exitCode: null, error });
  });
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    finish({
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      exitCode,
      error: null,
    });
  });
});

const runNormalizer = async ({ sourcePath, outputDir, mimeType }) => {
  const args = [
    NORMALIZER_PATH,
    '--input', sourcePath,
    '--output', outputDir,
    '--mime-type', mimeType || 'application/pdf',
    '--working-dpi', String(offlineEvaluationConfig.NORMAL_WORKING_DPI),
    '--working-long-edge', String(offlineEvaluationConfig.WORKING_LONG_EDGE_PX),
    '--preview-long-edge', String(offlineEvaluationConfig.PREVIEW_LONG_EDGE_PX),
    '--thumbnail-long-edge', String(offlineEvaluationConfig.THUMBNAIL_LONG_EDGE_PX),
    '--identity-fraction', String(offlineEvaluationConfig.IDENTITY_HEADER_FRACTION),
    '--max-pages', String(offlineEvaluationConfig.MAX_ANSWER_SCRIPT_PAGES),
  ];
  // Try each candidate interpreter (or just the pinned OFFLINE_EVAL_PYTHON).
  // A spawn ENOENT (interpreter missing) falls through to the next; anything
  // that actually produced output stops the loop.
  let run = null;
  for (const executable of PYTHON_CANDIDATES) {
    // eslint-disable-next-line no-await-in-loop
    run = await runPythonJsonProcess({ executable, args });
    if (run.error?.code === 'ENOENT' && PYTHON_CANDIDATES.length > 1) continue;
    break;
  }
  if (run.stderr?.trim()) {
    logError(new Error(run.stderr.trim().slice(0, 800)), 'answerScriptNormalization.stderr');
  }
  // Deployed-box misconfiguration (missing cv2/pymupdf/numpy, missing libGL,
  // no python3 on PATH) — log an actionable hint instead of a bare failure.
  if (looksLikePythonEnvProblem(run.stderr) || run.error?.code === 'ENOENT') {
    logError(new Error(`${PYTHON_ENV_HINT} — stderr: ${String(run.stderr || run.error?.message || '').slice(0, 400)}`), 'answerScriptNormalization.pythonEnv');
  }
  if (run.error && !run.stdout?.trim()) {
    run.error.code ||= 'NORMALIZATION_FAILED';
    run.error.safeMessage = 'PDF processing failed while preparing page images.';
    throw run.error;
  }
  return parseNormalizerStdout({ stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode });
};

// Page-preparation strategy. The Gemini vision model reads and evaluates the
// handwriting in every mode; this only decides how the upload is turned into
// per-page inputs. Default is VISION_DIRECT — no local Python.
const resolveNormalization = async ({ sourcePath, outputDir, mimeType, sourceBuffer }) => {
  const mode = offlineEvaluationConfig.NORMALIZE_MODE;
  const runVisionDirect = () => buildVisionDirectNormalization({
    sourceBuffer,
    mimeType,
    outputDir,
    maxPages: offlineEvaluationConfig.MAX_ANSWER_SCRIPT_PAGES,
  });

  if (mode === 'VISION_DIRECT') return runVisionDirect();
  if (mode === 'PYTHON') return runNormalizer({ sourcePath, outputDir, mimeType });

  // AUTO — prefer the Python rasterizer (nicer previews/deskew) but never let
  // a missing interpreter or dependency block the Gemini-based evaluation.
  try {
    return await runNormalizer({ sourcePath, outputDir, mimeType });
  } catch (error) {
    logError(
      new Error(`Python normalizer unavailable (${error.code || error.message}); using the Python-free vision-direct path so Gemini can still read the pages. ${PYTHON_ENV_HINT}`),
      'answerScriptNormalization.autoFallback',
    );
    return runVisionDirect();
  }
};

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

// When `extension`/`contentType` aren't forced, derive them from the file the
// Python normalizer actually wrote — the raw (fitz-only) mode emits PNG when
// the local PyMuPDF build has no native JPEG encoder, so we must not mislabel
// those bytes as image/jpeg for the downstream Gemini vision call.
const uploadDerivative = async ({ script, localPath, fileStem, category, extension, contentType }) => {
  const buffer = await fs.readFile(localPath);
  const ext = (extension && extension.replace(/^\./, '')) || path.extname(String(localPath)).replace(/^\./, '').toLowerCase() || 'jpg';
  const mime = contentType || MIME_BY_EXT[`.${ext}`] || 'image/jpeg';
  const stored = await putPrivateObject({
    tenantId: script.tenantId,
    category,
    subpath: [String(script.examId), String(script._id)],
    fileStem,
    extension: ext,
    buffer,
    contentType: mime,
  });
  return { key: stored.key, checksum: sha256(buffer), sizeBytes: buffer.length };
};

export const normalizeAnswerScript = async ({ answerScriptId }) => {
  const script = await AnswerScript.findById(answerScriptId);
  if (!script) throw Object.assign(new Error('Answer script not found.'), { code: 'ANSWER_SCRIPT_NOT_FOUND' });
  if (script.stageCheckpoints?.get?.('NORMALIZE')?.completedAt && script.normalizedObject?.key) {
    return { script, pages: await AnswerScriptPage.find({ answerScriptId: script._id }).sort({ pageNumber: 1 }) };
  }

  const sourceKey = script.originalObject?.key || script.sourceFile?.key;
  if (!sourceKey) throw Object.assign(new Error('The finalized original object is missing.'), { code: 'SOURCE_UNREADABLE' });
  const originalBuffer = await getPrivateObjectBuffer({ key: sourceKey });
  if (!originalBuffer?.length) throw Object.assign(new Error('The uploaded source file could not be read from private storage.'), { code: 'SOURCE_UNREADABLE' });
  if (originalBuffer.length > offlineEvaluationConfig.MAX_ANSWER_SCRIPT_SIZE_BYTES) {
    throw Object.assign(new Error('The uploaded answer sheet exceeds the configured file-size limit.'), { code: 'FILE_TOO_LARGE' });
  }

  const actualChecksum = sha256(originalBuffer);
  const expectedChecksum = script.uploadSession?.expectedChecksum || script.originalObject?.checksum || script.sourceFile?.checksum;
  if (expectedChecksum && expectedChecksum !== actualChecksum) {
    throw Object.assign(new Error('The uploaded object checksum does not match the registered file.'), { code: 'CHECKSUM_MISMATCH' });
  }
  const duplicate = await AnswerScript.findOne({
    _id: { $ne: script._id },
    tenantId: script.tenantId,
    examId: script.examId,
    $or: [{ 'originalObject.checksum': actualChecksum }, { 'sourceFile.checksum': actualChecksum }],
    status: { $nin: ['CANCELLED', 'FAILED'] },
  }).select('_id').lean();
  if (duplicate) {
    script.status = 'POSSIBLE_DUPLICATE';
    script.statusReason = 'The same answer-sheet content already exists for this assessment.';
    script.duplicate = { status: 'POSSIBLE_DUPLICATE', existingAnswerScriptId: duplicate._id, detectedAt: new Date() };
    script.originalObject.checksum = actualChecksum;
    script.sourceFile.checksum = actualChecksum;
    await script.save();
    return { script, duplicate: true, existingAnswerScriptId: duplicate._id };
  }

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), `xamigo-answer-${script._id}-`));
  const extension = script.mimeType === 'application/pdf' ? '.pdf' : (script.mimeType === 'image/png' ? '.png' : '.jpg');
  const sourcePath = path.join(workingDir, `source${extension}`);
  const outputDir = path.join(workingDir, 'output');
  try {
    await fs.writeFile(sourcePath, originalBuffer);
    await fs.mkdir(outputDir, { recursive: true });
    const result = await resolveNormalization({
      sourcePath,
      outputDir,
      mimeType: script.mimeType,
      sourceBuffer: originalBuffer,
    });
    const normalizedMimeType = result.normalizedMimeType || 'application/pdf';

    const normalized = await uploadDerivative({
      script,
      localPath: result.normalizedPdf,
      fileStem: 'normalized-working-master',
      category: 'answer-script-normalized',
      contentType: normalizedMimeType,
    });
    const pages = [];
    let previewBytes = 0;
    let thumbnailBytes = 0;
    for (const item of result.pages) {
      // VISION_DIRECT emits PDF page files; PYTHON emits JPEGs. Carry the real
      // type through so the downstream Gemini data: URI is labelled correctly.
      const pageMimeType = item.mimeType || 'image/jpeg';
      const [workingImage, previewImage, thumbnailImage, identityHeaderImage] = await Promise.all([
        uploadDerivative({ script, localPath: item.working, fileStem: `page-${item.pageNumber}-working`, category: 'answer-script-working' }),
        uploadDerivative({ script, localPath: item.preview, fileStem: `page-${item.pageNumber}-preview`, category: 'answer-script-preview' }),
        uploadDerivative({ script, localPath: item.thumbnail, fileStem: `page-${item.pageNumber}-thumbnail`, category: 'answer-script-thumbnail' }),
        uploadDerivative({ script, localPath: item.identity, fileStem: `page-${item.pageNumber}-identity`, category: 'answer-script-identity' }),
      ]);
      previewBytes += previewImage.sizeBytes;
      thumbnailBytes += thumbnailImage.sizeBytes;
      const page = await AnswerScriptPage.findOneAndUpdate(
        { tenantId: script.tenantId, answerScriptId: script._id, pageNumber: item.pageNumber },
        {
          $set: {
            image: { key: workingImage.key, url: null, mimeType: pageMimeType },
            workingImage: { ...workingImage, widthPx: item.widthPx, heightPx: item.heightPx, dpi: item.workingDpi, colorMode: item.colorMode, mimeType: pageMimeType },
            previewImage: { ...previewImage, widthPx: item.widthPx, heightPx: item.heightPx },
            thumbnailImage,
            identityHeaderImage: { ...identityHeaderImage, mimeType: pageMimeType },
            contentHash: item.contentHash,
            normalizedCrop: item.crop,
            status: 'PROCESSED',
            qualityStatus: item.qualityStatus,
            qualityMeta: {
              isLikelyBlank: Boolean(item.isLikelyBlank), widthPx: item.widthPx, heightPx: item.heightPx,
              estimatedDpi: item.workingDpi, rotationDetectedDegrees: 0,
              deskewDegrees: item.deskewDegrees || 0, colorRelevant: Boolean(item.colorRelevant),
            },
            processingError: '',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      pages.push(page);
    }

    script.originalObject.checksum = actualChecksum;
    script.originalObject.sizeBytes = originalBuffer.length;
    script.sourceFile.checksum = actualChecksum;
    script.sourceFile.sizeBytes = originalBuffer.length;
    script.normalizedObject = {
      ...normalized,
      mimeType: normalizedMimeType,
      generatedAt: new Date(),
      profile: result.mode === 'VISION_DIRECT'
        ? 'vision-direct/pdf-page-split'
        : `${offlineEvaluationConfig.NORMAL_WORKING_DPI}dpi/${offlineEvaluationConfig.WORKING_LONG_EDGE_PX}px-adaptive`,
    };
    script.pageCount = pages.length;
    script.storageMetrics = {
      ...script.storageMetrics,
      originalBytes: originalBuffer.length,
      normalizedBytes: normalized.sizeBytes,
      previewBytes,
      thumbnailBytes,
      compressionRatio: originalBuffer.length ? Number((normalized.sizeBytes / originalBuffer.length).toFixed(4)) : null,
    };
    script.stageCheckpoints.set('NORMALIZE', {
      completedAt: new Date(), inputHash: actualChecksum, outputHash: normalized.checksum,
      pageCount: pages.length, profile: script.normalizedObject.profile,
    });
    await script.save();
    return { script, pages, duplicate: false };
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
};

