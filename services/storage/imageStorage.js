/**
 * S3-backed image storage, namespaced per tenant/exam:
 *   xamigo/tenant-{tenantId}/exams/exam-{examId}/{category}/{filename}   (exam-scoped)
 *   xamigo/tenant-{tenantId}/{category}/{filename}                      (tenant-scoped)
 *
 * Public URLs stay `/uploads/...` (the hierarchy lives inside that path) so
 * existing DB records and callers that only deal in `/uploads/...` strings
 * don't need to change — see urlToKey/keyToUrl for the bijection.
 *
 * The only file (besides the separate, DB-configured
 * services/backup/s3StorageProvider.js) that imports @aws-sdk/client-s3 for
 * image storage.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../config/env.js';

const ROOT_PREFIX = config.s3ImageRootPrefix || 'xamigo';
// Deliberately a DIFFERENT root prefix from ROOT_PREFIX above. server.js's
// `/uploads/*` proxy is unauthenticated by design (question/certificate
// images are meant to be publicly fetchable) and resolves ANY key under
// ROOT_PREFIX via urlToKey — there is no per-category access check. Answer
// scripts (Master Phase 4) are candidate academic records and must never
// be reachable through that public path, so they live under this separate
// prefix and are only ever handed out via a short-lived presigned URL from
// an authenticated, tenant-checked route — see getPrivateSignedUrl below
// and routes/answerScripts.js.
const PRIVATE_ROOT_PREFIX = `${ROOT_PREFIX}-private`;

export const isS3Configured = () =>
  Boolean(config.s3Bucket && config.s3Region && config.s3AccessKeyId && config.s3SecretAccessKey);

export const assertS3Configured = () => {
  if (isS3Configured()) return;
  const missing = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter(
    (key) => !process.env[key]
  );
  const error = new Error(
    `Image storage is not configured. Set ${missing.join(', ')} before uploading or generating images.`
  );
  error.statusCode = 503;
  error.code = 'S3_NOT_CONFIGURED';
  throw error;
};

let cachedClient = null;
const getClient = () => {
  assertS3Configured();
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: config.s3Region,
      endpoint: config.s3Endpoint || undefined,
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
    });
  }
  return cachedClient;
};

const sanitizeSegment = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'misc';

/**
 * Pure string logic — no S3 calls, no credentials required. Safe to use
 * anywhere (including server.js's read proxy and unit tests) regardless of
 * whether S3 is configured.
 */
export const buildImageLocation = ({ tenantId, examId, category, subpath = [], filename }) => {
  const segments = [
    `tenant-${sanitizeSegment(tenantId)}`,
    ...(examId ? ['exams', `exam-${sanitizeSegment(examId)}`] : []),
    sanitizeSegment(category || 'misc'),
    ...(Array.isArray(subpath) ? subpath : [subpath]).filter(Boolean).map(sanitizeSegment),
    sanitizeSegment(filename),
  ];
  return {
    key: [ROOT_PREFIX, ...segments].join('/'),
    url: `/uploads/${segments.join('/')}`,
  };
};

export const urlToKey = (url) => {
  const pathOnly = String(url || '').split('?')[0];
  return pathOnly.startsWith('/uploads/') ? `${ROOT_PREFIX}/${pathOnly.slice('/uploads/'.length)}` : '';
};

export const keyToUrl = (key) => {
  const normalized = String(key || '');
  return normalized.startsWith(`${ROOT_PREFIX}/`)
    ? `/uploads/${normalized.slice(ROOT_PREFIX.length + 1)}`
    : '';
};

const CONTENT_TYPE_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
const contentTypeFor = (ext) => CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';

export const putImage = async ({ tenantId, examId, category, subpath, fileStem = 'image', extension, buffer }) => {
  assertS3Configured();
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  const ext = extension && extension.startsWith('.') ? extension : `.${extension || 'png'}`;
  const filename = `${sanitizeSegment(fileStem)}-${Date.now()}${Math.random().toString(36).slice(2, 6)}${ext}`;
  const { key, url } = buildImageLocation({ tenantId, examId, category, subpath, filename });

  await getClient().send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentTypeFor(ext),
    })
  );

  return { key, url };
};

export const getImageBuffer = async ({ key, url } = {}) => {
  const resolvedKey = key || urlToKey(url);
  if (!resolvedKey) return null;
  const result = await getClient().send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: resolvedKey }));
  return Buffer.from(await result.Body.transformToByteArray());
};

export const getImageStream = async ({ key, url } = {}) => {
  const resolvedKey = key || urlToKey(url);
  if (!resolvedKey) return null;
  return getClient().send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: resolvedKey }));
};

export const imageExists = async ({ key, url } = {}) => {
  const resolvedKey = key || urlToKey(url);
  if (!resolvedKey) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: resolvedKey }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
};

export const deleteImage = async ({ key, url } = {}) => {
  const resolvedKey = key || urlToKey(url);
  if (!resolvedKey) return;
  await getClient().send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: resolvedKey }));
};

