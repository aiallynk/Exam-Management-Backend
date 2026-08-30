import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import config from '../../config/env.js';
import { putPrivateObject } from '../storage/imageStorage.js';
import { assessPageQuality } from './pageQualityService.js';
import { PYTHON_CANDIDATES } from './pythonRuntime.js';
import { logError } from '../../utils/logger.js';

// Multi-page PDF -> per-page images. Reuses the SAME Python rasterizer
// (services/import_scanned_pdf.py, 300 DPI) that
// services/questionImportImageService.js's runScannedPdfProcessor already
// uses for question-paper import — see
// docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md Part 3/12. Not a copy of
// that function: it uploads via the PUBLIC putImage, which is wrong for
// candidate answer scripts (see imageStorage.js's PRIVATE_ROOT_PREFIX
// comment), so this module drives the same script directly and uploads
// each page via putPrivateObject instead.

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'import_scanned_pdf.py');

const getUploadsRoot = () =>
  path.isAbsolute(config.uploadDir) ? config.uploadDir : path.join(process.cwd(), config.uploadDir);

// Honors OFFLINE_EVAL_PYTHON / PYTHON_BIN (see ./pythonRuntime.js) so a
// deployment can pin the venv that has cv2 / pymupdf / numpy installed.
const runtimeCandidates = PYTHON_CANDIDATES.map((executable) =>
  executable === 'py' ? { executable, prefixArgs: ['-3'] } : { executable, prefixArgs: [] }
);

const rasterizePdf = async ({ pdfBuffer, sessionId }) => {
  const workingDir = path.join(getUploadsRoot(), 'answer-scripts', 'tmp', sessionId);
  await fs.mkdir(workingDir, { recursive: true });
  const sourcePath = path.join(workingDir, 'source.pdf');
  await fs.writeFile(sourcePath, pdfBuffer);

  const args = ['--input', sourcePath, '--output', workingDir, '--dpi', '300'];
  const runtimeErrors = [];
  for (const runtime of runtimeCandidates) {
    try {
      const { stdout, stderr } = await execFileAsync(runtime.executable, [...runtime.prefixArgs, SCRIPT_PATH, ...args], {
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 25,
      });
      if (stderr && stderr.trim()) logError(new Error(stderr.trim().slice(0, 500)), { context: 'pdfPageSplitter.rasterizePdf.stderr', sessionId });
      const parsed = JSON.parse(String(stdout || '').trim() || '{}');
      if (parsed?.error) return { pages: [], workingDir, error: String(parsed.error) };
      return { pages: Array.isArray(parsed?.pages) ? parsed.pages : [], workingDir, error: null };
    } catch (error) {
      runtimeErrors.push(`${runtime.executable}: ${error?.message || 'execution failed'}`);
    }
  }
  return { pages: [], workingDir, error: `PDF page rasterization failed on every available Python runtime. ${runtimeErrors.join(' | ').slice(0, 900)}` };
};

const cleanupWorkingDir = async (workingDir) => {
  if (!workingDir) return;
  try { await fs.rm(workingDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
};

// Returns [{ pageNumber, key, ...quality }] for a multi-page PDF, or a
// single-entry array for a plain image upload (no rasterization needed).
export const splitIntoPages = async ({ buffer, mimeType, tenantId, answerScriptId }) => {
  const isPdf = mimeType === 'application/pdf';
  if (!isPdf) {
    const quality = await assessPageQuality(buffer);
    const stored = await putPrivateObject({ tenantId, category: 'answer-scripts', subpath: [String(answerScriptId)], fileStem: 'page-1', extension: mimeType?.split('/')?.[1] || 'jpg', buffer, contentType: mimeType });
    return [{ pageNumber: 1, key: stored?.key || null, ...quality }];
  }

  const sessionId = String(answerScriptId);
  const { pages, workingDir, error } = await rasterizePdf({ pdfBuffer: buffer, sessionId });
  if (error) {
    await cleanupWorkingDir(workingDir);
    const wrapped = new Error(error);
    wrapped.code = 'PAGE_SPLIT_FAILED';
    throw wrapped;
  }

  const results = [];
  for (const page of pages) {
    const pageNumber = Number.isFinite(Number(page?.pageNumber)) ? Number(page.pageNumber) : results.length + 1;
    const localPath = page?.preprocessedImage || page?.rawImage;
    if (!localPath) { results.push({ pageNumber, key: null, qualityStatus: 'UNREADABLE', error: 'Rasterizer produced no image for this page.' }); continue; }
    try {
      const pageBuffer = await fs.readFile(localPath);
      const quality = await assessPageQuality(pageBuffer);
      const stored = await putPrivateObject({ tenantId, category: 'answer-scripts', subpath: [sessionId], fileStem: `page-${pageNumber}`, extension: 'jpg', buffer: pageBuffer, contentType: 'image/jpeg' });
      results.push({ pageNumber, key: stored?.key || null, ...quality });
    } catch (pageError) {
      logError(pageError, { context: 'pdfPageSplitter.splitIntoPages.page', pageNumber, answerScriptId });
      results.push({ pageNumber, key: null, qualityStatus: 'UNREADABLE', error: pageError.message });
    }
  }

  await cleanupWorkingDir(workingDir);
  return results.sort((a, b) => a.pageNumber - b.pageNumber);
};
