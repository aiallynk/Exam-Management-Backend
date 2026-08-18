import mongoose from 'mongoose';

// WizKids Phase 5 — Reusable Question Bank.
//
// Traces a materialized standard Question back to the WizKidsQuestionBankItem
// it came from and the exam it was materialized into. This is what prevents
// the core Question schema from accumulating WizKids-only fields (master
// prompt §22) — every WizKids-specific fact about a materialized question
// (which bank item it came from, renderer/skill metadata) lives here, not on
// Question itself. Deleting this collection never invalidates the
// materialized Question documents it points to — they remain ordinary,
// fully standalone standard questions.
const WizKidsQuestionLinkSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    bankItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WizKidsQuestionBankItem',
      required: true,
      index: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      required: true,
    },
    // One link per materialized Question — a bank item may be materialized
    // into many different exams (many links, same bankItemId), but each
    // resulting Question row is traced by exactly one link.
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
    },
    rendererConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    skillMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    materializedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

WizKidsQuestionLinkSchema.index({ questionId: 1 }, { unique: true });
WizKidsQuestionLinkSchema.index({ tenantId: 1, bankItemId: 1 });
WizKidsQuestionLinkSchema.index({ tenantId: 1, examId: 1 });

export default mongoose.model('WizKidsQuestionLink', WizKidsQuestionLinkSchema);
