import BackupRecord from '../../models/BackupRecord.js';
import { deleteBackupObject } from './s3StorageProvider.js';
export const runBackupRetention = async () => {
  const expired = await BackupRecord.find({ status: { $in: ['COMPLETED', 'EXPIRED'] }, expiresAt: { $lte: new Date() }, deletedAt: null });
  const outcomes = [];
  for (const backup of expired) { try { await backup.updateOne({ $set: { status: 'DELETING' } }); if (backup.s3ObjectKey) await deleteBackupObject({ key: backup.s3ObjectKey }); if (backup.metadata?.manifestObjectKey) await deleteBackupObject({ key: backup.metadata.manifestObjectKey }); await backup.updateOne({ $set: { status: 'DELETED', deletedAt: new Date() } }); outcomes.push({ id: backup.uniqueId, deleted: true }); } catch (error) { await backup.updateOne({ $set: { status: 'EXPIRED', failureMessage: String(error.message || error).slice(0, 1000) } }); outcomes.push({ id: backup.uniqueId, deleted: false }); } }
  return outcomes;
};
