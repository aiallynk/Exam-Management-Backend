import mongoose from 'mongoose';

// WizKids Phase 4 — Exam Integration.
//
// Everything WizKids-specific about an exam lives here, entirely outside the
// core Exam model (master prompt §18 — "Do not add a large number of
// WizKids-specific fields directly onto Exam... Core Exam should only need
// to know productModule = WIZKIDS"). One document per WizKids Exam
// (enforced by the unique index on examId below). Deleting this document
// (or the collection) has zero impact on the underlying Exam/QuestionPaper/
// Section/Question/ExamAttempt records, which remain fully valid,
// standard, ordinary Xamigo exam data — this is what makes physical
// removal of WizKids possible later (master prompt §61).
const WizKidsExamConfigSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
    },
    // Phase 4 released TEST/OLYMPIAD/COMPETITION/WORKSHEET first, since they
    // map directly onto the existing attempt engine unmodified (master
    // prompt §29). Phase 7 unlocked PRACTICE once its instant-feedback check
    // endpoint existed (services/wizKidsPracticeService.js). SPEED remains a
    // reserved enum value for Phase 8, whose per-question-timer+auto-advance
    // behavior does not exist yet — see UNSUPPORTED_EXAM_MODES in
    // services/wizKidsExamService.js, which rejects creating a config with
    // that mode until the attempt-engine work lands.
    mode: {
      type: String,
      enum: ['TEST', 'PRACTICE', 'SPEED', 'WORKSHEET', 'COMPETITION', 'OLYMPIAD'],
      required: true,
    },
    interactionMode: {
      type: String,
      enum: ['STANDARD', 'FLASH_MATHS'],
      default: 'STANDARD',
    },
    flashMaths: {
      configVersion: { type: Number, default: 1, min: 1 },
      difficulty: {
        type: String,
        enum: ['EASY', 'MEDIUM', 'HARD', 'ULTRA_HARD'],
        default: 'EASY',
      },
      operationMode: {
        type: String,
        enum: ['ADDITION', 'SUBTRACTION', 'ADD_SUB_MIXED'],
        default: 'ADDITION',
      },
      operandCount: { type: Number, min: 2, max: 20, default: 5 },
      minimumDigits: { type: Number, min: 1, max: 4, default: 1 },
      maximumDigits: { type: Number, min: 1, max: 4, default: 2 },
      flashDurationMs: { type: Number, min: 150, max: 10000, default: 750 },
      gapDurationMs: { type: Number, min: 0, max: 5000, default: 250 },
      answerWindowMs: { type: Number, min: 1000, max: 120000, default: 30000 },
      negativeIntermediateAllowed: { type: Boolean, default: false },
    },
    // Kept intentionally simple — a plain 1-7 integer (master prompt §20),
    // matching WizKidsBatch.gradeLevel.
    gradeLevel: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
    },
    domains: {
      type: [String],
      enum: ['MENTAL_MATHS', 'VEDIC_MATHS', 'SUPER_MATHS', 'LOGIC', 'OLYMPIAD'],
      default: [],
    },
    batchIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'WizKidsBatch',
      default: [],
    },
    // Reserved for Phase 7 (Practice Mode) — must stay false until that
    // attempt-engine behavior is actually implemented.
    instantFeedback: {
      type: Boolean,
      default: false,
    },
    // Reserved for Phase 8 (Speed Mode).
    autoAdvance: {
      type: Boolean,
      default: false,
    },
    allowBackNavigation: {
      type: Boolean,
      default: true,
    },
    // Reserved for Phase 8 (Speed Mode) per-question timing.
    questionTimerSeconds: {
      type: Number,
      default: null,
      min: 1,
    },
    // Reserved for Phase 9+ (deterministic generators) — provenance of any
    // generated questions used to build this exam.
    generatorMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

WizKidsExamConfigSchema.index({ examId: 1 }, { unique: true });
WizKidsExamConfigSchema.index({ tenantId: 1, mode: 1, createdAt: -1 });
WizKidsExamConfigSchema.index({ tenantId: 1, gradeLevel: 1 });

export default mongoose.model('WizKidsExamConfig', WizKidsExamConfigSchema);
