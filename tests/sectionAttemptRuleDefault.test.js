import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Section from '../models/Section.js';
import Question from '../models/Question.js';

// Phase 1C additive fields must be backward-compatible: a section/question
// built without the new field behaves exactly as before.

describe('Section.attemptRule — additive, defaults to ALL', () => {
  test('a section created without attemptRule reads mode ALL', () => {
    const s = new Section({
      questionPaperId: new mongoose.Types.ObjectId(),
      name: 'Section I',
      order: 0,
      duration: 60,
    });
    assert.equal(s.attemptRule.mode, 'ALL');
    assert.equal(s.attemptRule.requiredCount, null);
    assert.equal(s.attemptRule.source, 'MANUAL');
  });

  test('an ANY_N rule round-trips', () => {
    const s = new Section({
      questionPaperId: new mongoose.Types.ObjectId(),
      name: 'Section II',
      order: 1,
      duration: 60,
      attemptRule: { mode: 'ANY_N', requiredCount: 4, source: 'DETECTED' },
    });
    assert.equal(s.attemptRule.mode, 'ANY_N');
    assert.equal(s.attemptRule.requiredCount, 4);
    assert.equal(s.attemptRule.source, 'DETECTED');
  });

  test('an invalid mode fails validation rather than silently coercing', () => {
    const s = new Section({
      questionPaperId: new mongoose.Types.ObjectId(),
      name: 'x', order: 0, duration: 60,
      attemptRule: { mode: 'WHATEVER' },
    });
    const err = s.validateSync();
    assert.ok(err && err.errors['attemptRule.mode'], 'enum violation surfaced');
  });
});

describe('Question.choiceGroup — additive, absent by default', () => {
  test('a question created without choiceGroup has it undefined', () => {
    const q = new Question({ questionText: 'What is 2+2?', questionType: 'MULTIPLE_CHOICE' });
    assert.equal(q.choiceGroup, undefined);
  });

  test('an ALTERNATIVES choiceGroup round-trips', () => {
    const q = new Question({
      questionText: 'Write a letter on any one of the following.',
      questionType: 'SHORT_ANSWER',
      choiceGroup: { groupId: 'eng-q3', kind: 'ALTERNATIVES', selectRequired: 1 },
    });
    assert.equal(q.choiceGroup.groupId, 'eng-q3');
    assert.equal(q.choiceGroup.kind, 'ALTERNATIVES');
    assert.equal(q.choiceGroup.selectRequired, 1);
  });
});
