import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATE_TOKENS,
  PERMITTED_OVERRIDE_KEYS,
  resolveTokenValues,
  substituteTokens,
  substitutePageTokens,
  resolvePaperTemplateSnapshot,
  resolveDefaultInstructionLines,
  resolveInstructionLinesForSubject,
  sanitizePaperTemplateOverrides,
  composeHeaderFromBranding,
  brandingHasContent,
  MARKS_NOTATION_RENDER,
} from '../services/paperTemplateResolver.js';

const branding = {
  institutionName: 'Riverside School',
  addressLines: ['12 River Road', 'Springfield'],
  documentNumberDefault: 'ACA/R/08',
  revisionDefault: '00',
  academicSessionDefault: '2025–2026',
};
const exam = {
  title: 'Assessment 1',
  totalMarks: 80,
  duration: 120,
  academicContext: { subject: 'Biology', grade: 'VII' },
};

describe('resolveTokenValues', () => {
  test('resolves branding + exam values; override wins over exam wins over branding', () => {
    const v = resolveTokenValues({
      branding, exam,
      overrides: { assessmentTitle: 'Term 1 Exam', documentNumber: 'ACA/R/09' },
    });
    assert.equal(v['institution.name'], 'Riverside School');
    assert.equal(v['institution.address'], '12 River Road, Springfield');
    assert.equal(v.documentNumber, 'ACA/R/09'); // override beats branding default
    assert.equal(v.revision, '00');
    assert.equal(v.academicSession, '2025–2026');
    assert.equal(v.assessmentTitle, 'Term 1 Exam'); // override beats exam.title
    assert.equal(v.maximumMarks, '80');
    assert.equal(v.duration, '2 Hours');
    assert.equal(v.subject, 'Biology');
    assert.equal(v.grade, 'VII');
  });

  test('missing branding resolves tokens to empty string, never throws', () => {
    const v = resolveTokenValues({ branding: {}, exam: {}, overrides: {} });
    assert.equal(v['institution.name'], '');
    assert.equal(v['institution.logo'], '');
    assert.equal(v.documentNumber, '');
    assert.equal(v.maximumMarks, '');
    assert.equal(v.duration, '');
  });

  test('page tokens are deliberately kept literal (resolved per rendered page later)', () => {
    const v = resolveTokenValues({ branding, exam });
    assert.equal(v.pageNumber, '{{pageNumber}}');
    assert.equal(v.totalPages, '{{totalPages}}');
  });
});

