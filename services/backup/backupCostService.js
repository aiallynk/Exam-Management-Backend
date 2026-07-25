import BackupRecord from '../../models/BackupRecord.js';
import { getBackupConfiguration } from './backupConfiguration.js';

const BYTES_PER_GB = 1024 ** 3;
export const getBackupCostSummary = async ({ tenantId = null } = {}) => {
  const filter = { status: 'COMPLETED', deletedAt: null, ...(tenantId ? { tenantId } : {}) };
  const rows = await BackupRecord.aggregate([{ $match: filter }, { $group: { _id: '$s3StorageClass', bytes: { $sum: '$compressedSizeBytes' }, count: { $sum: 1 } } }]);
  const standardRate = getBackupConfiguration().storageRatePerGbMonth; const totalBytes = rows.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  return { currency: getBackupConfiguration().currency, retainedBytes: totalBytes, retainedGigabytes: Number((totalBytes / BYTES_PER_GB).toFixed(4)), backupCount: rows.reduce((sum, row) => sum + row.count, 0), estimatedMonthlyStorageCost: Number(((totalBytes / BYTES_PER_GB) * standardRate).toFixed(2)), byStorageClass: rows.map((row) => ({ storageClass: row._id || 'STANDARD', bytes: row.bytes, count: row.count })) };
};
