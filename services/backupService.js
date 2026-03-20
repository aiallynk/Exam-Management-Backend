import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import unzipper from 'unzipper';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import Tenant from '../models/Tenant.js';
import BackupHistory from '../models/BackupHistory.js';

const BACKUP_ROOT_DIR = path.resolve(
  process.cwd(),
  process.env.BACKUP_STORAGE_DIR || 'backups'
);
const BACKUP_DIRS = {
  full_system: path.join(BACKUP_ROOT_DIR, 'full_system'),
  company: path.join(BACKUP_ROOT_DIR, 'company'),
  tenant: path.join(BACKUP_ROOT_DIR, 'tenants'),
  pre_restore: path.join(BACKUP_ROOT_DIR, 'pre_restore'),
};
const TMP_DIR = path.join(BACKUP_ROOT_DIR, '.tmp');
const MATCH_NONE_FILTER = { _id: { $in: [] } };
const COMPANY_COLLECTION_ORDER = [
  'tenants',
  'users',
  'exams',
  'questionpapers',
  'sections',
  'questions',
  'answerkeys',
  'examsessions',
  'sessionassignments',
  'examparticipants',
  'examattempts',
  'answers',
  'submissions',
  'omrresults',
  'ai_token_usage',
  'normalizationconfigs',
  'exampackages',
];

const pad = (value) => String(value).padStart(2, '0');

const asObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
};

const sanitizeForFilename = (value) => {
  const raw = String(value || 'company')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return raw || 'company';
};

