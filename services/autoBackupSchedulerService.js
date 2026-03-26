import User from '../models/User.js';
import { createAutoTenantBackupsForActiveTenants } from './backupService.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WINDOW_START_MINUTES_IST = 2 * 60;
const WINDOW_END_MINUTES_IST = 4 * 60;
const DEFAULT_TARGET_MINUTES_IST = 2 * 60;
const MIN_TIMER_DELAY_MS = 15 * 1000;
const DEFAULT_RETRY_ATTEMPTS = 0;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_INTER_TENANT_DELAY_MS = 250;

let autoBackupTimer = null;
let schedulerStarted = false;
let runInProgress = false;
let lastAttemptedDayKey = '';

const pad = (value) => String(value).padStart(2, '0');

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isEnabled = () => {
  const raw = String(process.env.AUTO_TENANT_BACKUP_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
};

const isValidMongoId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ''));

const toIstDate = (date = new Date()) => new Date(date.getTime() + IST_OFFSET_MS);

const getIstDateParts = (date = new Date()) => {
  const istDate = toIstDate(date);
  return {
    year: istDate.getUTCFullYear(),
    monthIndex: istDate.getUTCMonth(),
    day: istDate.getUTCDate(),
    hour: istDate.getUTCHours(),
    minute: istDate.getUTCMinutes(),
  };
};

const createUtcFromIstParts = ({
  year,
  monthIndex,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
}) =>
  new Date(
    Date.UTC(year, monthIndex, day, hour, minute, second, millisecond) - IST_OFFSET_MS
  );

const getIstDateKey = (date = new Date()) => {
  const { year, monthIndex, day } = getIstDateParts(date);
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
};

