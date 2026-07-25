import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

export const BACKUP_STATUSES = [
  'QUEUED', 'PREPARING', 'EXPORTING', 'COMPRESSING', 'ENCRYPTING', 'UPLOADING',
  'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DELETING', 'DELETED',
  'LEGACY_UNVERIFIED',
];

const BackupRecordSchema = new mongoose.Schema({
  uniqueId: { type: String, default: () => `BKP-${randomUUID()}`, unique: true, index: true },
  backupType: { type: String, enum: ['FULL_PLATFORM', 'TENANT', 'SUB_TENANT', 'INCREMENTAL', 'METADATA_ONLY', 'EXAM'], required: true, index: true },
  scopeType: { type: String, enum: ['PLATFORM', 'TENANT', 'SUB_TENANT', 'EXAM'], required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  subTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubTenant', default: null, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null, index: true },
  name: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, default: '' },
  status: { type: String, enum: BACKUP_STATUSES, default: 'QUEUED', index: true },
  verificationStatus: { type: String, enum: ['PENDING', 'PASSED', 'FAILED', 'SKIPPED'], default: 'PENDING' },
  verificationLevel: { type: String, enum: ['BASIC', 'STANDARD', 'DEEP'], default: 'STANDARD' },
  jobId: { type: String, unique: true, sparse: true, index: true },
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupSchedule', default: null },
  triggerType: { type: String, enum: ['MANUAL', 'SCHEDULED', 'PRE_RESTORE'], default: 'MANUAL' },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  initiatedByRole: { type: String, required: true }, requestId: { type: String, default: '', index: true },
  idempotencyKey: { type: String, required: true, index: true },
  s3Provider: { type: String, default: 's3' }, s3Bucket: { type: String, default: '' },
  s3Region: { type: String, default: '' }, s3ObjectKey: { type: String, default: '' },
  s3StorageClass: { type: String, default: 'STANDARD' }, s3VersionId: { type: String, default: '' }, s3ETag: { type: String, default: '' },
  encryptionMode: { type: String, enum: ['NONE', 'AES_256_GCM_KMS'], default: 'AES_256_GCM_KMS' },
  kmsKeyId: { type: String, default: '' }, encryptedDataKey: { type: String, default: '' },
  encryptionIv: { type: String, default: '' }, encryptionAuthTag: { type: String, default: '' },
  checksumAlgorithm: { type: String, default: 'SHA-256' }, checksum: { type: String, default: '' },
  applicationVersion: { type: String, default: '' }, schemaVersion: { type: String, default: '1' }, migrationVersion: { type: String, default: '' }, databaseName: { type: String, default: '' },
  collectionsIncluded: { type: [String], default: [] }, collectionsExcluded: { type: [String], default: [] },
  recordCounts: { type: Map, of: Number, default: {} }, totalRecords: { type: Number, default: 0 },
  uncompressedSizeBytes: { type: Number, default: 0 }, compressedSizeBytes: { type: Number, default: 0 },
  baseBackupId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null }, previousIncrementalBackupId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null },
  incrementalFrom: { type: Date, default: null }, incrementalTo: { type: Date, default: null },
  retentionPolicySnapshot: { type: mongoose.Schema.Types.Mixed, default: {} }, metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  startedAt: Date, completedAt: Date, verifiedAt: Date, expiresAt: { type: Date, default: null, index: true }, deletedAt: Date,
  failureCode: { type: String, default: '' }, failureMessage: { type: String, default: '' }, failureDetails: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'backup_records' });

BackupRecordSchema.index({ idempotencyKey: 1, initiatedBy: 1 }, { unique: true });
BackupRecordSchema.index({ tenantId: 1, createdAt: -1 });
BackupRecordSchema.index({ status: 1, expiresAt: 1 });
export default mongoose.model('BackupRecord', BackupRecordSchema);