// ---------------------------------------------------------------------
// Private object storage (Master Phase 4 — answer scripts). Same bucket/
// credentials, different (unpublished) key prefix; never returns a public
// `/uploads/...` URL. Callers must go through routes/answerScripts.js's
// authenticated, tenant-checked access, which calls getPrivateSignedUrl.
// ---------------------------------------------------------------------

export const buildPrivateObjectLocation = ({ tenantId, category, subpath = [], filename }) => {
  const segments = [
    `tenant-${sanitizeSegment(tenantId)}`,
    sanitizeSegment(category || 'misc'),
    ...(Array.isArray(subpath) ? subpath : [subpath]).filter(Boolean).map(sanitizeSegment),
    sanitizeSegment(filename),
  ];
  return { key: [PRIVATE_ROOT_PREFIX, ...segments].join('/') };
};

export const putPrivateObject = async ({ tenantId, category, subpath, fileStem = 'file', extension, buffer, contentType }) => {
  assertS3Configured();
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  const ext = extension && extension.startsWith('.') ? extension : `.${extension || 'bin'}`;
  const filename = `${sanitizeSegment(fileStem)}-${Date.now()}${Math.random().toString(36).slice(2, 8)}${ext}`;
  const { key } = buildPrivateObjectLocation({ tenantId, category, subpath, filename });

  await getClient().send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || contentTypeFor(ext),
    })
  );

  return { key };
};

export const getPrivateObjectBuffer = async ({ key }) => {
  if (!key) return null;
  const result = await getClient().send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
};

export const deletePrivateObject = async ({ key }) => {
  if (!key) return;
  await getClient().send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
};

// Short-lived (default 5 min) presigned GET URL — Part D/X's "signed/
// private object URLs where available." Generating it requires no network
// call itself (pure request-signing), so it's cheap to call per-view.
export const getPrivateSignedUrl = async ({ key, expiresInSeconds = 300 }) => {
  assertS3Configured();
  if (!key) return null;
  const command = new GetObjectCommand({ Bucket: config.s3Bucket, Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
};

// Direct private upload primitives. These deliberately expose only signed
// operations for a server-generated tenant key; callers never choose an S3
// key or receive credentials/public URLs.
export const getPrivateUploadUrl = async ({ key, contentType, expiresInSeconds = 900 }) => {
  assertS3Configured();
  if (!key) throw new Error('A private object key is required.');
  const command = new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
};

export const createPrivateMultipartUpload = async ({ key, contentType }) => {
  assertS3Configured();
  if (!key) throw new Error('A private object key is required.');
  const result = await getClient().send(new CreateMultipartUploadCommand({
    Bucket: config.s3Bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { uploadId: result.UploadId };
};

export const getPrivateMultipartPartUrl = async ({ key, uploadId, partNumber, expiresInSeconds = 900 }) => {
  assertS3Configured();
  if (!key || !uploadId || !Number.isInteger(Number(partNumber))) {
    throw new Error('key, uploadId, and partNumber are required.');
  }
  const command = new UploadPartCommand({
    Bucket: config.s3Bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: Number(partNumber),
  });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
};

export const completePrivateMultipartUpload = async ({ key, uploadId, parts }) => {
  assertS3Configured();
  const normalizedParts = (parts || [])
    .map((part) => ({ ETag: String(part.etag || part.ETag || '').trim(), PartNumber: Number(part.partNumber || part.PartNumber) }))
    .filter((part) => part.ETag && Number.isInteger(part.PartNumber) && part.PartNumber > 0)
    .sort((a, b) => a.PartNumber - b.PartNumber);
  if (!key || !uploadId || !normalizedParts.length) throw new Error('A completed multipart upload requires its key, upload id, and uploaded parts.');
  return getClient().send(new CompleteMultipartUploadCommand({
    Bucket: config.s3Bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: normalizedParts },
  }));
};

export const abortPrivateMultipartUpload = async ({ key, uploadId }) => {
  if (!key || !uploadId) return;
  await getClient().send(new AbortMultipartUploadCommand({
    Bucket: config.s3Bucket,
    Key: key,
    UploadId: uploadId,
  }));
};

export const headPrivateObject = async ({ key }) => {
  assertS3Configured();
  if (!key) return null;
  const result = await getClient().send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  return {
    sizeBytes: Number(result.ContentLength || 0),
    contentType: result.ContentType || '',
    etag: String(result.ETag || '').replace(/^"|"$/g, ''),
    lastModified: result.LastModified || null,
    storageClass: result.StorageClass || 'STANDARD',
  };
};

// S3 has no atomic rename — copy to the destination key, then delete the source.
export const moveImage = async ({ sourceUrl, destinationUrl }) => {
  const sourceKey = urlToKey(sourceUrl);
  const destinationKey = urlToKey(destinationUrl);
  if (!sourceKey || !destinationKey) return null;
  if (sourceKey === destinationKey) return { key: destinationKey, url: keyToUrl(destinationKey) };

  await getClient().send(
    new CopyObjectCommand({
      Bucket: config.s3Bucket,
      Key: destinationKey,
      CopySource: `${config.s3Bucket}/${sourceKey}`,
    })
  );
  await deleteImage({ key: sourceKey });
  return { key: destinationKey, url: keyToUrl(destinationKey) };
};
