import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const SectionSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false,
      sparse: true,
      immutable: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
    duration: {
      type: Number,
      required: true,
      min: 1, // minutes
    },
    marks: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Authoritative per-question mark value for this section. Assigning or
    // moving a question into this section sets Question.points from here, so
    // this is the single source of truth for "how many marks per question in
    // this section" — `marks` above is kept only as a legacy total snapshot.
    marksPerQuestion: {
      type: Number,
      default: 1,
      min: 0,
    },
    negativeMarking: {
      type: Number,
      default: 0,
      min: 0,
    },
    navigationRule: {
      type: String,
      enum: ['FREE', 'LINEAR', 'NO_FREE', 'ADMIN_CONFIGURED'],
      default: 'FREE',
    },
    instructions: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expectedQuestions: {
      type: Number,
      default: 25,
      min: 0,
    },
    // Section attempt semantics (Phase 1C). Additive & backward-compatible:
    // the default { mode: 'ALL' } means every section that predates this field,
    // and every section created without it, is read and delivered exactly as
    // before (answer every question). 'ANY_N' + requiredCount records a
    // "attempt any N questions from this section" rule detected on import or
    // set manually. Stage 1 persists this as METADATA ONLY — delivery,
    // packaging (services/examPackageService.js) and scoring still treat every
    // section as ALL until a separately-signed-off sub-stage enables ANY_N
    // end-to-end with its own evaluation regression pass.
    attemptRule: {
      mode: { type: String, enum: ['ALL', 'ANY_N'], default: 'ALL' },
      requiredCount: { type: Number, default: null, min: 1 },
      // 'DETECTED' (from import), 'MANUAL', or 'REVIEW_REQUIRED' when the
      // source structure could not be represented safely and must not be
      // silently converted into multiple compulsory questions.
      source: { type: String, enum: ['MANUAL', 'DETECTED', 'REVIEW_REQUIRED'], default: 'MANUAL' },
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
SectionSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Section'),
        'SEC'
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

SectionSchema.index({ questionPaperId: 1, order: 1 });
SectionSchema.index({ questionPaperId: 1, isActive: 1 });

export default mongoose.model('Section', SectionSchema);
