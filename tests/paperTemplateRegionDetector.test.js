import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import {
  REGION,
  isTemplateRegion,
  classifyLine,
  classifyDocumentLines,
} from '../services/paperTemplateRegionDetector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', '..', 'e2e', 'xyz');
const FIXTURES = {
  biology: 'AUS Grade 7 Biology Term 1 2025-2026 8th Oct.pdf',
  english: 'AUS Grade 7 English LanguageTerm 1 2025-2026 13th Oct.pdf',
};

// ---- Pure classification (no fixture dependency) ----

describe('classifyLine — deterministic template-region detection (no institution name hardcoded)', () => {
  const top = { lineIndex: 1, totalLines: 40 };
  test('document control line', () => {
    assert.equal(classifyLine('Document No. ACA/R/08 Rev. 00 Date : 02.02.2022', top), REGION.DOC_CONTROL);
    assert.equal(classifyLine('Document Number: XYZ/12  Rev 3  Date 01.01.2020', top), REGION.DOC_CONTROL);
  });
  test('institution name (generic all-caps near the top)', () => {
    assert.equal(classifyLine('GREENFIELD INTERNATIONAL ACADEMY', top), REGION.INSTITUTION_NAME);
  });
  test('session / assessment title / grade / marks', () => {
    assert.equal(classifyLine('ACADEMIC SESSION 2025–2026', top), REGION.SESSION);
    assert.equal(classifyLine('ASSESSMENT 1', top), REGION.ASSESSMENT_TITLE);
    assert.equal(classifyLine('GRADE VII', top), REGION.GRADE);
    assert.equal(classifyLine('Class: VII', top), REGION.GRADE);
    assert.equal(classifyLine('Maximum Marks: 80', top), REGION.MARKS_DURATION);
  });
  test('instruction heading + bulleted instruction lines', () => {
    assert.equal(classifyLine('INSTRUCTIONS', top), REGION.INSTRUCTIONS_HEADING);
    assert.equal(
      classifyLine('•  The intended marks are given in brackets [ ].', { lineIndex: 8, totalLines: 40, sawInstructionsHeading: true, sawFirstQuestion: false }),
      REGION.INSTRUCTION_LINE
    );
  });
  test('section heading + attempt rule', () => {
    assert.equal(classifyLine('SECTION I (40 Marks)', { lineIndex: 12, totalLines: 40 }), REGION.SECTION_HEADING);
    assert.equal(classifyLine('(Attempt all questions)', { lineIndex: 13, totalLines: 40 }), REGION.SECTION_RULE);
    assert.equal(classifyLine('Attempt any four questions from Section II.', { lineIndex: 13, totalLines: 40 }), REGION.SECTION_RULE);
  });
  test('running footer + page number', () => {
    assert.equal(classifyLine('2025-26/Assessment I/Grade VII/BiologyPage 1 of 7', { lineIndex: 39, totalLines: 40 }), REGION.FOOTER);
    assert.equal(classifyLine('Page 3 of 7', { lineIndex: 39, totalLines: 40 }), REGION.PAGE_NUMBER);
  });
  test('a real question and its options are CONTENT, not template', () => {
    assert.equal(classifyLine('1.  Which of the following is NOT a permanent tissue?', { lineIndex: 20, totalLines: 40, sawFirstQuestion: true }), REGION.CONTENT);
    assert.equal(classifyLine('(a)  Parenchyma', { lineIndex: 21, totalLines: 40, sawFirstQuestion: true }), REGION.CONTENT);
    assert.equal(classifyLine('Q1: Write a composition on any one of the following:', { lineIndex: 15, totalLines: 40 }), REGION.CONTENT);
  });
  test('every non-CONTENT region reports isTemplateRegion true', () => {
    for (const r of Object.values(REGION)) {
      assert.equal(isTemplateRegion(r), r !== REGION.CONTENT);
    }
  });
});

// ---- Acceptance 1, 2, 14 against the real Ashoka papers ----

describe('Ashoka fixtures — header / instructions / footer / "Page X of Y" are never CONTENT', () => {
  const parsed = {};
  before(async () => {
    for (const [key, file] of Object.entries(FIXTURES)) {
      const buf = fs.readFileSync(path.join(FIXTURE_DIR, file));
      const doc = await pdf(buf, { max: 1 });
      parsed[key] = classifyDocumentLines(doc.text).filter((r) => r.line.trim());
    }
  });

  for (const key of Object.keys(FIXTURES)) {
    test(`${key}: institutional preamble + footer classified as template regions (acceptance 1, 2)`, () => {
      const rows = parsed[key];
      const byRegion = (re) => rows.filter((r) => r.region === re);
      assert.ok(byRegion(REGION.DOC_CONTROL).length >= 1, 'document control line detected');
      assert.ok(byRegion(REGION.INSTITUTION_NAME).length >= 1, 'institution name detected as template');
      assert.ok(byRegion(REGION.INSTRUCTIONS_HEADING).length >= 1, 'instructions heading detected');
      assert.ok(byRegion(REGION.INSTRUCTION_LINE).length >= 2, 'instruction bullet lines detected');
      // None of those preamble lines leak through as CONTENT.
      const leaked = rows.filter(
        (r) => r.region === REGION.CONTENT && /(document no\.|academic session|^instructions$|maximum marks)/i.test(r.line)
      );
      assert.deepEqual(leaked, [], `no institutional preamble leaked as CONTENT: ${JSON.stringify(leaked)}`);
    });

    test(`${key}: footer "Page X of Y" is a template region, never a draft (acceptance 14)`, () => {
      const rows = parsed[key];
      const footerish = rows.filter((r) => /page\s+\d+\s+of\s+\d+/i.test(r.line));
      assert.ok(footerish.length >= 1, 'a page-number-bearing line exists on page 1');
      for (const r of footerish) {
        assert.ok(r.isTemplate, `line classified as template: "${r.line}" -> ${r.region}`);
        assert.ok(r.region === REGION.FOOTER || r.region === REGION.PAGE_NUMBER);
      }
    });

    test(`${key}: real questions still classified as CONTENT`, () => {
      const rows = parsed[key];
      const content = rows.filter((r) => r.region === REGION.CONTENT).map((r) => r.line);
      assert.ok(
        content.some((l) => /^\s*(?:\d+\.|q\s*\d+)/i.test(l)),
        'at least one numbered question line survives as CONTENT'
      );
    });
  }
});
