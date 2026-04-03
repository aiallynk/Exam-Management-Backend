import { connect, disconnect } from '../utils/db.js';
import {
  queueExistingExamPackageBackfill,
  waitForExamPackageRegenerationDrain,
} from '../services/examPackageRegenerationService.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const runBackfill = async () => {
  const batchSize = parsePositiveInt(process.env.EXAM_PACKAGE_BACKFILL_BATCH_SIZE, 100);
  const timeoutMs = parsePositiveInt(process.env.EXAM_PACKAGE_BACKFILL_TIMEOUT_MS, 10 * 60 * 1000);
  const limit = parsePositiveInt(process.env.EXAM_PACKAGE_BACKFILL_LIMIT, 0);

  await connect();

  try {
    const queuedResult = await queueExistingExamPackageBackfill({
      batchSize,
      limit: limit > 0 ? limit : null,
    });

    console.log(
      `[EXAM_PACKAGE_BACKFILL] queued scanned=${queuedResult.scanned} queued=${queuedResult.queued} skipped=${queuedResult.skipped}`
    );

    const drainResult = await waitForExamPackageRegenerationDrain({
      timeoutMs,
      pollIntervalMs: 250,
    });

    if (drainResult.drained) {
      console.log('[EXAM_PACKAGE_BACKFILL] completed successfully');
      return;
    }

    console.warn(
      `[EXAM_PACKAGE_BACKFILL] timeout waiting for queue drain (inFlight=${drainResult.inFlight}, pending=${drainResult.pending})`
    );
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
};

runBackfill().catch((error) => {
  console.error('[EXAM_PACKAGE_BACKFILL] failed:', error);
  process.exitCode = 1;
});
