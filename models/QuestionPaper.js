import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const QuestionPaperSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
      immutable: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
    },
    setName: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sections: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Section',
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
QuestionPaperSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('QuestionPaper'),
        ID_PREFIXES.QUESTION_PAPER
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Unique constraint: one set name per exam
QuestionPaperSchema.index({ examId: 1, setName: 1 }, { unique: true });

export default mongoose.model('QuestionPaper', QuestionPaperSchema);

