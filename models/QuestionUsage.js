import mongoose from 'mongoose';
const QuestionUsageSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  // Exactly one of questionId/questionVersionId is normally set — an event
  // log entry (append-only), not a uniqueness-enforced pointer, so this is
  // left as a convention rather than a schema-level constraint.
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null, index: true },
  questionVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionVersion', default: null, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
  courseOfferingId: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseOffering', default: null },
  frameworkVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FrameworkVersion', default: null },
  event: { type: String, enum: ['GENERATED', 'APPROVED', 'PUBLISHED', 'USED_IN_ASSESSMENT', 'SELECTED', 'DELIVERED', 'EVALUATED'], required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  occurredAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });
QuestionUsageSchema.index({ tenantId: 1, questionId: 1, occurredAt: -1 });
export default mongoose.model('QuestionUsage', QuestionUsageSchema);
