import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isGoogleDriveUrl,
  parseGoogleDriveUrl,
  buildDriveCandidateRequests,
  extractDriveConfirmToken,
  classifyDriveHtmlBlock,
} from '../services/googleDriveSourceProvider.js';

// Pure, DB/network-free unit tests for Google Drive URL recognition —
// this is the root-cause fix for the reported bug: a Drive share link was
// previously fetched like an ordinary webpage, silently ingesting the
// Drive viewer/sign-in HTML as if it were the document's content.

describe('isGoogleDriveUrl', () => {
  test('recognizes drive.google.com and docs.google.com', () => {
    assert.equal(isGoogleDriveUrl('https://drive.google.com/file/d/abc123/view'), true);
    assert.equal(isGoogleDriveUrl('https://docs.google.com/document/d/abc123/edit'), true);
  });

  test('does not misclassify an ordinary webpage', () => {
    assert.equal(isGoogleDriveUrl('https://example.com/chapter.pdf'), false);
  });

  test('fails safe (false) on an invalid URL string', () => {
    assert.equal(isGoogleDriveUrl('not-a-url'), false);
  });
});

describe('parseGoogleDriveUrl', () => {
  test('recognizes /file/d/{id}/view', () => {
    const parsed = parseGoogleDriveUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing');
    assert.deepEqual(parsed, { kind: 'FILE', fileId: '1AbCdEfGhIjKlMnOpQrSt', resourceKey: '' });
  });

  test('recognizes /open?id={id}', () => {
    const parsed = parseGoogleDriveUrl('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrSt');
    assert.deepEqual(parsed, { kind: 'FILE', fileId: '1AbCdEfGhIjKlMnOpQrSt', resourceKey: '' });
  });

  test('preserves a resourcekey query param', () => {
    const parsed = parseGoogleDriveUrl(
      'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?resourcekey=0-xyz123'
    );
    assert.equal(parsed.resourceKey, '0-xyz123');
  });

  test('recognizes Google Docs/Sheets/Slides as their respective kinds', () => {
    assert.equal(
      parseGoogleDriveUrl('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrSt/edit')?.kind,
      'DOCUMENT'
    );
    assert.equal(
      parseGoogleDriveUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrSt/edit')?.kind,
      'SPREADSHEET'
    );
    assert.equal(
      parseGoogleDriveUrl('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrSt/edit')?.kind,
      'PRESENTATION'
    );
  });

  test('returns null for an unrecognized Drive path (e.g. a folder link)', () => {
    assert.equal(parseGoogleDriveUrl('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrSt'), null);
  });

  test('returns null for a non-Drive host', () => {
    assert.equal(parseGoogleDriveUrl('https://example.com/file/d/abc123/view'), null);
  });

  test('returns null for an invalid URL string', () => {
    assert.equal(parseGoogleDriveUrl('not-a-url'), null);
  });
});

describe('buildDriveCandidateRequests', () => {
  test('FILE kind without an API key uses only the public download-page trick', () => {
    const candidates = buildDriveCandidateRequests({ kind: 'FILE', fileId: 'abc123', resourceKey: '' });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].url, /drive\.google\.com\/uc\?export=download&id=abc123/);
    assert.equal(candidates[0].allowConfirmRetry, true);
  });

  test('FILE kind with an API key tries the official Drive API first', () => {
    const candidates = buildDriveCandidateRequests({ kind: 'FILE', fileId: 'abc123', resourceKey: '', apiKey: 'KEY123' });
    assert.equal(candidates.length, 2);
    assert.match(candidates[0].url, /googleapis\.com\/drive\/v3\/files\/abc123\?alt=media&key=KEY123/);
    assert.match(candidates[1].url, /uc\?export=download/);
  });

  test('never includes the API key in the URL when one is not configured', () => {
    const candidates = buildDriveCandidateRequests({ kind: 'FILE', fileId: 'abc123', resourceKey: '' });
    assert.ok(!candidates.some((c) => c.url.includes('key=')));
  });

  test('DOCUMENT/SPREADSHEET/PRESENTATION use their respective export endpoints', () => {
    assert.match(
      buildDriveCandidateRequests({ kind: 'DOCUMENT', fileId: 'abc123' })[0].url,
      /docs\.google\.com\/document\/d\/abc123\/export\?format=txt/
    );
    assert.match(
      buildDriveCandidateRequests({ kind: 'SPREADSHEET', fileId: 'abc123' })[0].url,
      /docs\.google\.com\/spreadsheets\/d\/abc123\/export\?format=csv/
    );
    assert.match(
      buildDriveCandidateRequests({ kind: 'PRESENTATION', fileId: 'abc123' })[0].url,
      /docs\.google\.com\/presentation\/d\/abc123\/export\/txt/
    );
  });

  test('appends the resourceKey as a query param when present', () => {
    const candidates = buildDriveCandidateRequests({ kind: 'DOCUMENT', fileId: 'abc123', resourceKey: '0-xyz' });
    assert.match(candidates[0].url, /resourcekey=0-xyz/);
  });
});

describe('extractDriveConfirmToken', () => {
  test('extracts the confirm token from the large-file virus-scan warning page', () => {
    const html = '<a href="/uc?export=download&id=abc&confirm=T9G2_xyz&at=AB6">Download anyway</a>';
    assert.equal(extractDriveConfirmToken(html), 'T9G2_xyz');
  });

  test('returns null when no confirm token is present', () => {
    assert.equal(extractDriveConfirmToken('<html><body>Sign in</body></html>'), null);
  });

  test('returns null for empty/undefined input', () => {
    assert.equal(extractDriveConfirmToken(''), null);
    assert.equal(extractDriveConfirmToken(undefined), null);
  });
});

describe('classifyDriveHtmlBlock', () => {
  test('classifies a sign-in / permission page as DRIVE_PERMISSION_REQUIRED', () => {
    const html = '<html><body>Sign in to continue. You need access to open this item.</body></html>';
    assert.equal(classifyDriveHtmlBlock(html), 'DRIVE_PERMISSION_REQUIRED');
  });

  test('classifies an unrecognized HTML response as DRIVE_FILE_NOT_DOWNLOADABLE', () => {
    const html = '<html><body>This file cannot be previewed.</body></html>';
    assert.equal(classifyDriveHtmlBlock(html), 'DRIVE_FILE_NOT_DOWNLOADABLE');
  });
});
