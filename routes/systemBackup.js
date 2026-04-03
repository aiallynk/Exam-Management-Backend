import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { superAdminOnly } from '../middleware/roles.js';
import BackupHistory from '../models/BackupHistory.js';
import {
  createBackup,
  createTenantBackupsForAll,
  listBackupHistory,
  restoreBackupFromHistory,
  restoreBackupFromUploadedFile,
  parseBackupManifest,
  getBackupDownloadPath,
  deleteBackup,
} from '../services/backupService.js';
import {
  runIncrementalBackupForTenants,
  restoreTenantFromIncrementalBackup,
  getIncrementalBackupStatus,
} from '../services/incrementalBackupService.js';
import { runScheduledIncrementalBackup } from '../services/incrementalBackupSchedulerService.js';

const router = express.Router();

const backupUploadDir = path.join(os.tmpdir(), 'exam-management-backup-uploads');
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fsSync.mkdirSync(backupUploadDir, { recursive: true });
        cb(null, backupUploadDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const safeOriginal = String(file.originalname || 'uploaded_backup.zip')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
      cb(null, `${Date.now()}_${safeOriginal || 'uploaded_backup.zip'}`);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB
  },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    if (!fileName.endsWith('.zip')) {
      cb(new Error('Only ZIP backup files are allowed.'));
      return;
    }
    cb(null, true);
  },
});

