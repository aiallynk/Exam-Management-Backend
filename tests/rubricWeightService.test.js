import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeCriterionContribution,
  computeWeightedQuestionScore,
  migrateLegacyCriteriaToWeights,
  validateRubricWeights,
} from '../services/offlineEvaluation/rubricWeightService.js';

describe('rubricWeightService', () => {
  test('migrates legacy fixed marks to percentage weights', () => {
    const migrated = migrateLegacyCriteriaToWeights([
      { key: 'thinking', label: 'Thinking', maxMarks: 4 },
      { key: 'presentation', label: 'Presentation', maxMarks: 6 },
    ]);
    assert.equal(migrated.migrated, true);
    assert.deepEqual(
      migrated.criteria.map((entry) => [entry.key, entry.weightPercentage]),
      [['thinking', 40], ['presentation', 60]],
    );
    assert.equal(validateRubricWeights(migrated.criteria).valid, true);
  });

  test('scales the same rubric to different question max marks', () => {
    const criteria = [
      { key: 'thinking', label: 'Thinking', weightPercentage: 25 },
      { key: 'presentation', label: 'Presentation', weightPercentage: 75 },
    ];
    const fourMark = computeWeightedQuestionScore({
      questionMaxMarks: 4,
      criteria,
      achievements: [
        { key: 'thinking', achievementPercentage: 80 },
        { key: 'presentation', achievementPercentage: 60 },
      ],
    });
    assert.equal(fourMark.total, 2.6);
    assert.deepEqual(fourMark.entries.map((entry) => entry.maxContribution), [1, 3]);

    const twentyMark = computeWeightedQuestionScore({
      questionMaxMarks: 20,
      criteria,
      achievements: [
        { key: 'thinking', achievementPercentage: 100 },
        { key: 'presentation', achievementPercentage: 100 },
      ],
    });
    assert.equal(twentyMark.total, 20);
  });

  test('computes deterministic decimal contributions', () => {
    const contribution = computeCriterionContribution({
      questionMaxMarks: 10,
      weightPercentage: 25,
      achievementPercentage: 80,
    });
    assert.equal(contribution, 2);
  });

  test('rejects invalid legacy rubrics with zero total', () => {
    const result = validateRubricWeights([
      { key: 'a', label: 'A', maxMarks: 0 },
      { key: 'b', label: 'B', maxMarks: 0 },
    ]);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'MIGRATION_REVIEW_REQUIRED');
  });
});
