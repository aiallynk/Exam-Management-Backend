import mongoose from 'mongoose';

const ExamSessionSchema = new mongoose.Schema(
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
      required: true,
    },
    qrCode: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    qrImage: {
      type: String,
    },
    manualToken: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    startTime: {
      type: Date,
      required: true,
    },
    endTime: {
      type: Date,
      required: true,
      validate: {
        validator: function (value) {
          return value > this.startTime;
        },
        message: 'End time must be after start time',
      },
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

ExamSessionSchema.index({ examId: 1, createdAt: -1 });
ExamSessionSchema.index({ isActive: 1, startTime: 1, endTime: 1 });

const ExamSession = mongoose.model('ExamSession', ExamSessionSchema);

export default ExamSession;

