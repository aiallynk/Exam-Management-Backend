import mongoose from 'mongoose';
const FormativeAnswerCheckSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', required: true, index: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answer: { type: String, default: '' },
  isCorrect: { type: Boolean, required: true },
  feedback: { type: String, default: '' },
  checkedAt: { type: Date, default: Date.now },
}, { timestamps: true });
FormativeAnswerCheckSchema.index({ tenantId: 1, attemptId: 1, questionId: 1, checkedAt: -1 });
export default mongoose.model('FormativeAnswerCheck', FormativeAnswerCheckSchema);
