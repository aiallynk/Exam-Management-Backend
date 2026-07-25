import { createHash } from 'node:crypto';
import { getBackupObject, headBackupObject } from './s3StorageProvider.js';

const bodyBuffer = async (body) => Buffer.from(await body.transformToByteArray());
export const verifyBackupObject = async ({ backup, level = 'STANDARD' }) => {
  const head = await headBackupObject({ key: backup.s3ObjectKey });
  if (Number(head.ContentLength || 0) <= 0) throw new Error('Backup object is empty or unavailable.');
  const result = { contentLength: Number(head.ContentLength), eTag: String(head.ETag || '').replaceAll('"', ''), level };
  if (level !== 'BASIC') { const object = await getBackupObject({ key: backup.s3ObjectKey }); const body = await bodyBuffer(object.Body); const checksum = createHash('sha256').update(body).digest('hex'); if (checksum !== backup.checksum) throw new Error('Backup checksum verification failed.'); result.checksum = checksum; }
  return result;
};
