import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { getBackupConfiguration } from './backupConfiguration.js';

const getKmsClient = () => {
  const config = getBackupConfiguration(); return new KMSClient({ region: config.region, endpoint: config.endpoint || undefined });
};
const toBuffer = (streamOrBuffer) => Buffer.isBuffer(streamOrBuffer) ? streamOrBuffer : Buffer.from(streamOrBuffer);
export const encryptBackupPayload = async (payload, backupId) => {
  const config = getBackupConfiguration(); const plain = toBuffer(payload);
  if (!config.applicationEncryptionEnabled) return { encrypted: plain, metadata: { encryptionMode: 'NONE' } };
  const dataKey = randomBytes(32); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', dataKey, iv); const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const wrapped = await getKmsClient().send(new EncryptCommand({ KeyId: config.kmsKeyId, Plaintext: dataKey, EncryptionContext: { purpose: 'xamigo-backup', backupId: String(backupId) } }));
  return { encrypted, metadata: { encryptionMode: 'AES_256_GCM_KMS', kmsKeyId: config.kmsKeyId, encryptedDataKey: Buffer.from(wrapped.CiphertextBlob).toString('base64'), encryptionIv: iv.toString('base64'), encryptionAuthTag: cipher.getAuthTag().toString('base64') } };
};
export const decryptBackupPayload = async (encryptedPayload, metadata, backupId) => {
  if (metadata?.encryptionMode === 'NONE') return toBuffer(encryptedPayload);
  const decryptedKey = await getKmsClient().send(new DecryptCommand({ CiphertextBlob: Buffer.from(metadata.encryptedDataKey, 'base64'), EncryptionContext: { purpose: 'xamigo-backup', backupId: String(backupId) } }));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(decryptedKey.Plaintext), Buffer.from(metadata.encryptionIv, 'base64')); decipher.setAuthTag(Buffer.from(metadata.encryptionAuthTag, 'base64'));
  return Buffer.concat([decipher.update(toBuffer(encryptedPayload)), decipher.final()]);
};
