import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractQuestionsFromNumberedText,
  normalizeImportTextForParsing,
} from '../services/aiService.js';
import { sanitizeQuestionOptions } from '../utils/questionOptionSanitizer.js';

test('question import keeps a marked answer as metadata, not candidate-visible option text', () => {
  const questions = extractQuestionsFromNumberedText(`
Xamigo Sample Exam | Page 1
MATHEMATICS
3. Choose the word closest in meaning to "reluctant".
A. Eager
B. Hesitant [CORRECT]
C. Careless
D. Cheerful
MATHEMATICS
4. What is 3/4 + 5/8?
A. 1 1/8
B. 1 3/8 [CORRECT]
C. 1 5/8
D. 2 1/8
Xamigo Sample Exam | Page 2
5. What is 15% of 320?
A. 32
B. 40
C. 48 [CORRECT]
D. 64
`);

  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0].options, ['Eager', 'Hesitant', 'Careless', 'Cheerful']);
  assert.equal(questions[0].correctAnswer, 'Hesitant');
  assert.deepEqual(questions[1].options, ['1 1/8', '1 3/8', '1 5/8', '2 1/8']);
  assert.equal(questions[1].correctAnswer, '1 3/8');
  assert.deepEqual(questions[2].options, ['32', '40', '48', '64']);
  assert.equal(questions[2].correctAnswer, '48');
});

test('question option sanitization removes only trailing answer annotations', () => {
  assert.deepEqual(sanitizeQuestionOptions(['Correct choice', 'Hesitant [CORRECT]']), [
    'Correct choice',
    'Hesitant',
  ]);
});

test('PDF page chrome and standalone section headings do not become option text', () => {
  const normalized = normalizeImportTextForParsing(`
Xamigo Sample Exam | Page 2
SCIENCE
5. What is 15% of 320?
A. 32
B. 40
C. 48
D. 64
Sample educational content - not an official CISCE examination paper.
`);

  assert.equal(normalized.includes('Xamigo Sample Exam'), false);
  assert.equal(normalized.includes('SCIENCE'), false);
  assert.equal(normalized.includes('Sample educational content'), false);
  assert.match(normalized, /D\. 64$/);
});
