import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import Tenant from '../models/Tenant.js';

const DEFAULT_BACKUP_STORAGE_DIR = process.env.BACKUP_STORAGE_DIR || 'backups';
const INCREMENTAL_BACKUP_ROOT_DIR = path.resolve(
  process.cwd(),
  process.env.INCREMENTAL_BACKUP_DIR || path.join(DEFAULT_BACKUP_STORAGE_DIR, 'incremental')
);
const TENANT_BACKUP_DIR = path.join(INCREMENTAL_BACKUP_ROOT_DIR, 'tenants');
const MATCH_NONE_FILTER = { _id: { $in: [] } };
const DEFAULT_UPSERT_BATCH_SIZE = 500;
const DEFAULT_ROTATION_THRESHOLD_MB = 250;
const MAX_COLLECTION_COUNT_IN_LOG = 25;

const toObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
};

const getCurrentDb = () => {
  const db = mongoose.connection?.db;
  if (!db) {
    throw new Error('Database connection is not available.');
  }
  return db;
};

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const ensureIncrementalBackupDirectories = async () => {
  await Promise.all(
    [INCREMENTAL_BACKUP_ROOT_DIR, TENANT_BACKUP_DIR].map((directoryPath) =>
      fs.mkdir(directoryPath, { recursive: true })
    )
  );
};

const toDate = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const andFilter = (...filters) => {
  const validFilters = filters.filter(Boolean);
  if (validFilters.length === 0) return {};
  if (validFilters.length === 1) return validFilters[0];
  return { $and: validFilters };
};

const orFilter = (...filters) => {
  const validFilters = filters.filter(Boolean);
  if (validFilters.length === 0) return MATCH_NONE_FILTER;
  if (validFilters.length === 1) return validFilters[0];
  return { $or: validFilters };
};

const inFilter = (field, ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return MATCH_NONE_FILTER;
  }
  return { [field]: { $in: ids } };
};

const toIso = (value = new Date()) => {
  const parsed = toDate(value);
  return (parsed || new Date()).toISOString();
};

const makeRecordKey = (record) => {
  if (!record || typeof record !== 'object' || typeof record._id === 'undefined') {
    return '';
  }
  return EJSON.stringify(record._id, { relaxed: false });
};

const buildTimeRangeFilter = ({ since, until }) => {
  if (!since) return null;
  const range = { $gt: since };
  if (until) {
    range.$lte = until;
  }
  return orFilter(
    { updatedAt: range },
    { createdAt: range },
    { updated_at: range },
    { created_at: range }
  );
};

/**
 * Sample incremental query shape used by this service.
 * This is exported to make the fetch strategy explicit for debugging and docs.
 */
export const buildIncrementalRecordQuery = ({
  baseFilter = {},
  lastBackupTime = null,
  runStartedAt = new Date(),
}) => {
  const since = toDate(lastBackupTime);
  if (!since) {
    return baseFilter || {};
  }
  const until = toDate(runStartedAt) || new Date();
  const timeRangeFilter = buildTimeRangeFilter({ since, until });
  return andFilter(baseFilter || {}, timeRangeFilter);
};

const getTenantBackupFilePathInternal = (tenantId) =>
  path.join(TENANT_BACKUP_DIR, `tenant_${String(tenantId)}.json`);

export const getIncrementalBackupFilePath = (tenantId) =>
  getTenantBackupFilePathInternal(tenantId);

const createEmptyTenantBackupPayload = ({ tenantId, tenantName = '' }) => ({
  version: '1.0.0',
  tenantId: String(tenantId),
  tenantName: String(tenantName || '').trim(),
  createdAt: toIso(),
  updatedAt: null,
  lastBackupTime: null,
  data: [],
  meta: {
    totalCollections: 0,
    totalRecords: 0,
    lastRun: null,
    rotationRecommendation: '',
  },
});