const getIstDayRange = (date = new Date()) => {
  const { year, monthIndex, day } = getIstDateParts(date);
  const startUtc = createUtcFromIstParts({
    year,
    monthIndex,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const endUtc = createUtcFromIstParts({
    year,
    monthIndex,
    day: day + 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  return {
    dayKey: getIstDateKey(date),
    startUtc,
    endUtc,
  };
};

const getTargetRunMinutesIst = () => {
  const explicitMinutes = toInt(
    process.env.AUTO_TENANT_BACKUP_TARGET_MINUTES_IST,
    Number.NaN
  );
  if (
    Number.isFinite(explicitMinutes) &&
    explicitMinutes >= WINDOW_START_MINUTES_IST &&
    explicitMinutes < WINDOW_END_MINUTES_IST
  ) {
    return explicitMinutes;
  }

  const targetHour = toInt(
    process.env.AUTO_TENANT_BACKUP_TARGET_HOUR_IST,
    Math.floor(DEFAULT_TARGET_MINUTES_IST / 60)
  );
  const targetMinute = toInt(
    process.env.AUTO_TENANT_BACKUP_TARGET_MINUTE_IST,
    DEFAULT_TARGET_MINUTES_IST % 60
  );
  const normalized = targetHour * 60 + Math.min(Math.max(targetMinute, 0), 59);
  if (
    normalized >= WINDOW_START_MINUTES_IST &&
    normalized < WINDOW_END_MINUTES_IST
  ) {
    return normalized;
  }

  return DEFAULT_TARGET_MINUTES_IST;
};

const isWithinAutoBackupWindow = (date = new Date()) => {
  const { hour, minute } = getIstDateParts(date);
  const minutesOfDay = hour * 60 + minute;
  return (
    minutesOfDay >= WINDOW_START_MINUTES_IST &&
    minutesOfDay < WINDOW_END_MINUTES_IST
  );
};

const computeNextRunAt = (date = new Date()) => {
  const targetRunMinutesIst = getTargetRunMinutesIst();
  const targetHour = Math.floor(targetRunMinutesIst / 60);
  const targetMinute = targetRunMinutesIst % 60;
  const now = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const { year, monthIndex, day } = getIstDateParts(now);

  const windowStartUtc = createUtcFromIstParts({
    year,
    monthIndex,
    day,
    hour: Math.floor(WINDOW_START_MINUTES_IST / 60),
    minute: WINDOW_START_MINUTES_IST % 60,
  });
  const windowEndUtc = createUtcFromIstParts({
    year,
    monthIndex,
    day,
    hour: Math.floor(WINDOW_END_MINUTES_IST / 60),
    minute: WINDOW_END_MINUTES_IST % 60,
  });
  const targetUtcToday = createUtcFromIstParts({
    year,
    monthIndex,
    day,
    hour: targetHour,
    minute: targetMinute,
  });

  if (now < windowStartUtc) {
    return targetUtcToday;
  }
  if (now >= windowStartUtc && now < windowEndUtc) {
    if (now <= targetUtcToday) {
      return targetUtcToday;
    }
    const nowIst = toIstDate(now);
    nowIst.setUTCDate(nowIst.getUTCDate() + 1);
    return createUtcFromIstParts({
      year: nowIst.getUTCFullYear(),
      monthIndex: nowIst.getUTCMonth(),
      day: nowIst.getUTCDate(),
      hour: targetHour,
      minute: targetMinute,
    });
  }

  const nowIst = toIstDate(now);
  nowIst.setUTCDate(nowIst.getUTCDate() + 1);
  return createUtcFromIstParts({
    year: nowIst.getUTCFullYear(),
    monthIndex: nowIst.getUTCMonth(),
    day: nowIst.getUTCDate(),
    hour: targetHour,
    minute: targetMinute,
  });
};

const resolveAutomationActor = async () => {
  const configuredUserId = String(
    process.env.AUTO_TENANT_BACKUP_CREATED_BY_USER_ID || ''
  ).trim();
  if (isValidMongoId(configuredUserId)) {
    const configuredUser = await User.findById(configuredUserId)
      .select('_id role status')
      .lean();
    if (configuredUser?._id) {
      return configuredUser._id;
    }
    console.warn(
      `[auto-backup] AUTO_TENANT_BACKUP_CREATED_BY_USER_ID is set but user was not found: ${configuredUserId}`
    );
  }

  const activeSuperAdmin = await User.findOne({
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
  })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();
  if (activeSuperAdmin?._id) {
    return activeSuperAdmin._id;
  }

  const fallbackSuperAdmin = await User.findOne({ role: 'SUPER_ADMIN' })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();
  if (fallbackSuperAdmin?._id) {
    return fallbackSuperAdmin._id;
  }

  return null;
};

const runAutoTenantBackups = async () => {
  if (runInProgress) {
    console.log('[auto-backup] Previous scheduled backup run is still in progress. Skipping.');
    return;
  }

  const now = new Date();
  const { dayKey, startUtc, endUtc } = getIstDayRange(now);
  if (!isWithinAutoBackupWindow(now)) {
    console.log('[auto-backup] Skipped run outside 02:00-04:00 IST window.');
    return;
  }
  if (lastAttemptedDayKey === dayKey) {
    console.log(`[auto-backup] Already attempted backups for IST ${dayKey}. Skipping.`);
    return;
  }

  runInProgress = true;
  lastAttemptedDayKey = dayKey;

  try {
    const actorId = await resolveAutomationActor();
    if (!actorId) {
      console.error(
        '[auto-backup] No SUPER_ADMIN user found for automated backups. Configure AUTO_TENANT_BACKUP_CREATED_BY_USER_ID or create a SUPER_ADMIN account.'
      );
      return;
    }

    const retryAttempts = Math.max(
      toInt(process.env.AUTO_TENANT_BACKUP_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS),
      0
    );
    const retryDelayMs = Math.max(
      toInt(process.env.AUTO_TENANT_BACKUP_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
      0
    );
    const interBackupDelayMs = Math.max(
      toInt(
        process.env.AUTO_TENANT_BACKUP_INTER_TENANT_DELAY_MS,
        DEFAULT_INTER_TENANT_DELAY_MS
      ),
      0
    );

    const batch = await createAutoTenantBackupsForActiveTenants({
      createdBy: actorId,
      dayStartUtc: startUtc,
      dayEndUtc: endUtc,
      retryAttempts,
      retryDelayMs,
      interBackupDelayMs,
    });

    const createdCount = Array.isArray(batch?.created) ? batch.created.length : 0;
    const failedCount = Array.isArray(batch?.failed) ? batch.failed.length : 0;
    const skippedCount = Array.isArray(batch?.skipped) ? batch.skipped.length : 0;
    const totalCount = Number(batch?.total) || 0;

    if (failedCount > 0) {
      console.warn(
        `[auto-backup] Completed IST ${dayKey} with failures. total=${totalCount}, created=${createdCount}, failed=${failedCount}, skipped=${skippedCount}`
      );
      return;
    }

    console.log(
      `[auto-backup] Completed IST ${dayKey}. total=${totalCount}, created=${createdCount}, skipped=${skippedCount}`
    );
  } catch (error) {
    console.error(
      '[auto-backup] Automated tenant backup run failed:',
      error?.message || error
    );
  } finally {
    runInProgress = false;
  }
};

const scheduleNextRun = () => {
  if (!schedulerStarted) return;

  const now = new Date();
  const nextRunAt = computeNextRunAt(now);
  const delayMs = Math.max(nextRunAt.getTime() - now.getTime(), MIN_TIMER_DELAY_MS);

  if (autoBackupTimer) {
    clearTimeout(autoBackupTimer);
  }

  autoBackupTimer = setTimeout(async () => {
    await runAutoTenantBackups();
    scheduleNextRun();
  }, delayMs);

  if (typeof autoBackupTimer.unref === 'function') {
    autoBackupTimer.unref();
  }

  console.log(
    `[auto-backup] Next run scheduled at ${nextRunAt.toISOString()} (${Math.round(
      delayMs / 60000
    )} min from now).`
  );
};

export const startAutoTenantBackupScheduler = () => {
  if (!isEnabled()) {
    console.log('[auto-backup] Scheduler is disabled by AUTO_TENANT_BACKUP_ENABLED.');
    return;
  }
  if (schedulerStarted) return;
  schedulerStarted = true;
  if (isWithinAutoBackupWindow(new Date())) {
    void runAutoTenantBackups().finally(() => {
      scheduleNextRun();
    });
    return;
  }
  scheduleNextRun();
};

export const stopAutoTenantBackupScheduler = () => {
  schedulerStarted = false;
  runInProgress = false;
  lastAttemptedDayKey = '';
  if (autoBackupTimer) {
    clearTimeout(autoBackupTimer);
    autoBackupTimer = null;
  }
};
