import mongoose from 'mongoose';

// Institutional Question Paper Template (Phase 1A). Additive, tenant-scoped,
// governed by TENANT_ADMIN / scoped ACADEMIC_ADMIN — mirrors RubricTemplate's
// governance shape. An Exam Creator only ever *selects* an APPROVED template
// and sets a small set of permitted per-assessment overrides; the resolved
// configuration is then frozen onto Exam.paperTemplateSnapshot at finalize so
// later branding/template edits never alter an already-created paper.
//
// Placeholder tokens (resolved by services/paperTemplateResolver.js against
// OrganizationUnit.metadata.branding + the Exam + overrides — never hardcoded
// to any one institution):
//   institution.logo, institution.name, documentNumber, revision, documentDate,
//   academicSession, assessmentTitle, grade, subject, paperName, maximumMarks,
//   duration, pageNumber, totalPages

const LineSchema = new mongoose.Schema(
  {
    // Free text that may embed {{token}} placeholders.
    text: { type: String, default: '', trim: true },
    align: { type: String, enum: ['left', 'center', 'right'], default: 'center' },
    emphasis: { type: String, enum: ['normal', 'bold', 'small', 'title'], default: 'normal' },
  },
  { _id: false }
);

const InstructionPresetSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, default: '', trim: true },
    // INSTITUTION = default set; SUBJECT = a subject/paper-specific preset the
    // creator may pick where current governance permits.
    scope: { type: String, enum: ['INSTITUTION', 'SUBJECT'], default: 'INSTITUTION' },
    subject: { type: String, default: '', trim: true },
    // Ordered instruction lines (add/remove/reorder handled in the admin UI).
    lines: { type: [String], default: [] },
  },
  { _id: false }
);

const QuestionPaperTemplateSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    // Optional narrower scope: a template owned by one org unit (e.g. a single
    // school within a school group). Null = tenant-wide.
    organizationUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationUnit', default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 2000 },
    approvalStatus: { type: String, enum: ['DRAFT', 'APPROVED', 'ARCHIVED'], default: 'DRAFT', index: true },

    // Toggle-driven institutional branding block. Each element carries its own
    // `enabled` switch; when a value string is set here it OVERRIDES the value
    // resolved from OrganizationUnit / Tenant branding (so a template can pin
    // its own institution name, doc number etc.). When `branding` has any
    // enabled element the paper header is composed from these elements;
    // otherwise the legacy `header.lines[]` path below is used unchanged
    // (full back-compat with Stage-1 templates).
    branding: {
      type: new mongoose.Schema(
        {
          logo: {
            enabled: { type: Boolean, default: true },
            // Where the top-of-paper logo comes from. AUTO walks:
            // template upload → organization logo → tenant logo →
            // tenant-admin profile picture → none.
            source: {
              type: String,
              enum: ['AUTO', 'TEMPLATE', 'ORGANIZATION', 'TENANT', 'PROFILE', 'NONE'],
              default: 'AUTO',
            },
            templateLogoUrl: { type: String, trim: true, default: '' },
            align: { type: String, enum: ['left', 'center', 'right'], default: 'center' },
            maxHeightPx: { type: Number, default: 64, min: 16, max: 200 },
          },
          secondaryLogo: {
            enabled: { type: Boolean, default: false },
            url: { type: String, trim: true, default: '' },
          },
          institutionName: { enabled: { type: Boolean, default: true }, text: { type: String, trim: true, default: '' } },
          address: { enabled: { type: Boolean, default: false }, lines: { type: [String], default: [] } },
          affiliation: { enabled: { type: Boolean, default: false }, text: { type: String, trim: true, default: '' } },
          affiliationNumber: { enabled: { type: Boolean, default: false }, text: { type: String, trim: true, default: '' } },
          tagline: { enabled: { type: Boolean, default: false }, text: { type: String, trim: true, default: '' } },
          contact: {
            enabled: { type: Boolean, default: false },
            phone: { type: String, trim: true, default: '' },
            email: { type: String, trim: true, default: '' },
            website: { type: String, trim: true, default: '' },
          },
          // The "Document No. X  Rev. Y  Date: Z" control line.
          documentControl: { enabled: { type: Boolean, default: true } },
          documentNumber: { enabled: { type: Boolean, default: true }, text: { type: String, trim: true, default: '' } },
          revision: { enabled: { type: Boolean, default: true }, text: { type: String, trim: true, default: '' } },
          documentDate: { enabled: { type: Boolean, default: true }, text: { type: String, trim: true, default: '' } },
          academicSession: { enabled: { type: Boolean, default: true }, text: { type: String, trim: true, default: '' } },
          assessmentTitle: { enabled: { type: Boolean, default: true } },
          gradeClass: { enabled: { type: Boolean, default: true } },
          subjectPaper: { enabled: { type: Boolean, default: true } },
          maximumMarks: { enabled: { type: Boolean, default: true } },
          duration: { enabled: { type: Boolean, default: true } },
          accentColor: { enabled: { type: Boolean, default: false }, hex: { type: String, trim: true, default: '#1e293b' } },
          watermark: { enabled: { type: Boolean, default: false }, text: { type: String, trim: true, default: '' } },
        },
        { _id: false }
      ),
      default: undefined,
    },

    header: {
      showLogo: { type: Boolean, default: true },
      logoAlign: { type: String, enum: ['left', 'center', 'right'], default: 'center' },
      // Ordered header lines, token-aware. A typical institutional header:
      //   {{documentNumber}}  Rev {{revision}}  Date: {{documentDate}}
      //   {{institution.name}}
      //   ACADEMIC SESSION {{academicSession}}
      //   {{assessmentTitle}}
      //   GRADE {{grade}}
      //   Maximum Marks: {{maximumMarks}}   {{subject}}   Time: {{duration}}
      lines: { type: [LineSchema], default: [] },
    },

    instructionBlock: {
      heading: { type: String, default: 'INSTRUCTIONS', trim: true },
      // 'bullets' renders each line with a leading marker; 'plain' does not.
      style: { type: String, enum: ['bullets', 'numbered', 'plain'], default: 'bullets' },
      bulletMarker: { type: String, default: '•', trim: true },
      // Which preset supplies the default lines (by InstructionPreset.id).
      defaultPresetId: { type: String, default: '', trim: true },
    },
    instructionPresets: { type: [InstructionPresetSchema], default: [] },

    sectionHeading: {
      // e.g. "SECTION {{sectionNumber}} ({{sectionMarks}} Marks)" then a rule line.
      style: { type: String, enum: ['roman', 'numeric', 'alpha', 'plain'], default: 'roman' },
      showMarks: { type: Boolean, default: true },
      showAttemptRule: { type: Boolean, default: true },
      align: { type: String, enum: ['left', 'center'], default: 'center' },
    },

    // How intended marks are printed next to a question.
    marksNotation: { type: String, enum: ['BRACKET_SQUARE', 'BRACKET_ROUND', 'DASH', 'PLAIN'], default: 'BRACKET_SQUARE' },

    footer: {
      lines: { type: [LineSchema], default: [] },
      pageNumbering: {
        show: { type: Boolean, default: true },
        // {{pageNumber}} / {{totalPages}} are substituted per rendered page.
        format: { type: String, default: 'Page {{pageNumber}} of {{totalPages}}', trim: true },
        align: { type: String, enum: ['left', 'center', 'right'], default: 'right' },
      },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

QuestionPaperTemplateSchema.index({ tenantId: 1, approvalStatus: 1, name: 1 });
QuestionPaperTemplateSchema.index({ tenantId: 1, organizationUnitId: 1 });

export default mongoose.model('QuestionPaperTemplate', QuestionPaperTemplateSchema);