const normalizeLoadedPayload = ({ rawPayload, tenantId, tenantName = '' }) => {
  const fallback = createEmptyTenantBackupPayload({ tenantId, tenantName });
  if (!rawPayload || typeof rawPayload !== 'object') {
    return fallback;
  }

  const normalizedData = Array.isArray(rawPayload.data)
    ? rawPayload.data
        .map((entry) => {
          const collection = String(entry?.collection || '').trim();
          if (!collection) return null;
          const records = Array.isArray(entry?.records) ? entry.records : [];
          return {
            collection,
            records,
            updatedAt: entry?.updatedAt ? toIso(entry.updatedAt) : null,
          };
        })
        .filter(Boolean)
    : [];

  const normalized = {
    version: String(rawPayload.version || fallback.version),
    tenantId: String(rawPayload.tenantId || tenantId),
    tenantName: String(rawPayload.tenantName || tenantName || '').trim(),
    createdAt: rawPayload.createdAt ? toIso(rawPayload.createdAt) : fallback.createdAt,
    updatedAt: rawPayload.updatedAt ? toIso(rawPayload.updatedAt) : null,
    lastBackupTime: rawPayload.lastBackupTime ? toIso(rawPayload.lastBackupTime) : null,
    data: normalizedData,
    meta: {
      totalCollections:
        Number(rawPayload?.meta?.totalCollections) || normalizedData.length || 0,
      totalRecords:
        Number(rawPayload?.meta?.totalRecords) ||
        normalizedData.reduce(
          (sum, collectionEntry) =>
            sum + (Array.isArray(collectionEntry?.records) ? collectionEntry.records.length : 0),
          0
        ),
      lastRun: rawPayload?.meta?.lastRun || null,
      rotationRecommendation: String(rawPayload?.meta?.rotationRecommendation || ''),
    },
  };

  return normalized;
};

const readTenantBackupPayload = async ({ tenantId, tenantName }) => {
  const filePath = getTenantBackupFilePathInternal(tenantId);
  if (!(await fileExists(filePath))) {
    return {
      filePath,
      payload: createEmptyTenantBackupPayload({ tenantId, tenantName }),
      exists: false,
    };
  }

  try {
    const rawText = await fs.readFile(filePath, 'utf8');
    const parsed = EJSON.parse(rawText, { relaxed: false });
    return {
      filePath,
      payload: normalizeLoadedPayload({ rawPayload: parsed, tenantId, tenantName }),
      exists: true,
    };
  } catch (error) {
    throw new Error(
      `Failed to read incremental backup file for tenant ${String(tenantId)}: ${
        error?.message || error
      }`
    );
  }
};

const writeTenantBackupPayload = async ({ filePath, payload }) => {
  const tempPath = `${filePath}.tmp_${Date.now()}`;
  const serialized = EJSON.stringify(payload, { relaxed: false, space: 2 });
  await fs.writeFile(tempPath, serialized, 'utf8');
  await fs.rename(tempPath, filePath);
};

const buildTenantScopeState = async ({ db, tenantObjectId }) => {
  const examsCollection = db.collection('exams');
  const examIds = await examsCollection.distinct('_id', { tenantId: tenantObjectId });

  const examSessionFilter = orFilter(
    { tenantId: tenantObjectId },
    examIds.length ? { examId: { $in: examIds } } : null
  );
  const examSessionsCollection = db.collection('examsessions');
  const sessionIds = await examSessionsCollection.distinct('_id', examSessionFilter);

  const questionPapersCollection = db.collection('questionpapers');
  const questionPaperIds = examIds.length
    ? await questionPapersCollection.distinct('_id', { examId: { $in: examIds } })
    : [];

  const examAttemptFilter = orFilter(
    { tenantId: tenantObjectId },
    examIds.length ? { examId: { $in: examIds } } : null,
    sessionIds.length ? { sessionId: { $in: sessionIds } } : null
  );
  const examAttemptsCollection = db.collection('examattempts');
  const attemptIds = await examAttemptsCollection.distinct('_id', examAttemptFilter);

  return {
    tenantObjectId,
    examIds,
    sessionIds,
    questionPaperIds,
    attemptIds,
    examSessionFilter,
    examAttemptFilter,
  };
};