describe('substituteTokens', () => {
  const values = resolveTokenValues({ branding, exam });
  test('substitutes known tokens and tolerates inner whitespace', () => {
    assert.equal(substituteTokens('{{institution.name}} — {{ assessmentTitle }}', values), 'Riverside School — Assessment 1');
  });
  test('unknown / empty tokens are removed, never left as {{token}}', () => {
    // Each removed token leaves its surrounding spaces; the point is that no
    // literal {{...}} survives (whitespace tidy-up is the renderer's job).
    const out = substituteTokens('X {{nope}} {{documentDate}} Y', values);
    assert.equal(out.trim(), 'X   Y'.trim());
    assert.doesNotMatch(out, /\{\{/);
    assert.doesNotMatch(substituteTokens('{{anything.here}}', values), /\{\{/);
  });
  test('dynamic page tokens survive substituteTokens and are filled by substitutePageTokens', () => {
    const line = substituteTokens('{{institution.name}} · Page {{pageNumber}} of {{totalPages}}', values);
    assert.match(line, /\{\{pageNumber\}\}/);
    assert.equal(substitutePageTokens(line, { pageNumber: 3, totalPages: 7 }), 'Riverside School · Page 3 of 7');
  });
  test('null/undefined input yields empty string', () => {
    assert.equal(substituteTokens(null, values), '');
    assert.equal(substituteTokens(undefined, values), '');
  });
});

describe('instruction preset resolution', () => {
  const template = {
    instructionBlock: { defaultPresetId: 'std' },
    instructionPresets: [
      { id: 'std', scope: 'INSTITUTION', lines: ['Answer on separate paper.', 'First 15 minutes are for reading.'] },
      { id: 'eng', scope: 'SUBJECT', subject: 'English', lines: ['Do not spend more than 30 minutes on Q1.'] },
    ],
  };
  test('default preset lines + per-assessment instruction override are appended in order', () => {
    const lines = resolveDefaultInstructionLines(template, { instructions: 'Bring a calculator.\nNo phones.' });
    assert.deepEqual(lines, [
      'Answer on separate paper.',
      'First 15 minutes are for reading.',
      'Bring a calculator.',
      'No phones.',
    ]);
  });
  test('subject preset is used when the subject matches, else falls back to default', () => {
    assert.deepEqual(resolveInstructionLinesForSubject(template, 'English', {}), ['Do not spend more than 30 minutes on Q1.']);
    assert.deepEqual(resolveInstructionLinesForSubject(template, 'Biology', {}), [
      'Answer on separate paper.',
      'First 15 minutes are for reading.',
    ]);
  });
});

describe('resolvePaperTemplateSnapshot', () => {
  const template = {
    _id: 'tmpl1',
    name: 'Ashoka-style',
    header: {
      showLogo: true,
      lines: [
        { text: '{{documentNumber}} Rev {{revision}} Date: {{documentDate}}', emphasis: 'small' },
        { text: '{{institution.name}}', emphasis: 'title' },
        { text: 'ACADEMIC SESSION {{academicSession}}' },
        { text: '{{assessmentTitle}}' },
        { text: 'Maximum Marks: {{maximumMarks}}   {{subject}}   Time: {{duration}}' },
      ],
    },
    instructionBlock: { heading: 'INSTRUCTIONS', style: 'bullets', defaultPresetId: 'std' },
    instructionPresets: [{ id: 'std', scope: 'INSTITUTION', lines: ['Answer on separate paper.'] }],
    sectionHeading: { style: 'roman', showMarks: true, showAttemptRule: true },
    marksNotation: 'BRACKET_SQUARE',
    footer: {
      lines: [{ text: '{{academicSession}}/{{assessmentTitle}}/{{grade}}/{{subject}}' }],
      pageNumbering: { show: true, format: 'Page {{pageNumber}} of {{totalPages}}' },
    },
  };

  test('produces a deep-frozen POJO with tokens substituted and page tokens kept literal', () => {
    const snap = resolvePaperTemplateSnapshot({ template, branding, exam });
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.header));
    assert.equal(snap.templateId, 'tmpl1');
    assert.equal(snap.header.lines[1].text, 'Riverside School');
    assert.equal(snap.header.lines[4].text, 'Maximum Marks: 80   Biology   Time: 2 Hours');
    assert.deepEqual(snap.instructionBlock.lines, ['Answer on separate paper.']);
    assert.match(snap.footer.pageNumbering.format, /\{\{pageNumber\}\}/);
    assert.doesNotMatch(JSON.stringify(snap.header), /\{\{(?!pageNumber|totalPages)/);
  });

  test('empty branding ⇒ blank header lines, no crash, no leftover tokens', () => {
    const snap = resolvePaperTemplateSnapshot({ template, branding: {}, exam: {} });
    assert.equal(snap.header.lines[1].text, '');
    assert.doesNotMatch(JSON.stringify(snap), /\{\{(?!pageNumber|totalPages)[\w.]+\}\}/);
  });
});

describe('sanitizePaperTemplateOverrides', () => {
  test('keeps only the permitted keys', () => {
    const clean = sanitizePaperTemplateOverrides({
      documentNumber: 'X/1', assessmentTitle: 'T', paperName: 'P', instructions: 'i',
      marksNotation: 'DASH', header: { evil: true }, tenantId: 'nope',
    });
    assert.deepEqual(Object.keys(clean).sort(), ['assessmentTitle', 'documentNumber', 'instructions', 'paperName']);
  });
});

describe('toggle-driven branding block', () => {
  const tokenValues = resolveTokenValues({
    branding: { ...branding, affiliation: 'Affiliated to CBSE', tagline: 'Learn. Lead. Serve.', contactPhone: '011-555', contactEmail: 'x@y.z' },
    exam,
    templateBranding: {
      institutionName: { enabled: true, text: 'Pinned Academy' },
      documentNumber: { enabled: true, text: 'ACA/R/09' },
    },
  });

  test('a template-branding element text OVERRIDES the resolved value', () => {
    assert.equal(tokenValues['institution.name'], 'Pinned Academy');
    assert.equal(tokenValues.documentNumber, 'ACA/R/09');
  });

  test('new institutional tokens resolve from branding', () => {
    assert.equal(tokenValues['institution.affiliation'], 'Affiliated to CBSE');
    assert.equal(tokenValues['institution.tagline'], 'Learn. Lead. Serve.');
    assert.match(tokenValues['institution.contact'], /011-555.*x@y\.z/);
  });

  test('composeHeaderFromBranding emits a row per enabled element only', () => {
    const values = resolveTokenValues({ branding, exam });
    const rows = composeHeaderFromBranding(
      {
        documentControl: { enabled: true },
        documentNumber: { enabled: true },
        revision: { enabled: true },
        documentDate: { enabled: false },
        institutionName: { enabled: true },
        affiliation: { enabled: false },
        address: { enabled: false },
        academicSession: { enabled: true },
        assessmentTitle: { enabled: true },
        gradeClass: { enabled: true },
        maximumMarks: { enabled: true },
        subjectPaper: { enabled: true },
        duration: { enabled: true },
      },
      { ...values, documentNumber: 'ACA/R/08', revision: '00', grade: 'VII' }
    );
    const text = rows.map((r) => r.text).join(' | ');
    assert.match(text, /Document No\. ACA\/R\/08\s+Rev\. 00/);
    assert.doesNotMatch(text, /Date:/); // documentDate disabled
    assert.match(text, /Riverside School/);
    assert.match(text, /ACADEMIC SESSION 2025/);
    assert.match(text, /GRADE VII/);
    assert.match(text, /Maximum Marks: 80/);
    assert.match(text, /Time: 2 Hours/);
  });

  test('brandingHasContent — true only when some element is enabled', () => {
    assert.equal(brandingHasContent(null), false);
    assert.equal(brandingHasContent({ institutionName: { enabled: false } }), false);
    assert.equal(brandingHasContent({ institutionName: { enabled: true } }), true);
  });

  test('snapshot uses the branding-composed header + freezes accent/watermark/secondary-logo', () => {
    const snap = resolvePaperTemplateSnapshot({
      template: {
        _id: 't1',
        name: 'Branded',
        branding: {
          logo: { enabled: true, source: 'AUTO', align: 'left', maxHeightPx: 80 },
          institutionName: { enabled: true },
          assessmentTitle: { enabled: true },
          accentColor: { enabled: true, hex: '#0055aa' },
          watermark: { enabled: true, text: 'CONFIDENTIAL' },
          secondaryLogo: { enabled: true, url: '/uploads/x/sec.png' },
        },
        instructionPresets: [{ id: 'd', scope: 'INSTITUTION', lines: ['Read carefully.'] }],
        instructionBlock: { defaultPresetId: 'd' },
        footer: { pageNumbering: { show: true, format: 'Page {{pageNumber}} of {{totalPages}}' } },
      },
      branding,
      exam,
    });
    assert.equal(snap.branding.accentColor, '#0055aa');
    assert.equal(snap.branding.watermarkText, 'CONFIDENTIAL');
    assert.equal(snap.branding.secondaryLogoUrl, '/uploads/x/sec.png');
    assert.equal(snap.branding.logoAlign, 'left');
    assert.equal(snap.branding.logoMaxHeightPx, 80);
    assert.ok(snap.header.lines.some((l) => l.text === 'Riverside School'));
    assert.ok(snap.header.lines.some((l) => l.text === 'Assessment 1'));
  });
});

describe('constants', () => {
  test('token + override lists are the documented ones', () => {
    assert.ok(TEMPLATE_TOKENS.includes('institution.logo'));
    assert.ok(TEMPLATE_TOKENS.includes('institution.affiliation'));
    assert.ok(TEMPLATE_TOKENS.includes('institution.secondaryLogo'));
    assert.ok(TEMPLATE_TOKENS.includes('pageNumber'));
    assert.deepEqual([...PERMITTED_OVERRIDE_KEYS].sort(), ['assessmentTitle', 'documentNumber', 'instructions', 'paperName']);
  });
  test('marks notation renderers', () => {
    assert.equal(MARKS_NOTATION_RENDER.BRACKET_SQUARE(5), '[5]');
    assert.equal(MARKS_NOTATION_RENDER.BRACKET_ROUND(5), '(5)');
    assert.equal(MARKS_NOTATION_RENDER.DASH(5), '— 5');
    assert.equal(MARKS_NOTATION_RENDER.PLAIN(5), '5');
  });
});
