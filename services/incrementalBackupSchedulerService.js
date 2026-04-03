import cron from 'node-cron';
import SystemConfig from '../models/SystemConfig.js';
import { runIncrementalBackupForTenants } from './incrementalBackupService.js';

const IST_TIMEZONE = 'Asia/Kolkata';
const WINDOW_START_MINUTE_IST = 2 * 60; // 02:00
const WINDOW_END_MINUTE_IST = 3 * 60; // 03:00
const LAST_RUN_DAY_CONFIG_KEY = 'incremental_backup_last_run_ist_day';

let cronTask = null;
let schedulerStarted = false;
let runInProgress = false;

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isEnabled = () => {
  const raw = String(process.env.INCREMENTAL_BACKUP_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
};

const IST_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const IST_HOUR_MINUTE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const getIstDayKey = (date = new Date()) => IST_DAY_FORMATTER.format(date);

const getIstMinutesOfDay = (date = new Date()) => {
  const parts = IST_HOUR_MINUTE_FORMATTER.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
  const hour = Number(parts.hour) || 0;
  const minute = Number(parts.minute) || 0;
  return hour * 60 + minute;
};

const isWithinExecutionWindow = (date = new Date()) => {
  const minutes = getIstMinutesOfDay(date);
  return minutes >= WINDOW_START_MINUTE_IST && minutes < WINDOW_END_MINUTE_IST;
};

const resolveSchedule = () => {
  const minute = Math.min(Math.max(toInt(process.env.INCREMENTAL_BACKUP_CRON_MINUTE, 15), 0), 59);
  const requestedHour = toInt(process.env.INCREMENTAL_BACKUP_CRON_HOUR_IST, 2);

  // Requirement: run in the 02:00-03:00 IST window.
  const hour = requestedHour >= 2 && requestedHour < 3 ? requestedHour : 2;
  return { hour, minute, expression: `${minute} ${hour} * * *` };
};

const acquireDailyRunToken = async (dayKey, { force = false } = {}) => {
  if (force) {
    return { acquired: true, reason: 'force' };
  }

  try {
    const result = await SystemConfig.updateOne(
      {
        key: LAST_RUN_DAY_CONFIG_KEY,
        value: { $ne: String(dayKey) },
      },
      {
        $set: {
          value: String(dayKey),
          description:
            'Tracks the last IST day key for successful incremental backup scheduler runs.',
        },
      },
      { upsert: true }
    );

    const updated = Number(result?.modifiedCount) > 0 || Number(result?.upsertedCount) > 0;
    if (updated) {
      return { acquired: true, reason: 'updated' };
    }
    return { acquired: false, reason: 'already_ran_for_day' };
  } catch (error) {
    if (error?.code === 11000) {
      return { acquired: false, reason: 'already_ran_for_day' };
    }
    throw error;
  }
};

export const runScheduledIncrementalBackup = async ({
  force = false,
  forceFull = false,
} = {}) => {
  if (runInProgress) {
    console.log('[incremental-backup] Previous scheduled run is still in progress. Skipping.');
    return {
      skipped: true,
      reason: 'run_in_progress',
    };
  }

  runInProgress = true;
  const startedAt = new Date();

  try {
    const dayKey = getIstDayKey(startedAt);
    const lock = await acquireDailyRunToken(dayKey, { force });
    if (!lock.acquired) {
      console.log(`[incremental-backup] Skipping scheduled run for IST day ${dayKey}. Reason=${lock.reason}`);
      return {
        skipped: true,
        reason: lock.reason,
        dayKey,
      };
    }

    console.log(
      `[incremental-backup] Scheduled run started for IST day ${dayKey} at ${startedAt.toISOString()}`
    );
    const summary = await runIncrementalBackupForTenants({
      forceFull: Boolean(forceFull),
      includeInactive: false,
    });

    console.log(
      `[incremental-backup] Scheduled run completed for IST day ${dayKey}. total=${summary.totalTenants} success=${summary.successCount} failed=${summary.failureCount}`
    );

    return {
      skipped: false,
      dayKey,
      ...summary,
    };
  } catch (error) {
    console.error(
      `[incremental-backup] Scheduled run failed: ${error?.message || error}`
    );
    throw error;
  } finally {
    runInProgress = false;
  }
};

export const startIncrementalBackupScheduler = () => {
  if (!isEnabled()) {
    console.log('[incremental-backup] Scheduler is disabled by INCREMENTAL_BACKUP_ENABLED.');
    return;
  }
  if (schedulerStarted) return;

  const schedule = resolveSchedule();
  if (!cron.validate(schedule.expression)) {
    throw new Error(
      `Invalid incremental backup cron expression "${schedule.expression}". Check INCREMENTAL_BACKUP_CRON_* env vars.`
    );
  }

  cronTask = cron.schedule(
    schedule.expression,
    () => {
      void runScheduledIncrementalBackup();
    },
    { timezone: IST_TIMEZONE }
  );

  schedulerStarted = true;
  console.log(
    `[incremental-backup] Scheduler started. cron="${schedule.expression}" timezone=${IST_TIMEZONE}`
  );

  // If the server boots inside the execution window, try to run immediately.
  if (isWithinExecutionWindow(new Date())) {
    void runScheduledIncrementalBackup();
  }
};

export const stopIncrementalBackupScheduler = () => {
  schedulerStarted = false;
  runInProgress = false;
  if (cronTask) {
    cronTask.stop();
    cronTask.destroy();
    cronTask = null;
  }
};

