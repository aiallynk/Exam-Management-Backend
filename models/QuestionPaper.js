import mongoose from 'mongoose';

const QuestionPaperSchema = new mongoose.Schema(
  {
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

// Unique constraint: one set name per exam
QuestionPaperSchema.index({ examId: 1, setName: 1 }, { unique: true });

export default mongoose.model('QuestionPaper', QuestionPaperSchema);

