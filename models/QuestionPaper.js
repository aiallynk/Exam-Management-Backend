import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const QuestionPaperSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: true,
      index: true,
      immutable: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
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
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before saving
QuestionPaperSchema.pre('save', async function (next) {
  if (!this.uniqueId) {
    this.uniqueId = await generateUniqueIdWithCheck(
      mongoose.model('QuestionPaper'),
      ID_PREFIXES.QUESTION_PAPER
    );
  }
  next();
});

// Unique constraint: one set name per exam
QuestionPaperSchema.index({ uniqueId: 1 });
QuestionPaperSchema.index({ examId: 1, setName: 1 }, { unique: true });

export default mongoose.model('QuestionPaper', QuestionPaperSchema);

