import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const QuestionSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      index: true,
      sparse: true,
      immutable: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      required: true,
      index: true,
    },
    questionText: {
      type: String,
      required: true,
      trim: true,
    },
    questionType: {
      type: String,
      enum: [
        'MULTIPLE_CHOICE',
        'MULTIPLE_OPTIONS',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'NUMBER',
      ],
      required: true,
    },
    options: {
      type: mongoose.Schema.Types.Mixed,
    },
    correctAnswer: {
      type: String,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    passage: {
      type: String,
      trim: true,
    },
    points: {
      type: Number,
      default: 1,
      min: 0,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      index: true,
    },
    translations: {
      type: Map,
      of: {
        questionText: { type: String, trim: true },
        options: { type: mongoose.Schema.Types.Mixed },
        passage: { type: String, trim: true },
      },
      default: new Map(),
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
QuestionSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Question'),
        ID_PREFIXES.QUESTION
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

QuestionSchema.index({ uniqueId: 1 });
QuestionSchema.index({ questionPaperId: 1, order: 1 });
QuestionSchema.index({ sectionId: 1, order: 1 });

export default mongoose.model('Question', QuestionSchema);