const createDateStamp = (date = new Date()) => {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}_${month}_${day}`;
};

const createDateTimeStamp = (date = new Date()) => {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
};

const createMinuteStamp = (date = new Date()) =>
  createDateTimeStamp(date).split('_').slice(0, 5).join('_');

const createBackupFilename = ({ scope, historyType, companyName }) => {
  if (historyType === 'pre_restore') {
    return `pre_restore_backup_${createDateTimeStamp()}.zip`;
  }

  if (historyType === 'tenant') {
    const safeName = sanitizeForFilename(companyName);
    return `tenant_backup_${safeName}_${createMinuteStamp()}.zip`;
  }

  if (scope === 'full_system') {
    const yearMonthDayHourMin = createMinuteStamp();
    return `full_backup_${yearMonthDayHourMin}.zip`;
  }

  const safeName = sanitizeForFilename(companyName);
  return `company_backup_${safeName}_${createDateStamp()}.zip`;
};

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const ensureStorageDirectories = async () => {
  await Promise.all(
    [BACKUP_ROOT_DIR, TMP_DIR, ...Object.values(BACKUP_DIRS)].map((dirPath) =>
      fs.mkdir(dirPath, { recursive: true })
    )
  );
};

const createUniqueFilePath = async (directoryPath, preferredFilename) => {
  const parsed = path.parse(preferredFilename);
  let candidate = path.join(directoryPath, preferredFilename);
  let iteration = 1;

  while (await fileExists(candidate)) {
    candidate = path.join(
      directoryPath,
      `${parsed.name}_${iteration}${parsed.ext || '.zip'}`
    );
    iteration += 1;
  }

  return candidate;
};

const toStorageUrlPath = (absolutePath) => {
  const normalizedAbsolute = path.resolve(absolutePath);
  const relativePath = path.relative(BACKUP_ROOT_DIR, normalizedAbsolute);
  return `/backups/${relativePath.split(path.sep).join('/')}`;
};

const safeRemovePath = async (targetPath) => {
  if (!targetPath) return;
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
};

const serializeFilter = (filter) => JSON.parse(EJSON.stringify(filter || {}, { relaxed: false }));

const inFilter = (field, ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return MATCH_NONE_FILTER;
  }
  return { [field]: { $in: ids } };
};

const orFilter = (filters) => {
  const validFilters = (Array.isArray(filters) ? filters : []).filter(Boolean);
  if (!validFilters.length) return MATCH_NONE_FILTER;
  if (validFilters.length === 1) return validFilters[0];
  return { $or: validFilters };
};

const exportCollectionAsJsonl = async ({ db, collectionName, filter, outputPath }) => {
  const collection = db.collection(collectionName);
  const writer = fsSync.createWriteStream(outputPath, { encoding: 'utf8' });
  let exportedCount = 0;

  try {
    const cursor = collection.find(filter || {});
    for await (const document of cursor) {
      const payload = `${EJSON.stringify(document, { relaxed: false })}\n`;
      if (!writer.write(payload)) {
        await once(writer, 'drain');
      }
      exportedCount += 1;
    }

    writer.end();
    await once(writer, 'finish');
    return exportedCount;
  } catch (error) {
    writer.destroy();
    throw error;
  }
};

const importCollectionFromJsonl = async ({ db, collectionName, inputPath }) => {
  if (!(await fileExists(inputPath))) return 0;

  const collection = db.collection(collectionName);
  const stream = fsSync.createReadStream(inputPath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const batch = [];
  const BATCH_SIZE = 500;
  let importedCount = 0;

  const flushBatch = async () => {
    if (!batch.length) return;
    const payload = batch.splice(0, batch.length);
    await collection.insertMany(payload, { ordered: false });
    importedCount += payload.length;
  };

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    batch.push(EJSON.parse(trimmed, { relaxed: false }));

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  await flushBatch();
  return importedCount;
};

const zipDirectory = async ({ sourceDirectory, targetZipPath }) =>
  new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(targetZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDirectory, false);
    archive.finalize();
  });

const extractZipArchive = async ({ zipPath, targetDirectory }) => {
  await fs.mkdir(targetDirectory, { recursive: true });
  await pipeline(
    fsSync.createReadStream(zipPath),
    unzipper.Extract({ path: targetDirectory })
  );
};

const getCurrentDb = () => {
  const db = mongoose.connection?.db;
  if (!db) {
    throw new Error('Database connection is not available.');
  }
  return db;
};

const buildCompanyScopeState = async ({ db, companyId }) => {
  const examsCollection = db.collection('exams');
  const examIds = await examsCollection.distinct('_id', { tenantId: companyId });

  const examSessionFilter = orFilter([
    { tenantId: companyId },
    examIds.length ? { examId: { $in: examIds } } : null,
  ]);
  const examSessionsCollection = db.collection('examsessions');
  const sessionIds = await examSessionsCollection.distinct('_id', examSessionFilter);

  const questionPapersCollection = db.collection('questionpapers');
  const questionPaperIds = examIds.length
    ? await questionPapersCollection.distinct('_id', { examId: { $in: examIds } })
    : [];

  const examAttemptFilter = orFilter([
    { tenantId: companyId },
    examIds.length ? { examId: { $in: examIds } } : null,
    sessionIds.length ? { sessionId: { $in: sessionIds } } : null,
  ]);
  const examAttemptsCollection = db.collection('examattempts');
  const attemptIds = await examAttemptsCollection.distinct('_id', examAttemptFilter);

  return {
    companyId,
    examIds,
    sessionIds,
    questionPaperIds,
    attemptIds,
    examSessionFilter,
    examAttemptFilter,
  };
};

const buildCompanyCollectionSpecs = async ({ db, companyId }) => {
  const scope = await buildCompanyScopeState({ db, companyId });

  return [
    { collection: 'tenants', filter: { _id: scope.companyId } },
    { collection: 'users', filter: { tenantId: scope.companyId } },
    { collection: 'exams', filter: { tenantId: scope.companyId } },
    { collection: 'questionpapers', filter: inFilter('examId', scope.examIds) },
    { collection: 'sections', filter: inFilter('questionPaperId', scope.questionPaperIds) },
    { collection: 'questions', filter: inFilter('questionPaperId', scope.questionPaperIds) },
    { collection: 'answerkeys', filter: inFilter('examId', scope.examIds) },
    { collection: 'examsessions', filter: scope.examSessionFilter },
    { collection: 'sessionassignments', filter: inFilter('sessionId', scope.sessionIds) },
    {
      collection: 'examparticipants',
      filter: orFilter([
        { tenantId: scope.companyId },
        scope.examIds.length ? { examId: { $in: scope.examIds } } : null,
      ]),
    },
    { collection: 'examattempts', filter: scope.examAttemptFilter },
    { collection: 'answers', filter: inFilter('attemptId', scope.attemptIds) },
    { collection: 'submissions', filter: inFilter('attemptId', scope.attemptIds) },
    {
      collection: 'omrresults',
      filter: orFilter([
        { tenant_id: scope.companyId },
        scope.examIds.length ? { exam_id: { $in: scope.examIds } } : null,
        scope.examIds.length ? { examId: { $in: scope.examIds } } : null,
      ]),
    },
    { collection: 'ai_token_usage', filter: { tenant_id: scope.companyId } },
    {
      collection: 'normalizationconfigs',
      filter: orFilter([
        { tenantId: scope.companyId },
        scope.examIds.length ? { examId: { $in: scope.examIds } } : null,
      ]),
    },
    {
      collection: 'exampackages',
      filter: orFilter([
        { tenantId: scope.companyId },
        scope.examIds.length ? { examId: { $in: scope.examIds } } : null,
      ]),
    },
  ];
};

const buildFullSystemCollectionSpecs = async ({ db }) => {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  return collections
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.'))
    .sort((left, right) => left.localeCompare(right))
    .map((collection) => ({ collection, filter: {} }));
};

const getCollectionSpecsForScope = async ({ db, scope, companyId }) => {
  if (scope === 'full_system') {
    return buildFullSystemCollectionSpecs({ db });
  }

  return buildCompanyCollectionSpecs({
    db,
    companyId: asObjectId(companyId),
  });
};

const createBackupManifest = ({
  scope,
  historyType,
  companyId,
  companyName,
  createdBy,
  collections,
}) => ({
  version: '1.0.0',
  type: historyType,
  scope_type: scope,
  company_id: companyId ? String(companyId) : null,
  company_name: companyName || null,
  created_at: new Date().toISOString(),
  created_by: createdBy ? String(createdBy) : null,
  hostname: os.hostname(),
  database: mongoose.connection?.db?.databaseName || '',
  collections,
});

const normalizeManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Backup metadata is missing or invalid.');
  }

  const scope = String(manifest.scope_type || '').trim() || 'full_system';
  if (!['full_system', 'company'].includes(scope)) {
    throw new Error('Backup metadata scope is invalid.');
  }

  const collections = Array.isArray(manifest.collections)
    ? manifest.collections
        .map((entry) => ({
          name: String(entry?.name || entry?.collection || '').trim(),
          file: String(entry?.file || '').trim(),
          count: Number(entry?.count) || 0,
        }))
        .filter((entry) => entry.name && entry.file)
    : [];

  const companyId =
    manifest.company_id && mongoose.Types.ObjectId.isValid(String(manifest.company_id))
      ? String(manifest.company_id)
      : null;

  return {
    ...manifest,
    scope_type: scope,
    company_id: companyId,
    collections,
  };
};

const readManifestFromArchive = async (zipPath) => {
  const directory = await unzipper.Open.file(zipPath);
  const metadataEntry = directory.files.find((entry) => entry.path === 'metadata.json');

  if (!metadataEntry) {
    throw new Error('metadata.json not found in backup archive.');
  }

  const metadataBuffer = await metadataEntry.buffer();
  const parsed = JSON.parse(metadataBuffer.toString('utf8'));
  return normalizeManifest(parsed);
};

const resolveBackupFilePath = (storedPath) => {
  if (!storedPath) return '';
  if (path.isAbsolute(storedPath)) return storedPath;
  return path.resolve(process.cwd(), storedPath);
};

export const createBackup = async ({
  scope,
  companyId = null,
  createdBy,
  historyType = null,
  sourceBackupId = null,
}) => {
  if (!['full_system', 'company'].includes(scope)) {
    throw new Error('Invalid backup scope. Use full_system or company.');
  }

  const normalizedHistoryType = historyType || scope;
  if (!['full_system', 'company', 'tenant', 'pre_restore'].includes(normalizedHistoryType)) {
    throw new Error('Invalid backup history type.');
  }

  const normalizedCompanyId = asObjectId(companyId);
  if (scope === 'company' && !normalizedCompanyId) {
    throw new Error('Valid companyId is required for company backups.');
  }

  await ensureStorageDirectories();

  const db = getCurrentDb();
  let tenant = null;
  if (scope === 'company') {
    tenant = await Tenant.findById(normalizedCompanyId).select('_id name').lean();
    if (!tenant) {
      throw new Error('Company not found for backup.');
    }
  }

  const directoryKey =
    normalizedHistoryType === 'pre_restore'
      ? 'pre_restore'
      : normalizedHistoryType === 'tenant'
        ? 'tenant'
        : scope;
  const backupDirectory = BACKUP_DIRS[directoryKey];
  const preferredFilename = createBackupFilename({
    scope,
    historyType: normalizedHistoryType,
    companyName: tenant?.name,
  });
  const backupAbsolutePath = await createUniqueFilePath(
    backupDirectory,
    preferredFilename
  );
  const tempDirectory = path.join(TMP_DIR, `backup_${Date.now()}_${Math.random().toString(16).slice(2)}`);

  try {
    await fs.mkdir(tempDirectory, { recursive: true });
    const specs = await getCollectionSpecsForScope({
      db,
      scope,
      companyId: normalizedCompanyId,
    });
    const orderedSpecs =
      scope === 'company'
        ? COMPANY_COLLECTION_ORDER.map((name) =>
            specs.find((entry) => entry.collection === name)
          ).filter(Boolean)
        : specs;

    const collectionManifest = [];
    for (const spec of orderedSpecs) {
      const outputFilename = `${spec.collection}.jsonl`;
      const outputPath = path.join(tempDirectory, outputFilename);
      const total = await exportCollectionAsJsonl({
        db,
        collectionName: spec.collection,
        filter: spec.filter,
        outputPath,
      });

      collectionManifest.push({
        name: spec.collection,
        file: outputFilename,
        count: total,
        filter: serializeFilter(spec.filter),
      });
    }

    const manifest = createBackupManifest({
      scope,
      historyType: normalizedHistoryType,
      companyId: normalizedCompanyId,
      companyName: tenant?.name || null,
      createdBy,
      collections: collectionManifest,
    });
    await fs.writeFile(
      path.join(tempDirectory, 'metadata.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    await zipDirectory({
      sourceDirectory: tempDirectory,
      targetZipPath: backupAbsolutePath,
    });

    const stats = await fs.stat(backupAbsolutePath);
    const backupHistory = await BackupHistory.create({
      backup_name: path.basename(backupAbsolutePath),
      type: normalizedHistoryType,
      company_id: scope === 'company' ? normalizedCompanyId : null,
      file_size: stats.size,
      storage_path: backupAbsolutePath,
      file_path: backupAbsolutePath,
      status: 'COMPLETED',
      created_by: asObjectId(createdBy),
      source_backup_id: sourceBackupId ? asObjectId(sourceBackupId) : null,
    });

    const populated = await BackupHistory.findById(backupHistory._id)
      .populate('company_id', 'name code')
      .populate('created_by', 'name email')
      .lean();

    return {
      ...populated,
      storage_url_path: toStorageUrlPath(backupAbsolutePath),
    };
  } catch (error) {
    throw error;
  } finally {
    await safeRemovePath(tempDirectory);
  }
};

export const createTenantBackupsForAll = async ({ createdBy }) => {
  const tenants = await Tenant.find({})
    .select('_id name code')
    .sort({ name: 1 })
    .lean();

  const created = [];
  const failed = [];

  for (const tenant of tenants) {
    try {
      const backup = await createBackup({
        scope: 'company',
        companyId: tenant?._id,
        createdBy,
        historyType: 'tenant',
      });
      created.push(backup);
    } catch (error) {
      failed.push({
        tenant_id: tenant?._id ? String(tenant._id) : null,
        tenant_name: tenant?.name || '',
        tenant_code: tenant?.code || '',
        error: error?.message || 'Failed to create backup.',
      });
    }
  }

  return {
    total: tenants.length,
    created,
    failed,
  };
};

const restoreFromExtractedPayload = async ({
  extractedDir,
  manifest,
  scope,
  companyObjectId,
}) => {
  const db = getCurrentDb();
  const insertedSummary = [];
  const collectionsInBackup = manifest.collections.map((entry) => entry.name);

  if (scope === 'full_system') {
    for (const collectionName of collectionsInBackup) {
      if (collectionName === 'backup_history') {
        continue;
      }
      await db.collection(collectionName).deleteMany({});
    }

    for (const collectionEntry of manifest.collections) {
      if (collectionEntry.name === 'backup_history') {
        continue;
      }
      const importedCount = await importCollectionFromJsonl({
        db,
        collectionName: collectionEntry.name,
        inputPath: path.join(extractedDir, collectionEntry.file),
      });
      insertedSummary.push({
        collection: collectionEntry.name,
        inserted: importedCount,
      });
    }

    return insertedSummary;
  }

  const scopedSpecs = await buildCompanyCollectionSpecs({
    db,
    companyId: companyObjectId,
  });
  const specMap = new Map(
    scopedSpecs.map((entry) => [entry.collection, entry.filter])
  );

  for (const collectionName of COMPANY_COLLECTION_ORDER) {
    if (!collectionsInBackup.includes(collectionName)) {
      continue;
    }
    const filter = specMap.get(collectionName);
    if (!filter) {
      continue;
    }
    await db.collection(collectionName).deleteMany(filter);
  }

  for (const collectionEntry of manifest.collections) {
    if (!specMap.has(collectionEntry.name)) {
      continue;
    }
    const importedCount = await importCollectionFromJsonl({
      db,
      collectionName: collectionEntry.name,
      inputPath: path.join(extractedDir, collectionEntry.file),
    });
    insertedSummary.push({
      collection: collectionEntry.name,
      inserted: importedCount,
    });
  }

  return insertedSummary;
};

const runRestoreFromArchive = async ({
  zipPath,
  initiatedBy,
  sourceBackupRecord = null,
}) => {
  const manifest = await readManifestFromArchive(zipPath);
  const scope = manifest.scope_type || 'full_system';
  const companyObjectId = asObjectId(manifest.company_id);

  if (scope === 'company' && !companyObjectId) {
    throw new Error('Company backup metadata is missing company_id.');
  }

  const safetyBackup = await createBackup({
    scope,
    companyId: companyObjectId,
    createdBy: initiatedBy,
    historyType: 'pre_restore',
    sourceBackupId: sourceBackupRecord?._id || null,
  });

  const extractedDir = path.join(
    TMP_DIR,
    `restore_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );

  try {
    await extractZipArchive({ zipPath, targetDirectory: extractedDir });
    const insertedCollections = await restoreFromExtractedPayload({
      extractedDir,
      manifest,
      scope,
      companyObjectId,
    });

    if (sourceBackupRecord?._id) {
      await BackupHistory.findByIdAndUpdate(sourceBackupRecord._id, {
        $set: {
          restored_by: asObjectId(initiatedBy),
          restored_at: new Date(),
        },
      });
    }

    return {
      manifest,
      safety_backup: safetyBackup,
      inserted_collections: insertedCollections,
    };
  } finally {
    await safeRemovePath(extractedDir);
  }
};

