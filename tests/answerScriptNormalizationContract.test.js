import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  parseNormalizerStdout,
  NORMALIZER_INVALID_RESPONSE,
  NORMALIZER_NO_PAGES,
} from '../services/offlineEvaluation/answerScriptNormalizationContract.js';
import { educatorMessageForError, describeAnswerScriptFailure } from '../services/offlineEvaluation/answerScriptFailure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NORMALIZER = path.join(__dirname, '../services/offlineEvaluation/normalize_answer_script.py');

const run = (executable, args, { timeoutMs = 120000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error('timed out'));
  }, timeoutMs);
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
  });
});

describe('answer-script normalization JSON contract', () => {
  test('rejects MuPDF-style warning leakage on stdout instead of scraping braces', () => {
    assert.throws(
      () => parseNormalizerStdout({
        stdout: 'warning: ToUnicode CMap is missing\n{"pageCount":1,"pages":[{"pageNumber":1}],"normalizedPdf":"/tmp/n.pdf"}',
        exitCode: 0,
      }),
      (error) => error.code === NORMALIZER_INVALID_RESPONSE && !error.message.includes('Unexpected token'),
    );
  });

  test('does not use substring-to-first-brace as the primary parser', () => {
    const source = path.join(__dirname, '../services/offlineEvaluation/answerScriptNormalizationService.js');
    return fs.readFile(source, 'utf8').then((text) => {
      assert.equal(text.includes("stdout.indexOf('{')"), false);
      assert.equal(text.includes('JSON.parse(stdout'), false);
    });
  });

  test('accepts a single JSON object on stdout', () => {
    const parsed = parseNormalizerStdout({
      stdout: '{"normalizedPdf":"/tmp/n.pdf","pageCount":1,"pages":[{"pageNumber":1}]}',
      exitCode: 0,
    });
    assert.equal(parsed.pageCount, 1);
  });

  test('zero-page results fail closed', () => {
    assert.throws(
      () => parseNormalizerStdout({
        stdout: '{"normalizedPdf":"/tmp/n.pdf","pageCount":0,"pages":[]}',
        exitCode: 0,
      }),
      (error) => error.code === NORMALIZER_NO_PAGES,
    );
  });

  test('educator UI never receives raw JSON.parse garbage', () => {
    const described = describeAnswerScriptFailure(new Error('Unexpected token \'w\', "warning: T"... is not valid JSON'), 'NORMALIZING');
    assert.equal(described.safeMessage, 'PDF processing failed while preparing page images.');
    assert.equal(educatorMessageForError(new Error('Unexpected token w')), described.safeMessage);
    assert.equal(described.errorCode, 'ANSWER_SCRIPT_NORMALIZATION_INVALID_RESPONSE');
  });
});

describe('normalize_answer_script.py stdout purity', () => {
  test('real Python normalizer emits only JSON on stdout and pageCount > 0', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xamigo-norm-'));
    const inputPath = path.join(workspace, 'fixture.pdf');
    const outputDir = path.join(workspace, 'out');
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Name: Ravi', { x: 72, y: 760, size: 18, font });
    page.drawText('Roll Number: 21', { x: 72, y: 730, size: 16, font });
    page.drawText('Q1 Photosynthesis', { x: 72, y: 680, size: 14, font });
    await fs.writeFile(inputPath, await pdf.save());
    await fs.mkdir(outputDir);
    let result;
    try {
      result = await run('python3', [
        NORMALIZER,
        '--input', inputPath,
        '--output', outputDir,
        '--mime-type', 'application/pdf',
        '--working-dpi', '72',
        '--working-long-edge', '800',
        '--preview-long-edge', '400',
        '--thumbnail-long-edge', '160',
        '--identity-fraction', '0.32',
        '--max-pages', '10',
      ]);
    } catch (error) {
      if (error.code === 'ENOENT') {
        assert.ok(true, 'python3 is not available in this environment');
        return;
      }
      throw error;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
    const trimmed = result.stdout.trim();
    assert.equal(trimmed.startsWith('{'), true, `stdout was not JSON: ${trimmed.slice(0, 180)}`);
    assert.equal(/^warning:/m.test(trimmed), false);
    const parsed = parseNormalizerStdout({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    assert.ok(parsed.pageCount > 0);
    assert.ok(Array.isArray(parsed.pages) && parsed.pages.length > 0);
  });

  test('the failing gallery PDF produces clean JSON and pageCount > 0', async () => {
    const gallery = '/Users/tusharmahajan/Downloads/PDF Gallery_20260830_022033.pdf';
    try {
      await fs.access(gallery);
    } catch {
      assert.ok(true, 'gallery PDF is not present in this environment');
      return;
    }
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xamigo-gallery-'));
    try {
      const result = await run('python3', [
        NORMALIZER,
        '--input', gallery,
        '--output', outputDir,
        '--mime-type', 'application/pdf',
        '--working-dpi', '72',
        '--working-long-edge', '800',
        '--preview-long-edge', '400',
        '--thumbnail-long-edge', '160',
        '--max-pages', '10',
      ]);
      const trimmed = result.stdout.trim();
      assert.equal(trimmed.startsWith('{'), true, `stdout leaked: ${trimmed.slice(0, 200)}`);
      assert.equal(/^warning:/m.test(trimmed), false);
      const parsed = parseNormalizerStdout({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
      assert.ok(parsed.pageCount > 0);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
