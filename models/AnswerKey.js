import mongoose from 'mongoose';

const AnswerKeySchema = new mongoose.Schema(
  {
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      index: true,
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    answers: {
      type: Map,
      of: {
        correctAnswer: {
          type: mongoose.Schema.Types.Mixed,
        },
        points: {
          type: Number,
          default: 1,
        },
        explanation: {
          type: String,
          trim: true,
        },
      },
      default: new Map(),
    },
    source: {
      type: String,
      enum: ['MANUAL', 'IMPORTED_PDF', 'IMPORTED_EXCEL', 'IMPORTED_IMAGE'],
      default: 'MANUAL',
    },
    importedAt: {
      type: Date,
    },
    importedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

AnswerKeySchema.index({ examId: 1, questionPaperId: 1, version: 1 });
AnswerKeySchema.index({ examId: 1, isActive: 1 });
AnswerKeySchema.index({ questionPaperId: 1, isActive: 1 });

export default mongoose.model('AnswerKey', AnswerKeySchema);
