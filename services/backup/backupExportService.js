import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import archiver from 'archiver';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import { createBackupManifest, sha256 } from './backupManifestService.js';

const SECRET_KEY = /password|secret|token|api.?key|credential|smtp|private.?key/i;
// Queue state and operation records must remain live while a worker runs. Legacy
// backup_history is still included for audit continuity; these operational records are not.
const NEVER_EXPORT = new Set(['sessions', 'system.jobs', 'backup_records', 'restore_records', 'restore_approvals', 'backup_schedules', 'backup_storage_configurations', 'bull:backup-platform:wait', 'bull:restore-execution:wait']);
const METADATA_EXCLUDED = new Set(['answers', 'submissions', 'examattempts', 'omrresults', 'proctoringevidence']);
const asObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || '')) ? new mongoose.Types.ObjectId(String(value)) : null;
const ids = async (db, collection, filter) => (await db.listCollections({ name: collection }).toArray()).length ? db.collection(collection).distinct('_id', filter) : [];
const existing = async (db, name) => (await db.listCollections({ name }).toArray()).length > 0;
const filterOrNone = (field, values) => values?.length ? { [field]: { $in: values } } : { _id: { $in: [] } };

export const buildTenantDependencyGraph = async ({ db, tenantId }) => {
  const tenantObjectId = asObjectId(tenantId); if (!tenantObjectId) throw new Error('A valid tenantId is required.');
  const examIds = await ids(db, 'exams', { tenantId: tenantObjectId });
  const userIds = await ids(db, 'users', { tenantId: tenantObjectId });
  const paperIds = await ids(db, 'questionpapers', filterOrNone('examId', examIds));
  const sessionIds = await ids(db, 'examsessions', { $or: [{ tenantId: tenantObjectId }, filterOrNone('examId', examIds)] });
  const attemptIds = await ids(db, 'examattempts', { $or: [{ tenantId: tenantObjectId }, filterOrNone('examId', examIds), filterOrNone('sessionId', sessionIds)] });
  return { tenantObjectId, examIds, userIds, paperIds, sessionIds, attemptIds };
};

const tenantFilterFor = (name, graph) => {
  const byTenant = { tenantId: graph.tenantObjectId };
  if (name === 'tenants') return { _id: graph.tenantObjectId };
  if (name === 'users' || name === 'subtenants' || name === 'notifications' || name === 'notificationsettings' || name === 'creditrequests' || name === 'auditlogs' || name === 'ai_token_usage' || name === 'tenantfeaturebillings') return byTenant;
  if (name === 'exams') return filterOrNone('_id', graph.examIds);
  if (['questionpapers', 'examsessions', 'examparticipants', 'answerkeys', 'normalizationconfigs', 'exampackages', 'omrresults'].includes(name)) return { $or: [byTenant, filterOrNone('examId', graph.examIds)] };
  if (['questions', 'sections'].includes(name)) return { $or: [byTenant, filterOrNone('examId', graph.examIds), filterOrNone('questionPaperId', graph.paperIds), filterOrNone('paperId', graph.paperIds)] };
  if (name === 'sessionassignments') return { $or: [byTenant, filterOrNone('sessionId', graph.sessionIds), filterOrNone('examId', graph.examIds)] };
  if (name === 'examattempts') return filterOrNone('_id', graph.attemptIds);
  if (name === 'answers' || name === 'submissions') return { $or: [byTenant, filterOrNone('attemptId', graph.attemptIds), filterOrNone('examId', graph.examIds)] };
  return byTenant;
};

const redact = (value, key = '') => {
  if (SECRET_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => redact(entry)).filter((entry) => entry !== undefined);
  if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => { const safe = redact(childValue, childKey); return safe === undefined ? [] : [[childKey, safe]]; }));
};
const writeCollection = async ({ db, name, filter, outputPath }) => {
  const writer = fsSync.createWriteStream(outputPath, { encoding: 'utf8' }); let count = 0; let bytes = 0;
  try { for await (const document of db.collection(name).find(filter)) { const line = `${EJSON.stringify(redact(document), { relaxed: false })}\n`; bytes += Buffer.byteLength(line); if (!writer.write(line)) await once(writer, 'drain'); count += 1; } writer.end(); await once(writer, 'finish'); return { count, bytes, checksum: sha256(await fs.readFile(outputPath)) }; } catch (error) { writer.destroy(); throw error; }
};
const createArchive = async ({ sourceDir, targetPath }) => new Promise((resolve, reject) => { const output = fsSync.createWriteStream(targetPath); const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } }); output.on('close', resolve); output.on('error', reject); archive.on('error', reject); archive.pipe(output); archive.directory(sourceDir, false); archive.finalize(); });

export const exportBackupPackage = async ({ backup, onProgress = async () => {} }) => {
  const db = mongoose.connection.db; if (!db) throw new Error('Database connection is not available.');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `xamigo-${backup.uniqueId}-`)); const collectionDir = path.join(workspace, 'collections'); await fs.mkdir(collectionDir); await fs.mkdir(path.join(workspace, 'checksums'));
  try {
    const all = (await db.listCollections().toArray()).map(({ name }) => name).filter((name) => !NEVER_EXPORT.has(name));
    const includeRequested = Array.isArray(backup.metadata?.includeCollections) ? backup.metadata.includeCollections : [];
    const excludeRequested = new Set([...(backup.metadata?.excludeCollections || []), ...(backup.backupType === 'METADATA_ONLY' ? METADATA_EXCLUDED : [])]);
    const selected = all.filter((name) => (!includeRequested.length || includeRequested.includes(name)) && !excludeRequested.has(name));
    const graph = backup.scopeType === 'PLATFORM' ? null : await buildTenantDependencyGraph({ db, tenantId: backup.tenantId });
    const counts = {}; const checksums = {}; let uncompressedSizeBytes = 0;
    for (let index = 0; index < selected.length; index += 1) { const name = selected[index]; await onProgress(Math.round(10 + (index / Math.max(selected.length, 1)) * 55), `Exporting ${name}`); const item = await writeCollection({ db, name, filter: graph ? tenantFilterFor(name, graph) : {}, outputPath: path.join(collectionDir, `${name}.jsonl`) }); counts[name] = item.count; checksums[`collections/${name}.jsonl`] = item.checksum; uncompressedSizeBytes += item.bytes; }
    const manifest = createBackupManifest({ backup, collections: selected, excludedCollections: all.filter((name) => !selected.includes(name)), recordCounts: counts, uncompressedSizeBytes });
    await fs.writeFile(path.join(workspace, 'manifest.json'), JSON.stringify(manifest, null, 2)); await fs.writeFile(path.join(workspace, 'schema-version.json'), JSON.stringify({ schemaVersion: manifest.schemaVersion }, null, 2)); await fs.writeFile(path.join(workspace, 'checksums', 'sha256.json'), JSON.stringify(checksums, null, 2));
    const archivePath = path.join(workspace, 'backup.tar.gz'); await onProgress(70, 'Compressing backup package'); await createArchive({ sourceDir: workspace, targetPath: archivePath }); const stat = await fs.stat(archivePath);
    return { workspace, archivePath, manifest, recordCounts: counts, uncompressedSizeBytes, compressedSizeBytes: stat.size };
  } catch (error) { await fs.rm(workspace, { recursive: true, force: true }); throw error; }
};
