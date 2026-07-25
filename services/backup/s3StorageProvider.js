import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getBackupConfiguration } from './backupConfiguration.js';

const getClient = () => {
  const config = getBackupConfiguration();
  return new S3Client({ region: config.region, endpoint: config.endpoint || undefined, forcePathStyle: config.forcePathStyle });
};
export const uploadBackupObject = async ({ key, body, contentType = 'application/octet-stream', storageClass, metadata = {} }) => {
  const config = getBackupConfiguration();
  const result = await getClient().send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType, StorageClass: storageClass || config.defaultStorageClass, ServerSideEncryption: config.kmsKeyId ? 'aws:kms' : 'AES256', SSEKMSKeyId: config.kmsKeyId || undefined, Metadata: metadata }));
  return { bucket: config.bucket, key, eTag: String(result.ETag || '').replaceAll('"', ''), versionId: result.VersionId || '' };
};
export const getBackupObject = ({ key }) => getClient().send(new GetObjectCommand({ Bucket: getBackupConfiguration().bucket, Key: key }));
export const headBackupObject = ({ key }) => getClient().send(new HeadObjectCommand({ Bucket: getBackupConfiguration().bucket, Key: key }));
export const deleteBackupObject = ({ key }) => getClient().send(new DeleteObjectCommand({ Bucket: getBackupConfiguration().bucket, Key: key }));
export const getBackupDownloadUrl = ({ key, filename }) => {
  const config = getBackupConfiguration();
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: config.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${String(filename || 'backup.enc').replace(/[^a-zA-Z0-9._-]/g, '_')}"` }), { expiresIn: config.signedUrlExpirySeconds });
};
export const checkStorageHealth = async () => {
  const config = getBackupConfiguration();
  await getClient().send(new HeadObjectCommand({ Bucket: config.bucket, Key: '__xamigo_healthcheck__' })).catch((error) => { if (error?.$metadata?.httpStatusCode !== 404) throw error; });
  return { healthy: true, provider: 's3', bucket: config.bucket, region: config.region };
};
