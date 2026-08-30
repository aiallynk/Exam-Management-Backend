import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freezePaperTemplateOntoExam } from '../services/paperTemplateService.js';

// DB-free guard tests: the two short-circuit branches of
// freezePaperTemplateOntoExam that never touch Mongo. The full resolve path
// (template lookup + branding + resolvePaperTemplateSnapshot) is covered by
// paperTemplateResolver.test.js and by the live checkpoint run.

describe('freezePaperTemplateOntoExam — write-once contract', () => {
  test('is a no-op when the exam already carries a frozen snapshot (never re-freezes)', async () => {
    const frozenSnap = { templateId: 'old', capturedAt: '2026-01-01T00:00:00.000Z' };
    const exam = {
      tenantId: 'T1',
      paperTemplateId: 'oldTmpl',
      paperTemplateSnapshot: frozenSnap,
      paperTemplateSnapshotAt: new Date('2026-01-01'),
    };
    const out = await freezePaperTemplateOntoExam(exam, { templateId: 'newTmpl', overrides: { assessmentTitle: 'changed' } });
    assert.equal(out.paperTemplateSnapshot, frozenSnap, 'snapshot object is untouched');
    assert.equal(out.paperTemplateId, 'oldTmpl', 'templateId is untouched');
  });

  test('is a no-op when no template was selected', async () => {
    const exam = { tenantId: 'T1' };
    const out = await freezePaperTemplateOntoExam(exam, { templateId: null });
    assert.equal(out.paperTemplateSnapshot, undefined);
    assert.equal(out.paperTemplateId, undefined);
  });

  test('is a no-op for a malformed templateId (never hits the DB)', async () => {
    const exam = { tenantId: 'T1' };
    const out = await freezePaperTemplateOntoExam(exam, { templateId: 'not-an-object-id' });
    assert.equal(out.paperTemplateSnapshot, undefined);
  });

  test('null exam returns null', async () => {
    assert.equal(await freezePaperTemplateOntoExam(null, { templateId: 'x' }), null);
  });
});
