import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { qualityGateQuestionsAgainstSpecification } from '../services/assessmentSpecificationResolver.js';

describe('assessment framework question-type recommendations', () => {
  test('keeps a valid platform question outside the framework recommendation list', () => {
    const result = qualityGateQuestionsAgainstSpecification(
      [{ questionText: 'Select every renewable energy source.', questionType: 'MULTIPLE_OPTIONS' }],
      { questionGeneration: { questionTypes: ['SHORT_ANSWER'] } },
    );
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  test('still rejects a malformed question rather than weakening shape validation', () => {
    const result = qualityGateQuestionsAgainstSpecification(
      [{ questionText: '', questionType: 'MULTIPLE_OPTIONS' }],
      { questionGeneration: { questionTypes: ['SHORT_ANSWER'] } },
    );
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0].code, 'INVALID_SHAPE');
  });
});
