import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  collectAnswerScriptObjectKeys,
  evaluateAnswerScriptDeletion,
} from '../services/offlineEvaluation/answerScriptDeleteService.js';

describe('answer script deletion policy', () => {
  test('monitor-only workspaces cannot delete', () => {
    const decision = evaluateAnswerScriptDeletion({
      script: { _id: 's1' },
      monitorOnly: true,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'MONITOR_ONLY');
  });

  test('Academic Admin can delete a materialized sheet even after results release', () => {
    const decision = evaluateAnswerScriptDeletion({
      script: { _id: 's1', materializedAttemptId: 'a1' },
      resultsReleased: true,
      isAcademicAdmin: true,
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.removesAttempt, true);
    assert.equal(decision.removesReleasedResult, true);
  });

  test('Teacher or Exam Creator cannot delete a released materialized sheet', () => {
    const decision = evaluateAnswerScriptDeletion({
      script: { _id: 's1', materializedAttemptId: 'a1' },
      resultsReleased: true,
      isAcademicAdmin: false,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'RESULTS_RELEASED');
  });

  test('an unreleased or unmapped sheet can be deleted so the same file can be uploaded again', () => {
    const queued = evaluateAnswerScriptDeletion({ script: { _id: 's1' } });
    const completed = evaluateAnswerScriptDeletion({
      script: { _id: 's2', materializedAttemptId: 'a2' },
      resultsReleased: false,
    });
    assert.equal(queued.allowed, true);
    assert.equal(queued.removesAttempt, false);
    assert.equal(completed.allowed, true);
    assert.equal(completed.removesAttempt, true);
  });
});

describe('answer script object-key collection', () => {
  test('collects original, derivative, page, and crop keys without duplicates', () => {
    const keys = collectAnswerScriptObjectKeys({
      script: {
        sourceFile: { key: 'private/original.pdf' },
        originalObject: { key: 'private/original.pdf' },
        normalizedObject: { key: 'private/normalized.pdf' },
        evaluatedDerivative: { key: 'private/evaluated.pdf' },
        uploadSession: { objectKey: 'private/upload-session.pdf' },
      },
      pages: [{
        image: { key: 'private/page-1.png' },
        workingImage: { key: 'private/page-1-working.png' },
        previewImage: { key: '' },
        thumbnailImage: { key: 'private/page-1-thumb.png' },
      }],
      segments: [{ cropObject: { key: 'private/crop-q1.png' } }, { cropObject: {} }],
    });
    assert.deepEqual(keys.sort(), [
      'private/crop-q1.png',
      'private/evaluated.pdf',
      'private/normalized.pdf',
      'private/original.pdf',
      'private/page-1-thumb.png',
      'private/page-1-working.png',
      'private/page-1.png',
      'private/upload-session.pdf',
    ]);
  });
});