export const restoreBackupFromHistory = async ({ backupId, initiatedBy }) => {
  const backupRecord = await BackupHistory.findById(backupId).lean();
  if (!backupRecord) {
    throw new Error('Backup not found.');
  }

  const zipPath = resolveBackupFilePath(backupRecord.storage_path);
  if (!(await fileExists(zipPath))) {
    throw new Error('Backup file does not exist on storage.');
  }

  const restored = await runRestoreFromArchive({
    zipPath,
    initiatedBy,
    sourceBackupRecord: backupRecord,
  });

  return {
    backup: backupRecord,
    ...restored,
  };
};

export const restoreBackupFromUploadedFile = async ({
  uploadedZipPath,
  initiatedBy,
}) => {
  if (!(await fileExists(uploadedZipPath))) {
    throw new Error('Uploaded backup file not found.');
  }

  return runRestoreFromArchive({
    zipPath: uploadedZipPath,
    initiatedBy,
    sourceBackupRecord: null,
  });
};

export const getBackupDownloadPath = (backupRecord) =>
  resolveBackupFilePath(backupRecord?.storage_path || backupRecord?.file_path || '');

export const removeBackupFile = async (backupRecord) => {
  const filePath = getBackupDownloadPath(backupRecord);
  if (!filePath) return false;
  if (!(await fileExists(filePath))) return false;
  await fs.unlink(filePath);
  return true;
};

