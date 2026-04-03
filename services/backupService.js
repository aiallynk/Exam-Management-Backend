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
  'subtenants',
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
  'notifications',
  'auditlogs',
];
const VALID_TRIGGER_TYPES = ['MANUAL', 'AUTO'];
const DEFAULT_AUTO_BACKUP_RETRY_ATTEMPTS = 0;
const DEFAULT_AUTO_BACKUP_RETRY_DELAY_MS = 5000;
const DEFAULT_AUTO_BACKUP_INTER_TENANT_DELAY_MS = 250;
const IST_TIMEZONE = 'Asia/Kolkata';
const MAX_BACKUP_ERROR_MESSAGE_LENGTH = 1000;
const IST_DATE_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const pad = (value) => String(value).padStart(2, '0');

const asObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
};

const normalizeTriggerType = (value) => {
  const normalized = String(value || 'MANUAL').trim().toUpperCase();
  return VALID_TRIGGER_TYPES.includes(normalized) ? normalized : 'MANUAL';
};

const sleep = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(Number(delayMs) || 0, 0));
  });

const sanitizeForFilename = (value) => {
  const raw = String(value || 'company')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return raw || 'company';
};

const getIstDateParts = (date = new Date()) => {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const parts = IST_DATE_PARTS_FORMATTER.formatToParts(safeDate).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    year: Number(parts.year) || safeDate.getUTCFullYear(),
    month: Number(parts.month) || safeDate.getUTCMonth() + 1,
    day: Number(parts.day) || safeDate.getUTCDate(),
    hour: Number(parts.hour) || 0,
    minute: Number(parts.minute) || 0,
    second: Number(parts.second) || 0,
  };
};

const createDateStamp = (date = new Date()) => {
  const { year, month, day } = getIstDateParts(date);
  return `${year}_${month}_${day}`;
};