const buildTenantCollectionSpecs = (scope) => [
  { collection: 'tenants', baseFilter: { _id: scope.tenantObjectId } },
  { collection: 'users', baseFilter: { tenantId: scope.tenantObjectId } },
  { collection: 'subtenants', baseFilter: { tenantId: scope.tenantObjectId } },
  { collection: 'exams', baseFilter: { tenantId: scope.tenantObjectId } },
  { collection: 'questionpapers', baseFilter: inFilter('examId', scope.examIds) },
  {
    collection: 'sections',
    baseFilter: inFilter('questionPaperId', scope.questionPaperIds),
  },
  {
    collection: 'questions',
    baseFilter: inFilter('questionPaperId', scope.questionPaperIds),
  },
  { collection: 'answerkeys', baseFilter: inFilter('examId', scope.examIds) },
  { collection: 'examsessions', baseFilter: scope.examSessionFilter },
  {
    collection: 'sessionassignments',
    baseFilter: inFilter('sessionId', scope.sessionIds),
  },
  {
    collection: 'examparticipants',
    baseFilter: orFilter(
      { tenantId: scope.tenantObjectId },
      scope.examIds.length ? { examId: { $in: scope.examIds } } : null
    ),
  },
  { collection: 'examattempts', baseFilter: scope.examAttemptFilter },
  { collection: 'answers', baseFilter: inFilter('attemptId', scope.attemptIds) },
  { collection: 'submissions', baseFilter: inFilter('attemptId', scope.attemptIds) },
  {
    collection: 'omrresults',
    baseFilter: orFilter(
      { tenant_id: scope.tenantObjectId },
      scope.examIds.length ? { exam_id: { $in: scope.examIds } } : null,
      scope.examIds.length ? { examId: { $in: scope.examIds } } : null
    ),
  },
  { collection: 'ai_token_usage', baseFilter: { tenant_id: scope.tenantObjectId } },
  {
    collection: 'normalizationconfigs',
    baseFilter: orFilter(
      { tenantId: scope.tenantObjectId },
      scope.examIds.length ? { examId: { $in: scope.examIds } } : null
    ),
  },
  {
    collection: 'exampackages',
    baseFilter: orFilter(
      { tenantId: scope.tenantObjectId },
      scope.examIds.length ? { examId: { $in: scope.examIds } } : null
    ),
  },
  { collection: 'notifications', baseFilter: { tenantId: scope.tenantObjectId } },
  { collection: 'auditlogs', baseFilter: { tenantId: scope.tenantObjectId } },
];

const fetchCollectionIncrementalRecords = async ({
  db,
  collectionName,
  baseFilter,
  lastBackupTime,
  runStartedAt,
}) => {
  const collection = db.collection(collectionName);
  const query = buildIncrementalRecordQuery({
    baseFilter,
    lastBackupTime,
    runStartedAt,
  });
  return collection.find(query).toArray();
};

const mergeRecordsForCollection = ({ payload, collectionName, incomingRecords, runFinishedAt }) => {
  const normalizedIncomingRecords = Array.isArray(incomingRecords) ? incomingRecords : [];
  const collectionData = Array.isArray(payload.data) ? payload.data : [];

  let entry = collectionData.find((item) => item.collection === collectionName);
  if (!entry) {
    entry = {
      collection: collectionName,
      records: [],
      updatedAt: null,
    };
    collectionData.push(entry);
  }

  const existingRecords = Array.isArray(entry.records) ? entry.records : [];
  const indexById = new Map();
  existingRecords.forEach((record, index) => {
    const key = makeRecordKey(record);
    if (key) {
      indexById.set(key, index);
    }
  });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  normalizedIncomingRecords.forEach((record) => {
    const key = makeRecordKey(record);
    if (!key) {
      skipped += 1;
      return;
    }

    if (indexById.has(key)) {
      const existingIndex = indexById.get(key);
      existingRecords[existingIndex] = record;
      updated += 1;
      return;
    }

    indexById.set(key, existingRecords.length);
    existingRecords.push(record);
    inserted += 1;
  });

  entry.records = existingRecords;
  entry.updatedAt = toIso(runFinishedAt);
  payload.data = collectionData;

  return {
    collection: collectionName,
    fetched: normalizedIncomingRecords.length,
    inserted,
    updated,
    skipped,
    totalInFile: existingRecords.length,
  };
};

