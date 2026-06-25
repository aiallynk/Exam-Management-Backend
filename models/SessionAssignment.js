import mongoose from 'mongoose';

const SessionAssignmentSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamSession',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      default: null,
    },
    grantsAccess: {
      type: Boolean,
      default: false,
    },
    orderIndex: {
      type: Number,
      default: 0,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

SessionAssignmentSchema.index({ sessionId: 1, userId: 1 }, { unique: true });
SessionAssignmentSchema.index({ sessionId: 1, orderIndex: -1 });
SessionAssignmentSchema.index({ sessionId: 1, grantsAccess: 1 });

const SessionAssignment = mongoose.model('SessionAssignment', SessionAssignmentSchema);

export default SessionAssignment;


