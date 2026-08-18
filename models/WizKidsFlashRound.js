import mongoose from 'mongoose';

const WizKidsFlashRoundSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  questionPaperId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionPaper', required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  configVersion: { type: Number, required: true, min: 1 },
  seed: { type: String, required: true, trim: true },
  difficulty: { type: String, enum: ['EASY', 'MEDIUM', 'HARD', 'ULTRA_HARD'], required: true },
  operationMode: { type: String, enum: ['ADDITION', 'SUBTRACTION', 'ADD_SUB_MIXED'], required: true },
  operands: { type: [Number], required: true },
  operators: { type: [String], enum: ['+', '-'], required: true },
  flashDurationMs: { type: Number, required: true, min: 150, max: 10000 },
  gapDurationMs: { type: Number, required: true, min: 0, max: 5000 },
  answerWindowMs: { type: Number, required: true, min: 1000, max: 120000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

WizKidsFlashRoundSchema.index({ questionId: 1 }, { unique: true });
WizKidsFlashRoundSchema.index({ tenantId: 1, examId: 1, questionPaperId: 1 });

export default mongoose.model('WizKidsFlashRound', WizKidsFlashRoundSchema);
