import mongoose from 'mongoose';

const QuestionSchema = new mongoose.Schema(
  {
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
  },
  {
    timestamps: true,
  }
);

QuestionSchema.index({ questionPaperId: 1, order: 1 });

export default mongoose.model('Question', QuestionSchema);

