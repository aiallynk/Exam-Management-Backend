import mongoose from 'mongoose';

// WizKids Phase 5 — Reusable Question Bank.
//
// The standard Question model is tied to a questionPaperId (one exam), so it
// cannot represent a question reusable across many exams (see
// DOCS/WIZKIDS_INTEGRATION_ASSESSMENT.md §11 and master prompt §21). This is
// the isolated, cross-exam-reusable WizKids question source. It is never
// attempted directly by a candidate — an item is *materialized* into a real
// standard Question (see services/wizKidsQuestionBankService.js
// materializeQuestion()) before it can appear in any exam, at which point
// the standard attempt/evaluation/result pipeline takes over completely
// unmodified.
const WizKidsQuestionBankItemSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    domain: {
      type: String,
      enum: ['MENTAL_MATHS', 'VEDIC_MATHS', 'SUPER_MATHS', 'LOGIC', 'OLYMPIAD'],
      required: true,
    },
    // Kept intentionally simple — a plain 1-7 integer (master prompt §20),
    // matching WizKidsBatch.gradeLevel / WizKidsExamConfig.gradeLevel.
    gradeLevel: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
    },
    // Domain -> Topic -> Sub-topic -> Skill taxonomy (master prompt §23).
    // Free text for the first version — a controlled taxonomy/lookup table
    // is a later-phase concern once real content volume justifies it.
    topic: { type: String, trim: true, default: '' },
    subTopic: { type: String, trim: true, default: '' },
    skill: { type: String, trim: true, default: '' },
    difficulty: {
      type: String,
      enum: ['EASY', 'MEDIUM', 'HARD'],
      default: 'MEDIUM',
    },
    // WizKids's own vocabulary for how a student answers this question.
    // Reuses existing Xamigo question types wherever they fit (master
    // prompt §24) — materializeQuestion() maps each of these onto the
    // existing Question.questionType enum, introducing zero new question
    // types on the core model.
    interactionType: {
      type: String,
      enum: ['MCQ', 'NUMBER', 'SHORT_ANSWER', 'FILL_IN_THE_BLANK', 'MATCHING', 'IMAGE'],
      required: true,
    },
    questionContent: {
      type: String,
      required: true,
      trim: true,
    },
    // MCQ/MATCHING option data — shape depends on interactionType, mirrors
    // the existing Question.options Mixed field's own flexibility.
    options: {
      type: mongoose.Schema.Types.Mixed,
    },
    correctAnswer: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    solution: { type: String, trim: true, default: '' },
    explanation: { type: String, trim: true, default: '' },
    media: {
      imageUrl: { type: String, trim: true, default: null },
    },
    // Provenance for a future deterministic generator (Phase 9+) — empty for
    // every hand-authored item.
    generatorMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Only PUBLISHED items can be materialized into an exam — draft content
    // stays reviewable/editable without risk of a half-finished question
    // reaching a student.
    status: {
      type: String,
      enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
      default: 'DRAFT',
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  {
    timestamps: true,
  }
);

WizKidsQuestionBankItemSchema.index({ tenantId: 1, domain: 1, gradeLevel: 1, status: 1 });
WizKidsQuestionBankItemSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export default mongoose.model('WizKidsQuestionBankItem', WizKidsQuestionBankItemSchema);
