import { randomUUID } from 'node:crypto';
import BackupRecord from '../../models/BackupRecord.js';
import { assertBackupConfiguration, refreshBackupConfiguration } from './backupConfiguration.js';
import { enqueue, QUEUES } from './backupQueueService.js';
import { logAuditEvent } from '../../utils/auditLogger.js';

const allowedTypes = new Set(['FULL_PLATFORM', 'TENANT', 'SUB_TENANT', 'INCREMENTAL', 'METADATA_ONLY', 'EXAM']);
const computeExpiry = (policy) => { const days = Number(policy?.days); return Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400000) : null; };
export const requestBackup = async ({ actor, request = {}, context = {} }) => {
  await refreshBackupConfiguration(); assertBackupConfiguration(); const backupType = String(request.backupType || '').toUpperCase(); const scopeType = String(request.scopeType || '').toUpperCase();
  if (!allowedTypes.has(backupType)) throw Object.assign(new Error('Invalid backupType.'), { statusCode: 400 });
  // These need scope-specific relationship remapping/change-stream handling. Do not
  // silently produce a broader full tenant export while presenting it as a narrower one.
  if (['SUB_TENANT', 'EXAM', 'INCREMENTAL'].includes(backupType)) throw Object.assign(new Error(`${backupType} backups are not enabled until their dependency graph/change-stream migration is deployed.`), { statusCode: 501, code: 'BACKUP_TYPE_NOT_ENABLED' });
  const isPlatform = scopeType === 'PLATFORM'; if (isPlatform && actor.role !== 'SUPER_ADMIN') throw Object.assign(new Error('Only Super Admin can create a platform backup.'), { statusCode: 403 });
  const tenantId = isPlatform ? null : (actor.role === 'TENANT_ADMIN' ? actor.tenantId : request.tenantId); if (!isPlatform && !tenantId) throw Object.assign(new Error('A tenant backup requires a tenantId.'), { statusCode: 400 });
  if (actor.role === 'TENANT_ADMIN' && String(request.tenantId || actor.tenantId) !== String(actor.tenantId)) throw Object.assign(new Error('Tenant Admin cannot create a backup for another tenant.'), { statusCode: 403 });
  const idempotencyKey = String(context.idempotencyKey || request.idempotencyKey || randomUUID()).trim();
  const existing = await BackupRecord.findOne({ initiatedBy: actor._id, idempotencyKey }); if (existing) return { backup: existing, replayed: true };
  const backup = await BackupRecord.create({ backupType, scopeType, tenantId, subTenantId: request.subTenantId || null, examId: request.examId || null, name: String(request.name || '').slice(0, 200), description: String(request.description || '').slice(0, 2000), verificationLevel: String(request.verificationLevel || 'STANDARD').toUpperCase(), s3StorageClass: String(request.storageClass || 'STANDARD'), scheduleId: request.scheduleId || null, initiatedBy: actor._id, initiatedByRole: actor.role, requestId: context.requestId || '', idempotencyKey, expiresAt: computeExpiry(request.retentionPolicy), retentionPolicySnapshot: request.retentionPolicy || {}, metadata: { includeCollections: request.includeCollections || [], excludeCollections: request.excludeCollections || [], actorIp: context.ip || '', userAgent: context.userAgent || '' } });
  const queue = isPlatform ? QUEUES.PLATFORM : backupType === 'INCREMENTAL' ? QUEUES.INCREMENTAL : QUEUES.TENANT; const jobId = `backup-${backup._id}`;
  try { await enqueue({ queue, jobName: 'execute-backup', jobId, data: { backupId: String(backup._id) } }); await backup.updateOne({ $set: { jobId } }); backup.jobId = jobId; } catch (error) { await backup.updateOne({ $set: { status: 'FAILED', failureCode: 'QUEUE_ENQUEUE_FAILED', failureMessage: String(error.message || error).slice(0, 1000) } }); throw error; }
  logAuditEvent('BACKUP_REQUESTED', { userId: actor._id, userRole: actor.role, tenantId, resourceType: 'BackupRecord', resourceId: backup._id, ip: context.ip, userAgent: context.userAgent, method: context.method, path: context.path, requestId: context.requestId, backupId: backup.uniqueId, jobId });
  return { backup, replayed: false };
};
