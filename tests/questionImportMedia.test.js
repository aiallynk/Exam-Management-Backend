import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildQuestionImportDocumentMap } from '../services/questionImportDocumentMapService.js';
import {
  applyImportMediaPolicy,
  classifyImportMediaRequirement,
  MEDIA_REQUIREMENTS,
  parseMarksFromText,
  shouldAttachSourceMedia,
  validateImportQuestionMedia,
} from '../services/questionImportMediaService.js';

const PHYSICS_Q9 = `
9.
i. Differentiate between mass and weight. (2)
ii. Explain the importance of standard SI units. (2)
iii. Analyze three practical scenarios:
(a) irregular stone volume (2)
(b) ml vs litres (2)
(c) speed for journey planning (2)
`;

const STUDY_DIAGRAM = 'Study the diagram below and answer the questions about the measuring cylinder.';
const DRAW_DIAGRAM = 'Draw a diagram showing an incident ray striking a plane mirror at 45 degrees.';

describe('question import media requirement', () => {
  test('text-only physics Q9 subquestions require no visual media', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: PHYSICS_Q9, filename: 'physics.pdf' });
    assert.ok(documentMap.questions.length >= 3);
    documentMap.questions.forEach((question) => {
      assert.equal(classifyImportMediaRequirement(question), MEDIA_REQUIREMENTS.NO_VISUAL_REQUIRED);
      const sanitized = applyImportMediaPolicy({ ...question, imageUrl: '/uploads/page-crop.png' });
      assert.equal(sanitizeHasMedia(sanitized), false);
    });
  });

  test('physics Q9 subquestions preserve 2-mark scoring', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: PHYSICS_Q9 });
    const marks = documentMap.questions.map((question) => question.points);
    assert.ok(marks.every((value) => value === 2));
    assert.equal(marks.reduce((sum, value) => sum + value, 0), 10);
  });

  test('study-the-diagram requires source visual, not AI generation', () => {
    const requirement = classifyImportMediaRequirement({ questionText: STUDY_DIAGRAM });
    assert.equal(requirement, MEDIA_REQUIREMENTS.SOURCE_VISUAL_REQUIRED);
    assert.equal(shouldAttachSourceMedia(requirement), true);
  });

  test('draw-a-diagram is candidate drawing, not source visual or image-based stimulus', () => {
    const requirement = classifyImportMediaRequirement({ questionText: DRAW_DIAGRAM });
    assert.equal(requirement, MEDIA_REQUIREMENTS.CANDIDATE_MUST_DRAW);
    const sanitized = applyImportMediaPolicy({
      questionText: DRAW_DIAGRAM,
      questionType: 'SHORT_ANSWER',
      imageUrl: '/uploads/fake.png',
    });
    assert.equal(sanitizeHasMedia(sanitized), false);
    assert.equal(validateImportQuestionMedia(sanitized).ok, true);
  });

  test('page crop on text-only question fails media validation when persisted', () => {
    const validation = validateImportQuestionMedia({
      questionText: 'Differentiate between mass and weight.',
      questionType: 'SHORT_ANSWER',
      imageUrl: '/uploads/page-screenshot.png',
      mediaRequirement: MEDIA_REQUIREMENTS.NO_VISUAL_REQUIRED,
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'text-only-question-has-media');
  });

  test('parseMarksFromText reads parenthetical mark annotations', () => {
    assert.equal(parseMarksFromText('Differentiate between mass and weight. (2)'), 2);
    assert.equal(parseMarksFromText('Explain the importance of standard SI units. (2 Marks)'), 2);
  });

  test('import fixture expects zero AI-generated images', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: PHYSICS_Q9 + '\n' + STUDY_DIAGRAM + '\n' + DRAW_DIAGRAM });
    const aiGeneratedImageCount = documentMap.questions.filter((question) =>
      Boolean(question.generatedImage)
    ).length;
    assert.equal(aiGeneratedImageCount, 0);
  });
});

function sanitizeHasMedia(question) {
  return Boolean(question.imageUrl || question.image_path || question.generatedImage || question.imageBase64);
}
