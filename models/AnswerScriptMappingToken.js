import mongoose from 'mongoose';

// Opaque, revocable linkage printed as QR and/or Code 128 on an offline
// paper. The plaintext bearer token is returned only once; Mongo stores its
// SHA-256 digest, never candidate contact data or the token itself.
const AnswerScriptMappingTokenSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  questionPaperId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionPaper', required: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamSession', default: null },
  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment', default: null },
  tokenHash: { type: String, required: true, unique: true, immutable: true },
  status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', index: true },
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

AnswerScriptMappingTokenSchema.index({ tenantId: 1, examId: 1, questionPaperId: 1, status: 1 });
AnswerScriptMappingTokenSchema.index({ tenantId: 1, candidateId: 1, status: 1 });

export default mongoose.model('AnswerScriptMappingToken', AnswerScriptMappingTokenSchema);
