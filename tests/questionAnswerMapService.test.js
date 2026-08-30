import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildQuestionAnswerMap } from '../services/offlineEvaluation/questionAnswerMapService.js';

describe('questionAnswerMapService', () => {
  test('builds one authoritative map entry per question with segment anchors', () => {
    const answers = [
      { _id: 'a1', sourceAnswerSegmentId: 's1', questionId: { _id: 'q1', order: 0, points: 5 }, pointsEarned: 5 },
      { _id: 'a2', sourceAnswerSegmentId: 's2', questionId: { _id: 'q2', order: 1, points: 5 }, pointsEarned: 2 },
    ];
    const segments = [
      { _id: 's1', materializedAnswerId: 'a1', pageIds: ['p1'], boundingRegion: { x: 0.1, y: 0.1, width: 0.6, height: 0.1 }, mappingConfidence: 0.92 },
      { _id: 's2', materializedAnswerId: 'a2', pageIds: ['p1'], boundingRegion: { x: 0.1, y: 0.3, width: 0.6, height: 0.1 }, mappingConfidence: 0.88 },
    ];
    const map = buildQuestionAnswerMap({
      answers,
      segments,
      pageNumberById: { p1: 1 },
    });
    assert.equal(map.length, 2);
    assert.equal(map[0].questionNumber, 1);
    assert.equal(map[1].answerId, 'a2');
    assert.equal(map[0].answerSegmentIds[0], 's1');
    assert.ok(map[0].primaryAnchor?.region);
    assert.equal(map[1].finalScore, 2);
  });
});
