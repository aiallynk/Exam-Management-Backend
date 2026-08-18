import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveGenerationStrategy } from '../services/groundedGenerationService.js';

// Master prompt §32-34: WizKids must use the SAME Source-Grounded pipeline
// as normal exams, not a parallel implementation. routes/ai.js's
// generate-questions handler branches on resolveGenerationStrategy()
// exclusively — these tests prove that function's output never depends
// on productModule, which is what guarantees the shared code path.

describe('resolveGenerationStrategy — shared between STANDARD and WIZKIDS', () => {
  test('selects SOURCE_GROUNDED for productModule STANDARD when requested', () => {
    assert.equal(
      resolveGenerationStrategy({ generationMode: 'SOURCE_GROUNDED', productModule: 'STANDARD' }),
      'SOURCE_GROUNDED'
    );
  });

  test('selects SOURCE_GROUNDED for productModule WIZKIDS identically — same branch, same function', () => {
    assert.equal(
      resolveGenerationStrategy({ generationMode: 'SOURCE_GROUNDED', productModule: 'WIZKIDS' }),
      'SOURCE_GROUNDED'
    );
  });

  test('the result is identical across productModule values for every generationMode (proof of a single shared branch)', () => {
    for (const generationMode of ['STANDARD', 'SOURCE_GROUNDED', undefined]) {
      const forStandard = resolveGenerationStrategy({ generationMode, productModule: 'STANDARD' });
      const forWizKids = resolveGenerationStrategy({ generationMode, productModule: 'WIZKIDS' });
      assert.equal(forStandard, forWizKids, `mismatch for generationMode=${generationMode}`);
    }
  });

  test('defaults to STANDARD when generationMode is omitted (existing AI-assisted flow is unaffected)', () => {
    assert.equal(resolveGenerationStrategy({ productModule: 'STANDARD' }), 'STANDARD');
    assert.equal(resolveGenerationStrategy({ productModule: 'WIZKIDS' }), 'STANDARD');
  });
});
