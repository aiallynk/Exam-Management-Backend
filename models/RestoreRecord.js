import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

export const RESTORE_STATUSES = ['DRAFT', 'ANALYZING', 'PREVIEW_READY', 'AWAITING_APPROVAL', 'APPROVED', 'QUEUED', 'DOWNLOADING', 'VERIFYING', 'DECRYPTING', 'STAGING', 'RESTORING', 'VALIDATING', 'COMPLETED', 'FAILED', 'ROLLING_BACK', 'ROLLED_BACK', 'CANCELLED'];
const RestoreRecordSchema = new mongoose.Schema({
  uniqueId: { type: String, default: () => `RST-${randomUUID()}`, unique: true, index: true }, backupId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', required: true, index: true }, restorePlanId: { type: String, default: '' },
  restoreType: { type: String, enum: ['FULL_PLATFORM', 'TENANT', 'SELECTIVE'], required: true }, scopeType: { type: String, enum: ['PLATFORM', 'TENANT', 'SUB_TENANT', 'EXAM'], required: true },
  targetTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true }, targetSubTenantId: { type: mongoose.Schema.Types.ObjectId, default: null }, targetExamId: { type: mongoose.Schema.Types.ObjectId, default: null }, targetCloneTenantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  restoreMode: { type: String, enum: ['REPLACE', 'MERGE', 'CLONE', 'PREVIEW_ONLY', 'SELECTED_COLLECTIONS'], required: true }, conflictStrategy: { type: String, enum: ['KEEP_EXISTING', 'OVERWRITE', 'SKIP', 'REMAP_IDS'], default: 'KEEP_EXISTING' }, selectedCollections: { type: [String], default: [] },
  status: { type: String, enum: RESTORE_STATUSES, default: 'DRAFT', index: true }, jobId: { type: String, unique: true, sparse: true, index: true }, idempotencyKey: { type: String, required: true },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, initiatedByRole: { type: String, required: true }, approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, approvalStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' }, approvalReason: { type: String, default: '' }, requestedReason: { type: String, required: true, trim: true },
  maintenanceMode: { type: Boolean, default: false }, preRestoreBackupId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null }, rollbackBackupId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null },
  recordsInserted: { type: Number, default: 0 }, recordsUpdated: { type: Number, default: 0 }, recordsDeleted: { type: Number, default: 0 }, recordsSkipped: { type: Number, default: 0 }, conflicts: { type: [mongoose.Schema.Types.Mixed], default: [] }, validationResults: { type: mongoose.Schema.Types.Mixed, default: {} }, metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  startedAt: Date, completedAt: Date, failureCode: { type: String, default: '' }, failureMessage: { type: String, default: '' },
}, { timestamps: true, collection: 'restore_records' });
RestoreRecordSchema.index({ idempotencyKey: 1, initiatedBy: 1 }, { unique: true });
RestoreRecordSchema.index({ targetTenantId: 1, createdAt: -1 });
export default mongoose.model('RestoreRecord', RestoreRecordSchema);
