/**
 * Copies, never moves or deletes, legacy local backup artifacts to private S3.
 * Run only after inventory review: CONFIRM_LEGACY_BACKUP_MIGRATION=true npm run backup:migrate-legacy
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from '../utils/db.js';
import BackupHistory from '../models/BackupHistory.js';
import BackupRecord from '../models/BackupRecord.js';
import { assertBackupConfiguration, getBackupConfiguration, refreshBackupConfiguration } from '../services/backup/backupConfiguration.js';
import { uploadBackupObject } from '../services/backup/s3StorageProvider.js';

if (process.env.CONFIRM_LEGACY_BACKUP_MIGRATION !== 'true') throw new Error('Set CONFIRM_LEGACY_BACKUP_MIGRATION=true after reviewing the migration inventory.');
await connect(); await refreshBackupConfiguration(); assertBackupConfiguration();
const config = getBackupConfiguration(); const records = await BackupHistory.find({}).lean(); let copied = 0; let skipped = 0;
for (const legacy of records) {
  const filePath = legacy.file_path || legacy.storage_path; if (!filePath || !legacy.created_by) { skipped += 1; continue; }
  let contents; try { contents = await fs.readFile(filePath); } catch { skipped += 1; continue; }
  const existing = await BackupRecord.findOne({ 'metadata.legacyHistoryId': String(legacy._id) }); if (existing) { skipped += 1; continue; }
  const backup = await BackupRecord.create({ backupType: legacy.type === 'full_system' ? 'FULL_PLATFORM' : 'TENANT', scopeType: legacy.type === 'full_system' ? 'PLATFORM' : 'TENANT', tenantId: legacy.company_id || null, name: legacy.backup_name, status: 'LEGACY_UNVERIFIED', verificationStatus: 'SKIPPED', verificationLevel: 'BASIC', initiatedBy: legacy.created_by, initiatedByRole: 'LEGACY', idempotencyKey: `legacy-${legacy._id}`, s3StorageClass: config.defaultStorageClass, checksum: createHash('sha256').update(contents).digest('hex'), compressedSizeBytes: contents.length, metadata: { legacyHistoryId: String(legacy._id), legacyFilePath: filePath, migrationNote: 'Copied unchanged; application-encryption and manifest verification were not available for this legacy artifact.' } });
  const key = `${config.objectPrefix}/${config.environment}/legacy/${String(legacy._id)}/${backup.uniqueId}.zip`; const upload = await uploadBackupObject({ key, body: contents, contentType: 'application/zip', metadata: { legacyhistoryid: String(legacy._id), checksum: backup.checksum } }); await backup.updateOne({ $set: { s3Provider: 's3', s3Bucket: upload.bucket, s3Region: config.region, s3ObjectKey: key, s3ETag: upload.eTag, s3VersionId: upload.versionId } }); copied += 1;
}
console.log(JSON.stringify({ copied, skipped, sourceRecords: records.length }, null, 2));
