import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

const BackupScheduleSchema = new mongoose.Schema({
  uniqueId: { type: String, default: () => `SCH-${randomUUID()}`, unique: true, index: true },
  name: { type: String, required: true, trim: true }, description: { type: String, default: '', trim: true },
  scopeType: { type: String, enum: ['PLATFORM', 'TENANT', 'SUB_TENANT', 'EXAM'], required: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true }, subTenantId: { type: mongoose.Schema.Types.ObjectId, default: null }, examId: { type: mongoose.Schema.Types.ObjectId, default: null },
  backupType: { type: String, enum: ['FULL_PLATFORM', 'TENANT', 'INCREMENTAL', 'METADATA_ONLY', 'EXAM'], required: true },
  frequency: { type: String, enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'], required: true }, cronExpression: { type: String, required: true }, timezone: { type: String, default: 'Asia/Kolkata' }, enabled: { type: Boolean, default: true },
  retentionPolicy: { type: mongoose.Schema.Types.Mixed, default: { mode: 'DAYS', days: 30 } }, storageClass: { type: String, default: 'STANDARD' }, verificationLevel: { type: String, enum: ['BASIC', 'STANDARD', 'DEEP'], default: 'STANDARD' }, encryptionProfile: { type: String, default: 'DEFAULT' },
  includeCollections: { type: [String], default: [] }, excludeCollections: { type: [String], default: [] }, fullBackupFrequency: { type: String, default: '' }, incrementalBackupFrequency: { type: String, default: '' },
  lastRunAt: Date, lastRunStatus: { type: String, default: '' }, nextRunAt: Date, consecutiveFailureCount: { type: Number, default: 0 }, notificationConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, collection: 'backup_schedules' });
BackupScheduleSchema.index({ enabled: 1, nextRunAt: 1 });
export default mongoose.model('BackupSchedule', BackupScheduleSchema);
