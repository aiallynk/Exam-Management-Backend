import mongoose from 'mongoose';

// Versioned deterministic-question rules. Templates belong to the WizKids
// module; generated output is materialised through the existing Question
// pipeline, never stored as a second kind of core question.
const WizKidsQuestionTemplateSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    templateKey: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    domain: {
      type: String,
      enum: ['MENTAL_MATHS', 'VEDIC_MATHS', 'SUPER_MATHS', 'LOGIC'],
      required: true,
    },
    gradeLevel: { type: Number, required: true, min: 1, max: 7 },
    topic: { type: String, trim: true, default: '' },
    subTopic: { type: String, trim: true, default: '' },
    skill: { type: String, trim: true, default: '' },
    difficulty: { type: String, enum: ['EASY', 'MEDIUM', 'HARD'], default: 'MEDIUM' },
    strategy: {
      type: String,
      enum: [
        'ARITHMETIC',
        'MULTI_ADD',
        'CHAIN',
        'MISSING_NUMBER',
        'FRACTION',
        'PERCENTAGE',
        'POWER',
        'SEQUENCE',
        'VEDIC_TIMES_ELEVEN',
        'VEDIC_NEAR_BASE',
        'VEDIC_SQUARE_ENDING_FIVE',
        'SUPER_CHALLENGE',
        'LOGIC_ODD_ONE_OUT',
      ],
      required: true,
    },
    // Rules remain template-owned so the same template + seed can always be
    // replayed. Unknown keys are ignored by the generator rather than treated
    // as executable instructions.
    rules: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, required: true, default: 1, min: 1 },
    status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'], default: 'DRAFT' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

WizKidsQuestionTemplateSchema.index({ tenantId: 1, templateKey: 1, version: 1 }, { unique: true });
WizKidsQuestionTemplateSchema.index({ tenantId: 1, domain: 1, gradeLevel: 1, status: 1 });

export default mongoose.model('WizKidsQuestionTemplate', WizKidsQuestionTemplateSchema);
