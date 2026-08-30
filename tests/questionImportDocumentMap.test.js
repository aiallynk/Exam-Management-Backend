import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildImportLowCoverageError,
  buildQuestionImportDocumentMap,
} from '../services/questionImportDocumentMapService.js';
import {
  assessVisionCoverage,
  documentMapQuestionsToImportRows,
  reconcileImportQuestionCandidates,
} from '../services/questionImportExtractionService.js';

const BIOLOGY_FIXTURE = `
ASHOKA UNIVERSITY
Grade VII Biology Term Assessment
Maximum Marks: 80
Time: 2 Hours
General Instructions: Attempt all questions from Section I.

Section I
1. Which organelle is called the powerhouse of the cell?
A. Nucleus
B. Mitochondria
C. Ribosome
D. Golgi body

2. State whether the following are True or False.
(a) Chloroplast is present in animal cells.
(b) Cell wall is absent in plant cells.

3. Name the following:
(a) The process by which plants make food.
(b) The tissue that transports water in plants.

4. Match the following:
Column A
(i) Xylem
(ii) Phloem
Column B
(a) Food transport
(b) Water transport

5. Fill in the blanks:
Photosynthesis occurs in the ________ of plant cells.

Section II
Attempt any four questions.
6. Explain the difference between plant and animal cells.
7. Draw a labelled diagram of a neuron.
8. Observe the diagram below and answer the questions that follow.
`;

describe('question import document map', () => {
  test('excludes headers, instructions, and metadata from question candidates', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: BIOLOGY_FIXTURE, filename: 'biology.pdf' });
    assert.ok(documentMap.metadataRegions.length >= 1);
    assert.ok(documentMap.instructionRegions.length >= 1);
    assert.ok(documentMap.questions.length >= 5);
    assert.equal(
      documentMap.questions.some((question) => /maximum marks/i.test(question.questionText)),
      false
    );
    assert.equal(
      documentMap.questions.some((question) => /attempt all questions/i.test(question.questionText)),
      false
    );
  });

  test('preserves MCQ options with the stem', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: BIOLOGY_FIXTURE });
    const mcq = documentMap.questions.find((question) => /powerhouse/i.test(question.questionText));
    assert.ok(mcq);
    assert.equal(mcq.questionType, 'MULTIPLE_CHOICE');
    assert.ok(mcq.options.length >= 4);
  });

  test('flags source-visual questions separately from drawing-required prompts', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: BIOLOGY_FIXTURE });
    const observeDiagram = documentMap.questions.find((question) => /observe the diagram below/i.test(question.questionText));
    const drawDiagram = documentMap.questions.find((question) => /draw a labelled diagram/i.test(question.questionText));
    assert.ok(observeDiagram?.sourceImageRequired);
    assert.equal(Boolean(drawDiagram?.drawingRequired), true);
    assert.equal(Boolean(drawDiagram?.sourceImageRequired), false);
  });

  test('reconciles a single useless vision row against a richer document map', () => {
    const documentMap = buildQuestionImportDocumentMap({ text: BIOLOGY_FIXTURE });
    const documentMapRows = documentMapQuestionsToImportRows(documentMap);
    const reconciliation = reconcileImportQuestionCandidates({
      documentMapRows,
      numberedRows: [],
      structuredRows: [{
        questionText: 'ASHOKA UNIVERSITY Grade VII Biology Term Assessment Maximum Marks 80 Time 2 Hours',
        questionType: 'SHORT_ANSWER',
        options: [],
      }],
      visionRows: [{
        questionText: 'ASHOKA UNIVERSITY Grade VII Biology Term Assessment Maximum Marks 80 Time 2 Hours',
        questionType: 'SHORT_ANSWER',
        options: [],
      }],
      pageCount: 6,
      textLength: BIOLOGY_FIXTURE.length,
      markerCount: 8,
    });

    assert.ok(reconciliation.questions.length >= 5);
    assert.equal(reconciliation.primarySource, 'documentMap');
  });

  test('marks multi-page low coverage and builds a reviewable error', () => {
    const documentMap = buildQuestionImportDocumentMap({
      pageTexts: ['Page 1 text '.repeat(40), 'Page 2 text '.repeat(40)],
      text: 'Page 1 text '.repeat(40) + '\n' + 'Page 2 text '.repeat(40),
      filename: 'sparse.pdf',
    });
    assert.equal(documentMap.diagnostics.lowCoverage, true);
    const error = buildImportLowCoverageError(documentMap);
    assert.equal(error.code, 'IMPORT_LOW_COVERAGE');
    assert.equal(error.statusCode, 422);
  });

  test('direct vision is not authoritative for a single row on a multi-page paper', () => {
    const coverage = assessVisionCoverage({
      visionRowCount: 1,
      pageCount: 7,
      textLength: 5000,
      markerCount: 12,
      documentMapCount: 10,
    });
    assert.equal(coverage.authoritative, false);
  });
});