const createDateTimeStamp = (date = new Date()) => {
  const { year, month, day, hour, minute, second } = getIstDateParts(date);
  const hours = pad(hour);
  const minutes = pad(minute);
  const seconds = pad(second);
  return `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
};

const createMinuteStamp = (date = new Date()) =>
  createDateTimeStamp(date).split('_').slice(0, 5).join('_');

const createTenantBackupFilename = (companyId) => {
  const tenantId = String(companyId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return `tenant_${tenantId || 'unknown'}_backup.zip`;
};

const createBackupFilename = ({ scope, historyType, companyName, companyId }) => {
  if (historyType === 'pre_restore') {
    return `pre_restore_backup_${createDateTimeStamp()}.zip`;
  }

  if (historyType === 'tenant') {
    return createTenantBackupFilename(companyId);
  }

  if (scope === 'full_system') {
    const yearMonthDayHourMin = createMinuteStamp();
    return `full_backup_${yearMonthDayHourMin}.zip`;
  }

  const safeName = sanitizeForFilename(companyName);
  return `company_backup_${safeName}_${createDateStamp()}.zip`;
};

const sanitizeErrorMessage = (value) =>
  String(value || 'Backup operation failed.')
    .trim()
    .slice(0, MAX_BACKUP_ERROR_MESSAGE_LENGTH);

const escapeRegex = (value) =>
  String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDateFilterValue = (value, { endOfDay = false } = {}) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }
  return parsed;
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

const countJsonlRecords = async (inputPath) => {
  if (!(await fileExists(inputPath))) return 0;

  const stream = fsSync.createReadStream(inputPath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of reader) {
    if (line.trim()) {
      count += 1;
    }
  }
  return count;
};

const readJsonlIntoMapById = async ({
  inputPath,
  map,
  existingCount = 0,
}) => {
  if (!(await fileExists(inputPath))) {
    return existingCount;
  }

  const targetMap = map instanceof Map ? map : new Map();
  const stream = fsSync.createReadStream(inputPath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let sequence = existingCount;
  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const document = EJSON.parse(trimmed, { relaxed: false });
    const hasId = document && typeof document === 'object' && document._id !== undefined;
    const key = hasId
      ? `id:${EJSON.stringify(document._id, { relaxed: false })}`
      : `seq:${sequence}`;
    targetMap.set(key, document);
    sequence += 1;
  }

  return sequence;
};

const writeJsonlFromMap = async ({ outputPath, sourceMap }) => {
  const writer = fsSync.createWriteStream(outputPath, { encoding: 'utf8' });
  try {
    for (const document of sourceMap.values()) {
      if (document === undefined) continue;
      const payload = `${EJSON.stringify(document, { relaxed: false })}\n`;
      if (!writer.write(payload)) {
        await once(writer, 'drain');
      }
    }
    writer.end();
    await once(writer, 'finish');
  } catch (error) {
    writer.destroy();
    throw error;
  }
};

const mergeJsonlFilesByDocumentId = async ({
  baseFilePath,
  deltaFilePath,
  outputPath,
}) => {
  const mergedMap = new Map();
  let sequence = 0;

  sequence = await readJsonlIntoMapById({
    inputPath: baseFilePath,
    map: mergedMap,
    existingCount: sequence,
  });

  await readJsonlIntoMapById({
    inputPath: deltaFilePath,
    map: mergedMap,
    existingCount: sequence,
  });

  await writeJsonlFromMap({
    outputPath,
    sourceMap: mergedMap,
  });

  return mergedMap.size;
};

const buildIncrementalFilter = ({ baseFilter, since }) => {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
    return baseFilter || {};
  }

  const base = baseFilter && typeof baseFilter === 'object' ? baseFilter : {};
  const withObjectIdSince = mongoose.Types.ObjectId.createFromTime(
    Math.max(Math.floor(since.getTime() / 1000), 0)
  );
  const timestampWindow = {
    $or: [
      { updatedAt: { $gt: since } },
      { createdAt: { $gt: since } },
      { _id: { $gt: withObjectIdSince } },
    ],
  };

  if (!Object.keys(base).length) {
    return timestampWindow;
  }

  return {
    $and: [base, timestampWindow],
  };
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
    { collection: 'subtenants', filter: { tenantId: scope.companyId } },
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
    { collection: 'notifications', filter: { tenantId: scope.companyId } },
    { collection: 'auditlogs', filter: { tenantId: scope.companyId } },
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
  triggerType,
  companyId,
  companyName,
  createdBy,
  collections,
}) => ({
  version: '1.0.0',
  type: historyType,
  trigger_type: triggerType,
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

const validateBackupArchiveIntegrity = async ({ zipPath, expectedCollectionFiles = [] }) => {
  const directory = await unzipper.Open.file(zipPath);
  const archivePaths = new Set(
    (Array.isArray(directory?.files) ? directory.files : []).map((entry) => entry?.path).filter(Boolean)
  );
  if (!archivePaths.has('metadata.json')) {
    throw new Error('Backup archive integrity check failed: metadata.json is missing.');
  }

  const manifest = await readManifestFromArchive(zipPath);
  const manifestFiles = new Set(
    (Array.isArray(manifest?.collections) ? manifest.collections : [])
      .map((entry) => String(entry?.file || '').trim())
      .filter(Boolean)
  );
  const normalizedExpectedFiles = Array.isArray(expectedCollectionFiles)
    ? expectedCollectionFiles.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const missingArchiveEntries = normalizedExpectedFiles.filter(
    (fileName) => !archivePaths.has(fileName)
  );
  if (missingArchiveEntries.length > 0) {
    throw new Error(
      `Backup archive integrity check failed: missing entries (${missingArchiveEntries.join(', ')}).`
    );
  }

  const missingManifestEntries = normalizedExpectedFiles.filter(
    (fileName) => !manifestFiles.has(fileName)
  );
  if (missingManifestEntries.length > 0) {
    throw new Error(
      `Backup archive integrity check failed: manifest missing entries (${missingManifestEntries.join(', ')}).`
    );
  }
};

const getFileSizeSafe = async (filePath) => {
  if (!filePath) return 0;
  try {
    const stats = await fs.stat(filePath);
    return Number(stats?.size) || 0;
  } catch {
    return 0;
  }
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
  triggerType = 'MANUAL',
}) => {
  if (!['full_system', 'company'].includes(scope)) {
    throw new Error('Invalid backup scope. Use full_system or company.');
  }

  const normalizedHistoryType = historyType || scope;
  if (!['full_system', 'company', 'tenant', 'pre_restore'].includes(normalizedHistoryType)) {
    throw new Error('Invalid backup history type.');
  }
  const normalizedTriggerType = normalizeTriggerType(triggerType);

  const normalizedCompanyId = asObjectId(companyId);
  if (scope === 'company' && !normalizedCompanyId) {
    throw new Error('Valid companyId is required for company backups.');
  }
  const normalizedCreatedBy = asObjectId(createdBy);
  if (!normalizedCreatedBy) {
    throw new Error('Valid createdBy user ID is required for backups.');
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
    companyId: normalizedCompanyId,
  });
  const isTenantBackup =
    normalizedHistoryType === 'tenant' && scope === 'company' && Boolean(normalizedCompanyId);
  const backupAbsolutePath = isTenantBackup
    ? path.join(backupDirectory, preferredFilename)
    : await createUniqueFilePath(backupDirectory, preferredFilename);
  const stagedBackupAbsolutePath = isTenantBackup
    ? path.join(
        TMP_DIR,
        `backup_stage_${Date.now()}_${Math.random().toString(16).slice(2)}.zip`
      )
    : backupAbsolutePath;
  const tempDirectory = path.join(TMP_DIR, `backup_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const previousBackupExtractDirectory = path.join(
    TMP_DIR,
    `backup_previous_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const sourceBackupObjectId = sourceBackupId ? asObjectId(sourceBackupId) : null;
  let backupHistoryId = null;
  let previousBackupFilePath = '';
  let incrementalSince = null;
  let previousRecordStatus = '';
  let usingExistingTenantRecord = false;
  const resolvedBackupName = path.basename(backupAbsolutePath);
  const companyRef = scope === 'company' ? normalizedCompanyId : null;

  if (isTenantBackup) {
    const existingCanonicalRecord = await BackupHistory.findOne({
      type: 'tenant',
      company_id: companyRef,
      backup_name: resolvedBackupName,
      status: { $ne: 'DELETED' },
    })
      .sort({ updated_at: -1, created_at: -1 })
      .lean();

    const fallbackLatestRecord = existingCanonicalRecord
      ? null
      : await BackupHistory.findOne({
          type: 'tenant',
          company_id: companyRef,
          status: { $in: ['COMPLETED', 'RESTORED'] },
        })
          .sort({ updated_at: -1, created_at: -1 })
          .lean();

    if (existingCanonicalRecord?._id) {
      backupHistoryId = String(existingCanonicalRecord._id);
      previousRecordStatus = String(existingCanonicalRecord.status || '');
      usingExistingTenantRecord = true;
    }

    const previousRecord = existingCanonicalRecord || fallbackLatestRecord;
    if (previousRecord) {
      const previousRecordPath = resolveBackupFilePath(
        previousRecord.storage_path || previousRecord.file_path || ''
      );
      if (previousRecordPath && (await fileExists(previousRecordPath))) {
        previousBackupFilePath = previousRecordPath;
      }
      const previousTimestampValue = previousRecord.updated_at || previousRecord.created_at;
      const parsedPreviousTimestamp = previousTimestampValue
        ? new Date(previousTimestampValue)
        : null;
      if (parsedPreviousTimestamp && !Number.isNaN(parsedPreviousTimestamp.getTime())) {
        incrementalSince = parsedPreviousTimestamp;
      }
    }

    if (!previousBackupFilePath && (await fileExists(backupAbsolutePath))) {
      previousBackupFilePath = backupAbsolutePath;
    }
  }

  const hadPreviousTargetBackup = Boolean(
    previousBackupFilePath &&
      path.resolve(previousBackupFilePath) === path.resolve(backupAbsolutePath)
  );

  console.log(
    `[backup] Starting ${normalizedHistoryType} backup for ${
      tenant?.name || scope
    } (${normalizedTriggerType}).`
  );

  try {
    if (usingExistingTenantRecord && backupHistoryId) {
      await BackupHistory.findByIdAndUpdate(backupHistoryId, {
        $set: {
          backup_name: resolvedBackupName,
          trigger_type: normalizedTriggerType,
          company_id: companyRef,
          storage_path: backupAbsolutePath,
          file_path: backupAbsolutePath,
          status: 'IN_PROGRESS',
          created_by: normalizedCreatedBy,
          source_backup_id: sourceBackupObjectId,
          error_message: '',
        },
      });
    } else {
      const inProgressRecord = await BackupHistory.create({
        backup_name: resolvedBackupName,
        type: normalizedHistoryType,
        trigger_type: normalizedTriggerType,
        company_id: companyRef,
        file_size: 0,
        storage_path: backupAbsolutePath,
        file_path: backupAbsolutePath,
        status: 'IN_PROGRESS',
        created_by: normalizedCreatedBy,
        source_backup_id: sourceBackupObjectId,
        error_message: '',
      });
      backupHistoryId = inProgressRecord?._id ? String(inProgressRecord._id) : null;
    }

    await fs.mkdir(tempDirectory, { recursive: true });
    if (isTenantBackup && previousBackupFilePath && (await fileExists(previousBackupFilePath))) {
      try {
        await extractZipArchive({
          zipPath: previousBackupFilePath,
          targetDirectory: previousBackupExtractDirectory,
        });
      } catch (extractError) {
        console.warn(
          `[backup] Could not extract previous tenant backup for incremental merge (${resolvedBackupName}): ${
            extractError?.message || extractError
          }`
        );
        previousBackupFilePath = '';
        incrementalSince = null;
        await safeRemovePath(previousBackupExtractDirectory);
      }
    }

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
      let total = 0;
      const canIncrementallyMerge =
        isTenantBackup &&
        previousBackupFilePath &&
        incrementalSince instanceof Date &&
        !Number.isNaN(incrementalSince.getTime());

      if (canIncrementallyMerge) {
        const previousCollectionFilePath = path.join(
          previousBackupExtractDirectory,
          outputFilename
        );
        const deltaOutputPath = path.join(tempDirectory, `delta_${outputFilename}`);
        const incrementalFilter = buildIncrementalFilter({
          baseFilter: spec.filter,
          since: incrementalSince,
        });
        const deltaCount = await exportCollectionAsJsonl({
          db,
          collectionName: spec.collection,
          filter: incrementalFilter,
          outputPath: deltaOutputPath,
        });

        if (await fileExists(previousCollectionFilePath)) {
          if (deltaCount > 0) {
            total = await mergeJsonlFilesByDocumentId({
              baseFilePath: previousCollectionFilePath,
              deltaFilePath: deltaOutputPath,
              outputPath,
            });
          } else {
            await fs.copyFile(previousCollectionFilePath, outputPath);
            total = await countJsonlRecords(outputPath);
          }
        } else {
          total = await exportCollectionAsJsonl({
            db,
            collectionName: spec.collection,
            filter: spec.filter,
            outputPath,
          });
        }

        await safeRemovePath(deltaOutputPath);
      } else {
        total = await exportCollectionAsJsonl({
          db,
          collectionName: spec.collection,
          filter: spec.filter,
          outputPath,
        });
      }

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
      triggerType: normalizedTriggerType,
      companyId: normalizedCompanyId,
      companyName: tenant?.name || null,
      createdBy: normalizedCreatedBy,
      collections: collectionManifest,
    });
    await fs.writeFile(
      path.join(tempDirectory, 'metadata.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    await zipDirectory({
      sourceDirectory: tempDirectory,
      targetZipPath: stagedBackupAbsolutePath,
    });

    await validateBackupArchiveIntegrity({
      zipPath: stagedBackupAbsolutePath,
      expectedCollectionFiles: collectionManifest.map((entry) => entry.file),
    });

    if (path.resolve(stagedBackupAbsolutePath) !== path.resolve(backupAbsolutePath)) {
      await fs.copyFile(stagedBackupAbsolutePath, backupAbsolutePath);
    }

    const stats = await fs.stat(backupAbsolutePath);
    if (!backupHistoryId) {
      throw new Error('Backup history record could not be created.');
    }

    await BackupHistory.findByIdAndUpdate(backupHistoryId, {
      $set: {
        backup_name: resolvedBackupName,
        file_size: Number(stats?.size) || 0,
        storage_path: backupAbsolutePath,
        file_path: backupAbsolutePath,
        status: 'COMPLETED',
        error_message: '',
      },
    });

    const populated = await BackupHistory.findById(backupHistoryId)
      .populate('company_id', 'name code')
      .populate('created_by', 'name email')
      .lean();
    if (!populated) {
      throw new Error('Backup history record not found after backup completion.');
    }

    console.log(
      `[backup] Completed ${normalizedHistoryType} backup ${resolvedBackupName} (${stats.size} bytes).`
    );

    return {
      ...populated,
      storage_url_path: toStorageUrlPath(backupAbsolutePath),
    };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error?.message);
    const sizeOnFailure = await getFileSizeSafe(backupAbsolutePath);
    const safePreviousStatus = String(previousRecordStatus || '').toUpperCase();
    const shouldRestoreStatus =
      isTenantBackup &&
      hadPreviousTargetBackup &&
      ['COMPLETED', 'RESTORED'].includes(safePreviousStatus);
    const failureStatus = shouldRestoreStatus ? safePreviousStatus : 'FAILED';

    if (backupHistoryId) {
      await BackupHistory.findByIdAndUpdate(backupHistoryId, {
        $set: {
          status: failureStatus,
          error_message: errorMessage,
          file_size: sizeOnFailure,
          backup_name: resolvedBackupName,
          storage_path: backupAbsolutePath,
          file_path: backupAbsolutePath,
        },
      });
    }

    if (!(isTenantBackup && hadPreviousTargetBackup)) {
      await safeRemovePath(backupAbsolutePath);
    }
    await safeRemovePath(stagedBackupAbsolutePath);
    console.error(
      `[backup] Failed ${normalizedHistoryType} backup ${resolvedBackupName}: ${errorMessage}`
    );
    throw error;
  } finally {
    await safeRemovePath(tempDirectory);
    await safeRemovePath(previousBackupExtractDirectory);
    if (path.resolve(stagedBackupAbsolutePath) !== path.resolve(backupAbsolutePath)) {
      await safeRemovePath(stagedBackupAbsolutePath);
    }
  }
};

export const createTenantBackupsForAll = async ({
  createdBy,
  triggerType = 'MANUAL',
  tenantFilter = {},
  shouldSkipTenant = null,
  retryAttempts = 0,
  retryDelayMs = 0,
  interBackupDelayMs = 0,
}) => {
  const tenants = await Tenant.find(tenantFilter || {})
    .select('_id name code')
    .sort({ name: 1 })
    .lean();

  const created = [];
  const failed = [];
  const skipped = [];
  const normalizedRetryAttempts = Math.max(parseInt(retryAttempts, 10) || 0, 0);
  const normalizedRetryDelayMs = Math.max(parseInt(retryDelayMs, 10) || 0, 0);
  const normalizedInterBackupDelayMs = Math.max(parseInt(interBackupDelayMs, 10) || 0, 0);
  const normalizedTriggerType = normalizeTriggerType(triggerType);

  for (const tenant of tenants) {
    console.log(
      `[backup] Processing tenant backup for ${tenant?.name || 'Unknown Tenant'} (${String(
        tenant?._id || ''
      )}) trigger=${normalizedTriggerType}`
    );

    if (typeof shouldSkipTenant === 'function') {
      try {
        const skipReason = await shouldSkipTenant(tenant);
        if (skipReason) {
          console.log(
            `[backup] Skipping tenant ${tenant?.name || 'Unknown Tenant'}: ${String(skipReason)}`
          );
          skipped.push({
            tenant_id: tenant?._id ? String(tenant._id) : null,
            tenant_name: tenant?.name || '',
            tenant_code: tenant?.code || '',
            status: 'SKIPPED',
            reason: String(skipReason),
          });
          if (normalizedInterBackupDelayMs > 0) {
            await sleep(normalizedInterBackupDelayMs);
          }
          continue;
        }
      } catch (error) {
        failed.push({
          tenant_id: tenant?._id ? String(tenant._id) : null,
          tenant_name: tenant?.name || '',
          tenant_code: tenant?.code || '',
          status: 'FAILED',
          error: error?.message || 'Failed to evaluate tenant skip condition.',
        });
        if (normalizedInterBackupDelayMs > 0) {
          await sleep(normalizedInterBackupDelayMs);
        }
        continue;
      }
    }

    let attempt = 0;
    let backup = null;
    let lastError = null;

    while (attempt <= normalizedRetryAttempts) {
      try {
        backup = await createBackup({
          scope: 'company',
          companyId: tenant?._id,
          createdBy,
          historyType: 'tenant',
          triggerType: normalizedTriggerType,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt <= normalizedRetryAttempts && normalizedRetryDelayMs > 0) {
          await sleep(normalizedRetryDelayMs);
        }
      }
    }

    if (backup) {
      console.log(
        `[backup] Tenant backup completed for ${tenant?.name || 'Unknown Tenant'} (${backup?.backup_name || ''})`
      );
      created.push(backup);
    } else {
      console.error(
        `[backup] Tenant backup failed for ${tenant?.name || 'Unknown Tenant'}: ${
          lastError?.message || 'Failed to create backup.'
        }`
      );
      failed.push({
        tenant_id: tenant?._id ? String(tenant._id) : null,
        tenant_name: tenant?.name || '',
        tenant_code: tenant?.code || '',
        status: 'FAILED',
        error: lastError?.message || 'Failed to create backup.',
      });
    }

    if (normalizedInterBackupDelayMs > 0) {
      await sleep(normalizedInterBackupDelayMs);
    }
  }

  return {
    total: tenants.length,
    created,
    failed,
    skipped,
  };
};

export const createAutoTenantBackupsForActiveTenants = async ({
  createdBy,
  dayStartUtc,
  dayEndUtc,
  retryAttempts = DEFAULT_AUTO_BACKUP_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_AUTO_BACKUP_RETRY_DELAY_MS,
  interBackupDelayMs = DEFAULT_AUTO_BACKUP_INTER_TENANT_DELAY_MS,
}) => {
  const safeDayStart =
    dayStartUtc instanceof Date && !Number.isNaN(dayStartUtc.getTime())
      ? dayStartUtc
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const safeDayEnd =
    dayEndUtc instanceof Date && !Number.isNaN(dayEndUtc.getTime())
      ? dayEndUtc
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

  return createTenantBackupsForAll({
    createdBy,
    triggerType: 'AUTO',
    tenantFilter: { status: 'ACTIVE' },
    retryAttempts,
    retryDelayMs,
    interBackupDelayMs,
    shouldSkipTenant: async (tenant) => {
      const existingBackupForDay = await BackupHistory.exists({
        type: 'tenant',
        trigger_type: 'AUTO',
        company_id: asObjectId(tenant?._id),
        status: { $in: ['IN_PROGRESS', 'COMPLETED'] },
        $or: [
          {
            updated_at: {
              $gte: safeDayStart,
              $lt: safeDayEnd,
            },
          },
          {
            created_at: {
              $gte: safeDayStart,
              $lt: safeDayEnd,
            },
          },
        ],
      });
      return existingBackupForDay ? 'already_created_for_ist_day' : '';
    },
  });
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
  triggerType,
  startDate,
  endDate,
  search,
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
  const requestedTriggerType = String(triggerType || '').trim().toUpperCase();
  if (VALID_TRIGGER_TYPES.includes(requestedTriggerType)) {
    filter.trigger_type = requestedTriggerType;
  }
  const normalizedSearch = String(search || '').trim();
  if (normalizedSearch) {
    filter.backup_name = {
      $regex: escapeRegex(normalizedSearch),
      $options: 'i',
    };
  }
  const parsedStartDate = parseDateFilterValue(startDate, { endOfDay: false });
  const parsedEndDate = parseDateFilterValue(endDate, { endOfDay: true });
  if (parsedStartDate || parsedEndDate) {
    filter.created_at = {};
    if (parsedStartDate) {
      filter.created_at.$gte = parsedStartDate;
    }
    if (parsedEndDate) {
      filter.created_at.$lte = parsedEndDate;
    }
  }

  const [items, total] = await Promise.all([
    BackupHistory.find(filter)
      .populate('company_id', 'name code')
      .populate('created_by', 'name email')
      .populate('restored_by', 'name email')
      .sort({ updated_at: -1, created_at: -1 })
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