const isValidMongoId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ''));
const IST_TIMEZONE = 'Asia/Kolkata';
const IST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const toIstDateTimeString = (value) => {
  if (!value) return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${IST_DATE_TIME_FORMATTER.format(parsed)} IST`;
};

const normalizeBackupType = (value) => {
  const raw = String(value || '').trim();
  if (raw === 'specific_company') return 'company';
  if (['tenant', 'tenants', 'all_tenants', 'tenant_all'].includes(raw)) return 'tenant';
  return raw;
};

const resolveCompanyId = (payload) =>
  payload?.companyId ||
  payload?.company_id ||
  payload?.tenant_id ||
  payload?.tenantId ||
  null;

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const toFormattedBackupRecord = (record) => {
  const company = record?.company_id || null;
  const createdBy = record?.created_by || null;
  const restoredBy = record?.restored_by || null;
  const normalizedType = record?.type === 'company' ? 'specific_company' : record?.type;
  const triggerType =
    String(record?.trigger_type || '').trim().toUpperCase() === 'AUTO'
      ? 'AUTO'
      : 'MANUAL';
  const resolvedPath =
    record?.storage_url_path || record?.storage_path || record?.file_path || '';
  return {
    id: record?._id || null,
    backup_name: record?.backup_name || '',
    type: normalizedType || '',
    trigger_type: triggerType,
    backup_type: triggerType,
    company_id: company?._id || company || null,
    company_name: company?.name || null,
    company_code: company?.code || null,
    company: company?.name || null,
    file_size: Number(record?.file_size) || 0,
    storage_path: resolvedPath,
    file_path: resolvedPath,
    status: record?.status || '',
    created_by: createdBy?._id || createdBy || null,
    created_by_name: triggerType === 'AUTO' ? 'System' : createdBy?.name || null,
    created_by_email: createdBy?.email || null,
    restored_by: restoredBy?._id || restoredBy || null,
    restored_by_name: restoredBy?.name || null,
    restored_by_email: restoredBy?.email || null,
    restored_at: record?.restored_at || null,
    restored_at_ist: toIstDateTimeString(record?.restored_at),
    created_at: record?.created_at || null,
    created_at_ist: toIstDateTimeString(record?.created_at),
    updated_at: record?.updated_at || null,
    error_message: record?.error_message || '',
    source_backup_id: record?.source_backup_id || null,
  };
};

const handleCreateBackup = async (req, res, next) => {
  try {
    const rawType = req.body?.type || req.body?.backup_type || req.body?.backupType || '';
    const scope = normalizeBackupType(rawType);
    if (!['full_system', 'company', 'tenant'].includes(scope)) {
      return res.status(400).json({
        error: 'type must be either full_system, specific_company, or tenant.',
      });
    }

    const companyId = resolveCompanyId(req.body);
    if (scope === 'company' && !isValidMongoId(companyId)) {
      return res.status(400).json({
        error: 'company_id is required for specific_company backup.',
      });
    }

    if (scope === 'tenant') {
      const batch = await createTenantBackupsForAll({
        createdBy: req.user?._id,
      });
      const failures = Array.isArray(batch.failed) ? batch.failed : [];

      return res.status(201).json({
        message:
          failures.length > 0
            ? 'Tenant backups created with some failures.'
            : 'Tenant backups created successfully.',
        summary: {
          total: batch.total || 0,
          created: (batch.created || []).length,
          failed: failures.length,
        },
        backups: (batch.created || []).map((entry) => toFormattedBackupRecord(entry)),
        failures,
      });
    }

    const backup = await createBackup({
      scope,
      companyId,
      createdBy: req.user?._id,
    });

    return res.status(201).json({
      message: 'Backup created successfully.',
      backup: toFormattedBackupRecord(backup),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/system/backup
 * Create a full system, specific company, or tenant-wide backup batch.
 */
router.post('/backup', requireAuth, superAdminOnly, handleCreateBackup);

/**
 * POST /api/admin/system/backups/create
 * Alias for creating backups (kept for frontend/client compatibility).
 */
router.post('/backups/create', requireAuth, superAdminOnly, handleCreateBackup);

/**
 * GET /api/admin/system/backups
 * List backup history.
 */
router.get('/backups', requireAuth, superAdminOnly, async (req, res, next) => {
  try {
    const type = normalizeBackupType(req.query?.type);
    const companyId = resolveCompanyId(req.query);
    const history = await listBackupHistory({
      page: req.query?.page,
      limit: req.query?.limit,
      type: type || undefined,
      companyId: companyId || undefined,
      status: req.query?.status,
      triggerType: req.query?.trigger_type || req.query?.backup_type,
      startDate: req.query?.startDate || req.query?.fromDate,
      endDate: req.query?.endDate || req.query?.toDate,
      search: req.query?.search || req.query?.q,
    });

    const backups = (history.items || []).map((entry) => toFormattedBackupRecord(entry));
    if (req.baseUrl === '/api/admin') {
      return res.json(backups);
    }

    res.json({
      backups,
      pagination: history.pagination,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/system/backups/:backupId/download
 * Download a backup ZIP.
 */
router.get('/backups/:backupId/download', requireAuth, superAdminOnly, async (req, res, next) => {
  try {
    const { backupId } = req.params;
    if (!isValidMongoId(backupId)) {
      return res.status(400).json({ error: 'backupId must be a valid ID.' });
    }

    const backup = await BackupHistory.findById(backupId).lean();
    if (!backup) {
      return res.status(404).json({ error: 'Backup not found.' });
    }

    const backupFilePath = getBackupDownloadPath(backup);
    if (!backupFilePath) {
      return res.status(404).json({ error: 'Backup file path is invalid.' });
    }

    try {
      await fs.access(backupFilePath);
    } catch {
      return res.status(404).json({ error: 'Backup file does not exist.' });
    }

    return res.download(backupFilePath, backup.backup_name || 'backup.zip');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/system/backups/:backupId/restore
 * Restore a backup from history.
 */
router.post('/backups/:backupId/restore', requireAuth, superAdminOnly, async (req, res, next) => {
  try {
    const { backupId } = req.params;
    if (!isValidMongoId(backupId)) {
      return res.status(400).json({ error: 'backupId must be a valid ID.' });
    }

    const restored = await restoreBackupFromHistory({
      backupId,
      initiatedBy: req.user?._id,
    });

    res.json({
      message:
        'Backup restored successfully. Current data was overwritten and a pre-restore safety backup was created.',
      restore: {
        scope: restored?.manifest?.scope_type || 'full_system',
        company_id: restored?.manifest?.company_id || null,
        company_name: restored?.manifest?.company_name || null,
        inserted_collections: restored?.inserted_collections || [],
        safety_backup: toFormattedBackupRecord(restored?.safety_backup),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/system/restore
 * Restore a backup from uploaded ZIP file.
 */
router.post('/restore', requireAuth, superAdminOnly, backupUpload.single('backup_file'), async (req, res, next) => {
  const uploadedFilePath = req.file?.path;

  try {
    if (!uploadedFilePath) {
      return res.status(400).json({ error: 'backup_file is required.' });
    }

    const manifest = await parseBackupManifest({ zipPath: uploadedFilePath });
    const restored = await restoreBackupFromUploadedFile({
      uploadedZipPath: uploadedFilePath,
      initiatedBy: req.user?._id,
    });

    res.json({
      message:
        'Uploaded backup restored successfully. Current data was overwritten and a pre-restore safety backup was created.',
      uploaded_manifest: {
        type: manifest?.type || '',
        scope_type: manifest?.scope_type || '',
        company_id: manifest?.company_id || null,
        company_name: manifest?.company_name || null,
        created_at: manifest?.created_at || null,
      },
      restore: {
        scope: restored?.manifest?.scope_type || 'full_system',
        company_id: restored?.manifest?.company_id || null,
        company_name: restored?.manifest?.company_name || null,
        inserted_collections: restored?.inserted_collections || [],
        safety_backup: toFormattedBackupRecord(restored?.safety_backup),
      },
    });
  } catch (error) {
    next(error);
  } finally {
    if (uploadedFilePath) {
      await fs.rm(uploadedFilePath, { force: true });
    }
  }
});

/**
 * GET /api/admin/system/incremental-backup/status
 * View incremental JSON backup status (all tenants or single tenant).
 */
router.get('/incremental-backup/status', requireAuth, superAdminOnly, async (req, res, next) => {
  try {
    const tenantId = req.query?.tenantId || req.query?.tenant_id || null;
    if (tenantId && !isValidMongoId(tenantId)) {
      return res.status(400).json({ error: 'tenantId must be a valid ID.' });
    }

    const status = await getIncrementalBackupStatus({ tenantId: tenantId || null });
    return res.json({
      message: 'Incremental backup status fetched successfully.',
      count: status.length,
      status,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/system/incremental-backup/run
 * Manual trigger for incremental tenant backup.
 */
router.post('/incremental-backup/run', requireAuth, superAdminOnly, async (req, res, next) => {
  try {
    const tenantId = req.body?.tenantId || req.body?.tenant_id || null;
    if (tenantId && !isValidMongoId(tenantId)) {
      return res.status(400).json({ error: 'tenantId must be a valid ID.' });
    }

    const forceFull = toBoolean(req.body?.forceFull ?? req.body?.force_full, false);
    const includeInactive = toBoolean(
      req.body?.includeInactive ?? req.body?.include_inactive,
      false
    );
    const respectDailyGuard = toBoolean(
      req.body?.respectDailyGuard ?? req.body?.respect_daily_guard,
      false
    );

    // Optional mode to reuse scheduler's once-per-day IST guard.
    if (respectDailyGuard && !tenantId) {
      const forceRun = toBoolean(req.body?.forceRun ?? req.body?.force_run, false);
      const scheduled = await runScheduledIncrementalBackup({
        force: forceRun,
        forceFull,
      });
      return res.json({
        message: scheduled?.skipped
          ? 'Incremental backup skipped by daily guard.'
          : 'Incremental backup completed successfully.',
        result: scheduled,
      });
    }

    const summary = await runIncrementalBackupForTenants({
      tenantId: tenantId || null,
      forceFull,
      includeInactive,
    });

    return res.json({
      message:
        summary.failureCount > 0
          ? 'Incremental backup completed with some failures.'
          : 'Incremental backup completed successfully.',
      summary,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/system/incremental-backup/:tenantId/restore
 * Restore tenant data from tenant incremental backup JSON using UPSERT.
 */
router.post(
  '/incremental-backup/:tenantId/restore',
  requireAuth,
  superAdminOnly,
  async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      if (!isValidMongoId(tenantId)) {
        return res.status(400).json({ error: 'tenantId must be a valid ID.' });
      }

      const batchSize = Number.parseInt(req.body?.batchSize ?? req.body?.batch_size ?? '', 10);
      const restoreResult = await restoreTenantFromIncrementalBackup({
        tenantId,
        batchSize: Number.isFinite(batchSize) ? batchSize : undefined,
      });

      return res.json({
        message: 'Tenant restored successfully from incremental backup.',
        restore: restoreResult,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/admin/system/backups/:backupId
 * Delete a backup and its file.
 */
router.delete('/backups/:backupId', requireAuth, superAdminOnly, async (req, res, next) => {
  try {
    const { backupId } = req.params;
    if (!isValidMongoId(backupId)) {
      return res.status(400).json({ error: 'backupId must be a valid ID.' });
    }

    const deleted = await deleteBackup({ backupId });
    res.json({
      message: 'Backup deleted successfully.',
      backup: deleted,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
