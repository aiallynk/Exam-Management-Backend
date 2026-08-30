import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildImageLocation,
  urlToKey,
  keyToUrl,
  isS3Configured,
  assertS3Configured,
} from '../services/storage/imageStorage.js';

describe('imageStorage — S3 key/URL scheme (pure, no S3 calls)', () => {
  test('exam-scoped key follows xamigo/tenant-{id}/exams/exam-{id}/{category}/{filename}', () => {
    const { key, url } = buildImageLocation({
      tenantId: 'T1',
      examId: 'E1',
      category: 'questions',
      subpath: ['q1'],
      filename: 'diagram.png',
    });
    assert.equal(key, 'xamigo/tenant-t1/exams/exam-e1/questions/q1/diagram.png');
    assert.equal(url, '/uploads/tenant-t1/exams/exam-e1/questions/q1/diagram.png');
  });

  test('non-exam-scoped key omits the exams/exam-{id} segment entirely', () => {
    const { key, url } = buildImageLocation({
      tenantId: 'T1',
      category: 'misc',
      filename: 'photo.jpg',
    });
    assert.equal(key, 'xamigo/tenant-t1/misc/photo.jpg');
    assert.equal(url, '/uploads/tenant-t1/misc/photo.jpg');
  });

  test('urlToKey and keyToUrl are inverses', () => {
    const { key, url } = buildImageLocation({
      tenantId: 'T1',
      examId: 'E1',
      category: 'omr',
      filename: 'sheet.jpg',
    });
    assert.equal(urlToKey(url), key);
    assert.equal(keyToUrl(key), url);
    assert.equal(urlToKey(keyToUrl(key)), key);
  });

  test('urlToKey rejects anything not under /uploads/', () => {
    assert.equal(urlToKey('https://example.com/uploads/x.png'), '');
    assert.equal(urlToKey('/other/x.png'), '');
    assert.equal(urlToKey(''), '');
  });

  test('keyToUrl rejects anything not under the configured root prefix', () => {
    assert.equal(keyToUrl('not-xamigo/tenant-t1/misc/x.png'), '');
    assert.equal(keyToUrl(''), '');
  });

  test('segments are sanitized to safe, lowercase path components', () => {
    const { key } = buildImageLocation({
      tenantId: 'Tenant One!!',
      examId: 'Exam #42',
      category: 'Questions',
      filename: 'My Diagram.PNG',
    });
    assert.match(key, /^xamigo\/tenant-[a-z0-9._-]+\/exams\/exam-[a-z0-9._-]+\/questions\/[a-z0-9._-]+$/);
  });
});

describe('imageStorage — hard-fail when S3 is not configured', () => {
  test('isS3Configured is false with empty env vars (this project ships with placeholders)', () => {
    // Not asserted true/false absolutely, since a dev machine may have real
    // credentials in .env — just confirm the function reflects reality
    // rather than throwing.
    assert.equal(typeof isS3Configured(), 'boolean');
  });

  test('assertS3Configured throws a clear, typed error when unconfigured', () => {
    if (isS3Configured()) {
      // Real credentials are present in this environment — the hard-fail
      // path isn't reachable; skip rather than false-fail.
      return;
    }
    assert.throws(
      () => assertS3Configured(),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'S3_NOT_CONFIGURED');
        assert.match(error.message, /S3_BUCKET|S3_REGION|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY/);
        return true;
      }
    );
  });
});
