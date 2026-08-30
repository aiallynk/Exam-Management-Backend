// Pure, dependency-free resolution of Question Paper Template placeholder
// tokens (Phase 1A). No mongoose / no I/O so it is trivially unit-testable
// and safe to call from both the freeze path and a live preview.
//
// Contract:
//  - Tokens are written {{token}} (optional inner whitespace tolerated).
//  - An unknown or empty token resolves to '' — never a crash, never a
//    leftover {{token}} in output. (Blueprint / brief: "Never hardcode
//    Ashoka branding"; a missing branding value simply renders blank.)
//  - pageNumber / totalPages are deliberately NOT resolved here: they depend
//    on rendered pagination, so the freeze keeps them literal and the
//    renderer substitutes them per page via substitutePageTokens().

export const TEMPLATE_TOKENS = Object.freeze([
  'institution.logo',
  'institution.name',
  'institution.address',
  'institution.affiliation',
  'institution.affiliationNumber',
  'institution.tagline',
  'institution.contact',
  'institution.secondaryLogo',
  'documentNumber',
  'revision',
  'documentDate',
  'academicSession',
  'assessmentTitle',
  'grade',
  'subject',
  'paperName',
  'maximumMarks',
  'duration',
  'pageNumber',
  'totalPages',
]);

// Overrides the Exam Creator is permitted to set per-assessment. Anything
// else in a submitted overrides object is ignored by the route.
export const PERMITTED_OVERRIDE_KEYS = Object.freeze([
  'documentNumber',
  'assessmentTitle',
  'paperName',
  'instructions',
]);

