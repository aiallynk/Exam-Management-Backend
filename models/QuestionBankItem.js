import mongoose from 'mongoose';

// The canonical, reusable question-bank entry — independent of any exam.
// Exam Question (models/Question.js) stays a frozen DELIVERY object: when a
// creator reuses bank content, the approved QuestionVersion is MATERIALIZED
// (copied) into a new Question, never referenced live. See
// docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md Part 5.
const QuestionBankItemSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  organizationUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationUnit', default: null },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
  topic: { type: String, trim: true, maxlength: 200, default: '' },
  // Item-level lifecycle (is this bank entry in circulation at all) is
  // separate from QuestionVersion.status (that version's DRAFT/REVIEWED/
  // APPROVED/RETIRED review state) — an item can have several versions at
  // different review stages simultaneously.
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  currentVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionVersion', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

QuestionBankItemSchema.index({ tenantId: 1, courseId: 1, status: 1 });

export default mongoose.model('QuestionBankItem', QuestionBankItemSchema);
