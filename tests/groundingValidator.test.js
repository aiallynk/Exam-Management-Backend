import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import { scoreGroundingHeuristic } from '../services/groundingValidatorService.js';

describe('scoreGroundingHeuristic', () => {
  const retrievedChunks = [
    {
      text:
        'Photosynthesis is the process by which plants convert light energy into chemical energy. ' +
        'Chlorophyll in the chloroplast absorbs sunlight, and carbon dioxide combines with water to produce glucose and oxygen.',
    },
  ];

  test('scores high when the topic is clearly present in the source (would not escalate to LLM)', () => {
    const score = scoreGroundingHeuristic({
      questionText: 'What pigment absorbs sunlight during photosynthesis?',
      correctAnswer: 'Chlorophyll',
      retrievedChunks,
    });
    const [, highBand] = sourceGroundedConfig.GROUNDING_VALIDATOR_AMBIGUITY_BAND;
    assert.ok(score >= highBand, `expected score >= ${highBand}, got ${score}`);
  });

  test('scores low when the topic is entirely absent from the source (would not escalate to LLM)', () => {
    const score = scoreGroundingHeuristic({
      questionText: 'Who won the World Cup in 1998?',
      correctAnswer: 'France',
      retrievedChunks,
    });
    const [lowBand] = sourceGroundedConfig.GROUNDING_VALIDATOR_AMBIGUITY_BAND;
    assert.ok(score <= lowBand, `expected score <= ${lowBand}, got ${score}`);
  });

  test('returns 0 when there is no retrieved context at all', () => {
    const score = scoreGroundingHeuristic({
      questionText: 'What pigment absorbs sunlight?',
      correctAnswer: 'Chlorophyll',
      retrievedChunks: [],
    });
    assert.equal(score, 0);
  });

  test('handles a non-string correctAnswer (e.g. an array for MULTIPLE_OPTIONS) without throwing', () => {
    assert.doesNotThrow(() =>
      scoreGroundingHeuristic({
        questionText: 'Which gas is produced during photosynthesis?',
        correctAnswer: ['Oxygen', 'Glucose'],
        retrievedChunks,
      })
    );
  });
});