export const listBackupHistory = async ({
  page = 1,
  limit = 20,
  type,
  companyId,
  status,
}) => {
  const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skip = (normalizedPage - 1) * normalizedLimit;

  const filter = {};
  if (type && ['full_system', 'company', 'tenant', 'pre_restore'].includes(String(type))) {
    filter.type = String(type);
  }
  const companyObjectId = asObjectId(companyId);
  if (companyObjectId) {
    filter.company_id = companyObjectId;
  }
  if (
    status &&
    ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'RESTORED', 'DELETED'].includes(
      String(status).toUpperCase()
    )
  ) {
    filter.status = String(status).toUpperCase();
  }

  const [items, total] = await Promise.all([
    BackupHistory.find(filter)
      .populate('company_id', 'name code')
      .populate('created_by', 'name email')
      .populate('restored_by', 'name email')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(normalizedLimit)
      .lean(),
    BackupHistory.countDocuments(filter),
  ]);

  const rows = items.map((entry) => ({
    ...entry,
    storage_url_path: entry?.storage_path || entry?.file_path
      ? toStorageUrlPath(resolveBackupFilePath(entry.storage_path || entry.file_path))
      : '',
  }));

  return {
    items: rows,
    pagination: {
      page: normalizedPage,
      limit: normalizedLimit,
      total,
      pages: Math.ceil(total / normalizedLimit),
    },
  };
};

export const deleteBackup = async ({ backupId }) => {
  const backupRecord = await BackupHistory.findById(backupId);
  if (!backupRecord) {
    throw new Error('Backup not found.');
  }

  await removeBackupFile(backupRecord);
  await BackupHistory.findByIdAndDelete(backupRecord._id);

  return {
    backup_id: String(backupRecord._id),
    backup_name: backupRecord.backup_name,
  };
};

export const parseBackupManifest = async ({ zipPath }) => readManifestFromArchive(zipPath);