const computeTotalStoredRecords = (payload) =>
  (Array.isArray(payload?.data) ? payload.data : []).reduce(
    (total, collectionEntry) =>
      total + (Array.isArray(collectionEntry?.records) ? collectionEntry.records.length : 0),
    0
  );

const getRotationRecommendation = ({ fileSizeBytes }) => {
  const thresholdMb = Math.max(
    Number.parseInt(process.env.INCREMENTAL_BACKUP_ROTATION_THRESHOLD_MB || '', 10) ||
      DEFAULT_ROTATION_THRESHOLD_MB,
    50
  );
  const sizeMb = fileSizeBytes / (1024 * 1024);
  if (sizeMb <= thresholdMb) return '';
  return `Backup file is ${sizeMb.toFixed(
    2
  )} MB. Suggested strategy: archive monthly snapshots and compress archived JSON with gzip before offloading to cloud storage.`;
};

const backupSingleTenant = async ({ db, tenant, forceFull = false }) => {
  const tenantObjectId = toObjectId(tenant?._id);
  if (!tenantObjectId) {
    throw new Error('Invalid tenant identifier.');
  }

  const tenantId = String(tenantObjectId);
  const tenantName = String(tenant?.name || '').trim();
  const runStartedAt = new Date();
  console.log(
    `[incremental-backup] Start tenant backup tenantId=${tenantId} tenantName="${
      tenantName || 'Unknown'
    }" at=${runStartedAt.toISOString()}`
  );

  const existing = await readTenantBackupPayload({ tenantId, tenantName });
  const payload = existing.payload;
  const lastBackupTime = forceFull ? null : payload.lastBackupTime;
  const scope = await buildTenantScopeState({ db, tenantObjectId });
  const collectionSpecs = buildTenantCollectionSpecs(scope);

  const perCollection = [];
  for (const spec of collectionSpecs) {
    const records = await fetchCollectionIncrementalRecords({
      db,
      collectionName: spec.collection,
      baseFilter: spec.baseFilter,
      lastBackupTime,
      runStartedAt,
    });

    if (!records.length) {
      perCollection.push({
        collection: spec.collection,
        fetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        totalInFile:
          payload.data.find((entry) => entry.collection === spec.collection)?.records?.length || 0,
      });
      continue;
    }

    const merged = mergeRecordsForCollection({
      payload,
      collectionName: spec.collection,
      incomingRecords: records,
      runFinishedAt: new Date(),
    });
    perCollection.push(merged);
  }

  const totalFetched = perCollection.reduce((sum, entry) => sum + (entry.fetched || 0), 0);
  const totalInserted = perCollection.reduce((sum, entry) => sum + (entry.inserted || 0), 0);
  const totalUpdated = perCollection.reduce((sum, entry) => sum + (entry.updated || 0), 0);
  const totalSkipped = perCollection.reduce((sum, entry) => sum + (entry.skipped || 0), 0);

  payload.tenantId = tenantId;
  payload.tenantName = tenantName;
  payload.lastBackupTime = runStartedAt.toISOString();
  payload.updatedAt = toIso();
  payload.meta = {
    totalCollections: payload.data.length,
    totalRecords: computeTotalStoredRecords(payload),
    lastRun: {
      runStartedAt: runStartedAt.toISOString(),
      runFinishedAt: payload.updatedAt,
      forceFull: Boolean(forceFull),
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      skipped: totalSkipped,
    },
    rotationRecommendation: '',
  };

  await writeTenantBackupPayload({ filePath: existing.filePath, payload });
  const fileStats = await fs.stat(existing.filePath);
  const rotationRecommendation = getRotationRecommendation({
    fileSizeBytes: fileStats.size,
  });
  payload.meta.rotationRecommendation = rotationRecommendation;

  if (rotationRecommendation) {
    await writeTenantBackupPayload({ filePath: existing.filePath, payload });
  }

  const endedAt = new Date();
  console.log(
    `[incremental-backup] Completed tenant backup tenantId=${tenantId} fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} stored=${payload.meta.totalRecords} fileSize=${fileStats.size}B at=${endedAt.toISOString()}`
  );

  return {
    tenantId,
    tenantName,
    filePath: existing.filePath,
    fileSizeBytes: fileStats.size,
    startedAt: runStartedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    lastBackupTime: payload.lastBackupTime,
    forceFull: Boolean(forceFull),
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
    totalStoredRecords: payload.meta.totalRecords,
    collectionSummary: perCollection.slice(0, MAX_COLLECTION_COUNT_IN_LOG),
    rotationRecommendation,
  };
};