const DYNAMIC_TOKENS = new Set(['pageNumber', 'totalPages']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Build the static token → value map from institution branding, the exam,
 * and the permitted overrides. Overrides win over the exam, which wins over
 * branding defaults.
 */
export const resolveTokenValues = ({
  branding = {},
  exam = {},
  overrides = {},
  subject = '',
  grade = '',
  paperName = '',
  templateBranding = null,
} = {}) => {
  const b = branding || {};
  const o = overrides || {};
  // A template-branding element's own `text` overrides the resolved value.
  const tb = templateBranding || {};
  const pick = (elKey, resolved) => str(tb?.[elKey]?.text) || resolved;
  const contact = tb?.contact || {};
  const contactLine = [contact.phone, contact.email, contact.website]
    .map((s) => str(s))
    .filter(Boolean)
    .join('  ·  ');
  const durationMinutes = Number(exam.duration) || 0;
  const durationText = durationMinutes
    ? durationMinutes % 60 === 0
      ? `${durationMinutes / 60} ${durationMinutes / 60 === 1 ? 'Hour' : 'Hours'}`
      : `${durationMinutes} min`
    : '';

  const tbAddress = Array.isArray(tb?.address?.lines) && tb.address.lines.length
    ? tb.address.lines.map(str).filter(Boolean).join(', ')
    : '';

  return {
    'institution.logo': str(tb?.logo?.templateLogoUrl) || str(b.logoUrl),
    'institution.name': pick('institutionName', str(b.institutionName)),
    'institution.address': tbAddress || (Array.isArray(b.addressLines) ? b.addressLines.map(str).filter(Boolean).join(', ') : str(b.address)),
    'institution.affiliation': pick('affiliation', str(b.affiliation)),
    'institution.affiliationNumber': pick('affiliationNumber', str(b.affiliationNumber)),
    'institution.tagline': pick('tagline', str(b.tagline)),
    'institution.contact': contactLine || [b.contactPhone, b.contactEmail, b.website].map(str).filter(Boolean).join('  ·  '),
    'institution.secondaryLogo': str(tb?.secondaryLogo?.url),
    documentNumber: pick('documentNumber', str(o.documentNumber) || str(b.documentNumberDefault)),
    revision: pick('revision', str(o.revision) || str(b.revisionDefault)),
    documentDate: pick('documentDate', str(o.documentDate) || str(b.documentDateDefault)),
    academicSession: pick('academicSession', str(exam?.academicContext?.academicSession) || str(b.academicSessionDefault)),
    assessmentTitle: str(o.assessmentTitle) || str(exam.title),
    grade: str(grade) || str(exam?.academicContext?.grade) || str(exam?.academicContext?.className),
    subject: str(subject) || str(exam?.academicContext?.subject),
    paperName: str(o.paperName) || str(paperName) || str(exam?.academicContext?.paperName),
    maximumMarks: exam.totalMarks ? String(exam.totalMarks) : '',
    duration: durationText,
    // Kept literal on purpose — see module header.
    pageNumber: '{{pageNumber}}',
    totalPages: '{{totalPages}}',
  };
};

// Compose the paper header rows from the toggle-driven branding block. Only
// enabled elements with a resolved value produce a row. Returns
// [{ text, align, emphasis }]. When `branding` has no enabled element the
// caller falls back to the legacy header.lines[] path.
export const composeHeaderFromBranding = (templateBranding, values = {}) => {
  const tb = templateBranding || {};
  const on = (k) => tb?.[k]?.enabled;
  const rows = [];
  const push = (text, emphasis = 'normal', align = 'center') => {
    const t = str(text);
    if (t) rows.push({ text: t, align, emphasis });
  };

  if (on('documentControl')) {
    const bits = [];
    if (tb.documentNumber?.enabled && values.documentNumber) bits.push(`Document No. ${values.documentNumber}`);
    if (tb.revision?.enabled && values.revision) bits.push(`Rev. ${values.revision}`);
    if (tb.documentDate?.enabled && values.documentDate) bits.push(`Date: ${values.documentDate}`);
    push(bits.join('   '), 'small', 'left');
  }
  if (on('institutionName')) push(values['institution.name'], 'title');
  if (on('affiliation')) push(values['institution.affiliation'], 'small');
  if (on('affiliationNumber') && values['institution.affiliationNumber']) push(`Affiliation No. ${values['institution.affiliationNumber']}`, 'small');
  if (on('address')) push(values['institution.address'], 'small');
  if (on('tagline')) push(values['institution.tagline'], 'small');
  if (on('contact')) push(values['institution.contact'], 'small');
  if (on('academicSession') && values.academicSession) push(`ACADEMIC SESSION ${values.academicSession}`);
  if (on('assessmentTitle')) push(values.assessmentTitle, 'bold');
  if (on('gradeClass') && values.grade) push(`GRADE ${values.grade}`);
  const metaBits = [];
  if (on('maximumMarks') && values.maximumMarks) metaBits.push(`Maximum Marks: ${values.maximumMarks}`);
  if (on('subjectPaper') && (values.subject || values.paperName)) metaBits.push(values.paperName || values.subject);
  if (on('duration') && values.duration) metaBits.push(`Time: ${values.duration}`);
  push(metaBits.join('      '));
  return rows;
};

// True when the branding block should drive the header (any element enabled).
export const brandingHasContent = (templateBranding) => {
  const tb = templateBranding || {};
  return Object.keys(tb).some((k) => tb[k] && typeof tb[k] === 'object' && tb[k].enabled);
};

/**
 * Replace every {{token}} in `text` using `values`. Unknown / empty →
 * removed. Dynamic page tokens are preserved verbatim so a later
 * substitutePageTokens() pass can fill them.
 */
export const substituteTokens = (text, values = {}) => {
  if (text === null || text === undefined) return '';
  return String(text).replace(TOKEN_RE, (_m, name) => {
    if (DYNAMIC_TOKENS.has(name)) return `{{${name}}}`;
    const v = values[name];
    return v === undefined || v === null ? '' : String(v);
  });
};

/** Per-page fill of the two dynamic tokens the freeze left literal. */
export const substitutePageTokens = (text, { pageNumber, totalPages } = {}) =>
  String(text ?? '')
    .replace(/\{\{\s*pageNumber\s*\}\}/g, str(pageNumber))
    .replace(/\{\{\s*totalPages\s*\}\}/g, str(totalPages));

const resolveLine = (line, values) => {
  if (typeof line === 'string') return { text: substituteTokens(line, values), align: 'center', emphasis: 'normal' };
  return {
    text: substituteTokens(line?.text, values),
    align: line?.align || 'center',
    emphasis: line?.emphasis || 'normal',
  };
};

/**
 * Deep-resolve a QuestionPaperTemplate document into the plain, fully-token-
 * substituted configuration that gets frozen onto Exam.paperTemplateSnapshot.
 * The returned object is a frozen POJO (safe to persist as Mixed).
 *
 * `instructionLines` is the ordered instruction set already chosen for this
 * assessment (institution default preset, a subject preset, and/or the
 * per-assessment `instructions` override) — resolution of *which* preset
 * applies happens in paperTemplateService; this function only substitutes.
 */
export const resolvePaperTemplateSnapshot = ({
  template = {},
  branding = {},
  exam = {},
  overrides = {},
  instructionLines = null,
  subject = '',
  grade = '',
  paperName = '',
} = {}) => {
  const tb = template.branding || null;
  const values = resolveTokenValues({ branding, exam, overrides, subject, grade, paperName, templateBranding: tb });

  const header = template.header || {};
  const instructionBlock = template.instructionBlock || {};
  const footer = template.footer || {};

  const lines = Array.isArray(instructionLines) && instructionLines.length
    ? instructionLines
    : resolveDefaultInstructionLines(template, overrides);

  // Toggle-driven branding block drives the header when any element is
  // enabled; otherwise the legacy hand-authored header.lines[] path is used.
  const useBrandingHeader = brandingHasContent(tb);
  const composedRows = useBrandingHeader ? composeHeaderFromBranding(tb, values) : null;
  const legacyRows = (Array.isArray(header.lines) ? header.lines : []).map((l) => resolveLine(l, values));

  const logoEnabled = tb ? tb.logo?.enabled !== false : header.showLogo !== false;
  const logoAlign = tb?.logo?.align || header.logoAlign || 'center';

  const snapshot = {
    templateId: template._id ? String(template._id) : null,
    templateName: str(template.name),
    capturedAt: new Date().toISOString(),
    tokens: values,
    branding: {
      institutionName: values['institution.name'],
      logoUrl: values['institution.logo'],
      logoAlign,
      logoMaxHeightPx: tb?.logo?.maxHeightPx || 64,
      logoSource: tb?.logo?.source || 'AUTO',
      secondaryLogoUrl: tb?.secondaryLogo?.enabled ? values['institution.secondaryLogo'] : '',
      address: values['institution.address'],
      affiliation: values['institution.affiliation'],
      tagline: values['institution.tagline'],
      contact: values['institution.contact'],
      accentColor: tb?.accentColor?.enabled ? (str(tb.accentColor.hex) || '#1e293b') : '',
      watermarkText: tb?.watermark?.enabled ? (str(tb.watermark.text) || values['institution.name']) : '',
    },
    header: {
      showLogo: logoEnabled,
      logoAlign,
      // Composed rows (branding-driven) then any custom legacy lines after.
      lines: useBrandingHeader ? [...composedRows, ...legacyRows] : legacyRows,
    },
    instructionBlock: {
      heading: str(instructionBlock.heading) || 'INSTRUCTIONS',
      style: instructionBlock.style || 'bullets',
      bulletMarker: instructionBlock.bulletMarker || '•',
      lines: lines.map((l) => substituteTokens(l, values)).filter((l) => l !== ''),
    },
    sectionHeading: {
      style: template.sectionHeading?.style || 'roman',
      showMarks: template.sectionHeading?.showMarks !== false,
      showAttemptRule: template.sectionHeading?.showAttemptRule !== false,
      align: template.sectionHeading?.align || 'center',
    },
    marksNotation: template.marksNotation || 'BRACKET_SQUARE',
    footer: {
      lines: (Array.isArray(footer.lines) ? footer.lines : []).map((l) => resolveLine(l, values)),
      pageNumbering: {
        show: footer.pageNumbering?.show !== false,
        format: str(footer.pageNumbering?.format) || 'Page {{pageNumber}} of {{totalPages}}',
        align: footer.pageNumbering?.align || 'right',
      },
    },
  };

  return deepFreeze(snapshot);
};

// Institution-default instruction lines: the preset named by
// instructionBlock.defaultPresetId, else the first INSTITUTION preset, plus
// the per-assessment `instructions` override appended as extra lines.
export const resolveDefaultInstructionLines = (template = {}, overrides = {}) => {
  const presets = Array.isArray(template.instructionPresets) ? template.instructionPresets : [];
  const wantId = str(template.instructionBlock?.defaultPresetId);
  const chosen =
    (wantId && presets.find((p) => str(p.id) === wantId)) ||
    presets.find((p) => p.scope === 'INSTITUTION') ||
    presets[0] ||
    null;
  const base = chosen && Array.isArray(chosen.lines) ? chosen.lines.map(str).filter(Boolean) : [];
  const extra = str(overrides?.instructions)
    ? str(overrides.instructions).split('\n').map(str).filter(Boolean)
    : [];
  return [...base, ...extra];
};

// Resolve the instruction lines for a chosen subject preset (falls back to
// the institution default when the subject has no dedicated preset).
export const resolveInstructionLinesForSubject = (template = {}, subject = '', overrides = {}) => {
  const presets = Array.isArray(template.instructionPresets) ? template.instructionPresets : [];
  const s = str(subject).toLowerCase();
  const subjectPreset = s && presets.find((p) => p.scope === 'SUBJECT' && str(p.subject).toLowerCase() === s);
  if (!subjectPreset) return resolveDefaultInstructionLines(template, overrides);
  const base = Array.isArray(subjectPreset.lines) ? subjectPreset.lines.map(str).filter(Boolean) : [];
  const extra = str(overrides?.instructions)
    ? str(overrides.instructions).split('\n').map(str).filter(Boolean)
    : [];
  return [...base, ...extra];
};

/** Keep only the permitted per-assessment override keys. */
export const sanitizePaperTemplateOverrides = (raw = {}) => {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const key of PERMITTED_OVERRIDE_KEYS) {
      if (raw[key] !== undefined && raw[key] !== null) out[key] = String(raw[key]);
    }
  }
  return out;
};

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.getOwnPropertyNames(obj).forEach((k) => deepFreeze(obj[k]));
    Object.freeze(obj);
  }
  return obj;
}

export const MARKS_NOTATION_RENDER = Object.freeze({
  BRACKET_SQUARE: (m) => `[${m}]`,
  BRACKET_ROUND: (m) => `(${m})`,
  DASH: (m) => `— ${m}`,
  PLAIN: (m) => `${m}`,
});
