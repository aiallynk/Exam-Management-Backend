import { createHash } from 'node:crypto';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const createBackupManifest = ({ backup, collections, excludedCollections, recordCounts, uncompressedSizeBytes = 0, compressedSizeBytes = 0 }) => ({
  backupId: backup.uniqueId, backupType: backup.backupType, tenantId: backup.tenantId ? String(backup.tenantId) : null, subTenantId: backup.subTenantId ? String(backup.subTenantId) : null, examId: backup.examId ? String(backup.examId) : null,
  createdAt: backup.createdAt?.toISOString() || new Date().toISOString(), completedAt: new Date().toISOString(), applicationVersion: process.env.npm_package_version || '1.0.0', schemaVersion: backup.schemaVersion || '1', databaseName: backup.databaseName || '', mongoVersion: '', collections, excludedCollections, recordCounts, uncompressedSizeBytes, compressedSizeBytes, checksumAlgorithm: 'SHA-256', encryptionAlgorithm: backup.encryptionMode === 'NONE' ? 'NONE' : 'AES-256-GCM', baseBackupId: backup.baseBackupId ? String(backup.baseBackupId) : null, previousIncrementalBackupId: backup.previousIncrementalBackupId ? String(backup.previousIncrementalBackupId) : null,
});