const resolveTenantsForBackup = async ({ tenantId = null, includeInactive = false }) => {
  const tenantObjectId = tenantId ? toObjectId(tenantId) : null;
  if (tenantId && !tenantObjectId) {
    throw new Error('tenantId must be a valid MongoDB ObjectId.');
  }

  const filter = tenantObjectId ? { _id: tenantObjectId } : {};
  if (!tenantObjectId && !includeInactive) {
    filter.status = 'ACTIVE';
  }

  const tenants = await Tenant.find(filter).select('_id name status').lean();
  if (!tenants.length) {
    if (tenantObjectId) {
      throw new Error('Tenant not found.');
    }
    return [];
  }
  return tenants;
};

export const runIncrementalBackupForTenants = async ({
  tenantId = null,
  forceFull = false,
  includeInactive = false,
} = {}) => {
  await ensureIncrementalBackupDirectories();
  const db = getCurrentDb();
  const tenants = await resolveTenantsForBackup({ tenantId, includeInactive });

  const startedAt = new Date();
  if (!tenants.length) {
    return {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      totalTenants: 0,
      successCount: 0,
      failureCount: 0,
      successes: [],
      failures: [],
    };
  }

  const successes = [];
  const failures = [];

  for (const tenant of tenants) {
    try {
      const result = await backupSingleTenant({ db, tenant, forceFull });
      successes.push(result);
    } catch (error) {
      const tenantIdValue = tenant?._id ? String(tenant._id) : '';
      const tenantNameValue = tenant?.name || '';
      console.error(
        `[incremental-backup] Tenant backup failed tenantId=${tenantIdValue} tenantName="${
          tenantNameValue || 'Unknown'
        }": ${error?.message || error}`
      );
      failures.push({
        tenantId: tenantIdValue,
        tenantName: tenantNameValue,
        error: error?.message || 'Backup failed.',
      });
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    totalTenants: tenants.length,
    successCount: successes.length,
    failureCount: failures.length,
    successes,
    failures,
  };
};

export const restoreTenantFromIncrementalBackup = async ({
  tenantId,
  batchSize = DEFAULT_UPSERT_BATCH_SIZE,
} = {}) => {
  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) {
    throw new Error('tenantId must be a valid MongoDB ObjectId.');
  }

  await ensureIncrementalBackupDirectories();
  const db = getCurrentDb();
  const normalizedTenantId = String(tenantObjectId);
  const filePath = getTenantBackupFilePathInternal(normalizedTenantId);
  if (!(await fileExists(filePath))) {
    throw new Error('Incremental backup file not found for tenant.');
  }

  const parsed = await readTenantBackupPayload({
    tenantId: normalizedTenantId,
    tenantName: '',
  });
  const payload = parsed.payload;
  const startedAt = new Date();
  console.log(
    `[incremental-backup] Start restore tenantId=${normalizedTenantId} file=${filePath} at=${startedAt.toISOString()}`
  );

  const effectiveBatchSize = Math.max(Number.parseInt(batchSize, 10) || DEFAULT_UPSERT_BATCH_SIZE, 100);
  const collectionResults = [];
  let totalProcessed = 0;
  let totalUpserted = 0;
  let totalModified = 0;
  let totalMatched = 0;

  for (const entry of payload.data || []) {
    const collectionName = String(entry?.collection || '').trim();
    const records = Array.isArray(entry?.records) ? entry.records : [];
    if (!collectionName || !records.length) {
      continue;
    }

    const collection = db.collection(collectionName);
    let processedForCollection = 0;
    let upsertedForCollection = 0;
    let modifiedForCollection = 0;
    let matchedForCollection = 0;

    for (let start = 0; start < records.length; start += effectiveBatchSize) {
      const chunk = records.slice(start, start + effectiveBatchSize);
      const operations = chunk
        .filter((record) => record && typeof record === 'object' && typeof record._id !== 'undefined')
        .map((record) => ({
          replaceOne: {
            filter: { _id: record._id },
            replacement: record,
            upsert: true,
          },
        }));

      if (!operations.length) {
        continue;
      }

      const result = await collection.bulkWrite(operations, { ordered: false });
      processedForCollection += operations.length;
      upsertedForCollection += Number(result?.upsertedCount) || 0;
      modifiedForCollection += Number(result?.modifiedCount) || 0;
      matchedForCollection += Number(result?.matchedCount) || 0;
    }

    totalProcessed += processedForCollection;
    totalUpserted += upsertedForCollection;
    totalModified += modifiedForCollection;
    totalMatched += matchedForCollection;

    collectionResults.push({
      collection: collectionName,
      processed: processedForCollection,
      upserted: upsertedForCollection,
      modified: modifiedForCollection,
      matched: matchedForCollection,
    });
  }

  const endedAt = new Date();
  console.log(
    `[incremental-backup] Completed restore tenantId=${normalizedTenantId} processed=${totalProcessed} upserted=${totalUpserted} modified=${totalModified} matched=${totalMatched} at=${endedAt.toISOString()}`
  );

  return {
    tenantId: normalizedTenantId,
    filePath,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    processed: totalProcessed,
    upserted: totalUpserted,
    modified: totalModified,
    matched: totalMatched,
    collections: collectionResults,
  };
};

export const getIncrementalBackupStatus = async ({ tenantId = null } = {}) => {
  await ensureIncrementalBackupDirectories();

  if (tenantId) {
    const tenantObjectId = toObjectId(tenantId);
    if (!tenantObjectId) {
      throw new Error('tenantId must be a valid MongoDB ObjectId.');
    }
    const resolvedTenantId = String(tenantObjectId);
    const filePath = getTenantBackupFilePathInternal(resolvedTenantId);
    if (!(await fileExists(filePath))) {
      return [];
    }
    const parsed = await readTenantBackupPayload({ tenantId: resolvedTenantId, tenantName: '' });
    const stats = await fs.stat(filePath);
    return [
      {
        tenantId: parsed.payload.tenantId,
        tenantName: parsed.payload.tenantName || '',
        filePath,
        fileSizeBytes: stats.size,
        lastBackupTime: parsed.payload.lastBackupTime,
        totalCollections: Number(parsed.payload?.meta?.totalCollections) || 0,
        totalRecords: Number(parsed.payload?.meta?.totalRecords) || 0,
        rotationRecommendation:
          String(parsed.payload?.meta?.rotationRecommendation || '') ||
          getRotationRecommendation({ fileSizeBytes: stats.size }),
      },
    ];
  }

  const entries = await fs.readdir(TENANT_BACKUP_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('tenant_') && entry.name.endsWith('.json'))
    .map((entry) => path.join(TENANT_BACKUP_DIR, entry.name));

  const statuses = [];
  for (const filePath of files) {
    try {
      const rawText = await fs.readFile(filePath, 'utf8');
      const parsed = normalizeLoadedPayload({
        rawPayload: EJSON.parse(rawText, { relaxed: false }),
        tenantId: '',
        tenantName: '',
      });
      const stats = await fs.stat(filePath);
      statuses.push({
        tenantId: parsed.tenantId || '',
        tenantName: parsed.tenantName || '',
        filePath,
        fileSizeBytes: stats.size,
        lastBackupTime: parsed.lastBackupTime || null,
        totalCollections: Number(parsed?.meta?.totalCollections) || 0,
        totalRecords: Number(parsed?.meta?.totalRecords) || 0,
        rotationRecommendation:
          String(parsed?.meta?.rotationRecommendation || '') ||
          getRotationRecommendation({ fileSizeBytes: stats.size }),
      });
    } catch (error) {
      statuses.push({
        tenantId: '',
        tenantName: '',
        filePath,
        fileSizeBytes: 0,
        lastBackupTime: null,
        totalCollections: 0,
        totalRecords: 0,
        rotationRecommendation: '',
        error: error?.message || 'Failed to parse incremental backup file.',
      });
    }
  }

  return statuses;
};
