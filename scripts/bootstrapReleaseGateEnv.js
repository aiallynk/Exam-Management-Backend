#!/usr/bin/env node
/**
 * Disposable MongoDB + Redis release-gate environment bootstrap (DRY RUN by default).
 * Does NOT connect to shared/production MongoDB. Requires explicit TEST_MONGODB_URI.
 *
 * Usage:
 *   NODE_ENV=test TEST_MONGODB_URI=mongodb://127.0.0.1:27017/xamigo_phase5_e2e_release node scripts/bootstrapReleaseGateEnv.js
 */
import { assertDisposableTestDatabase } from '../utils/testDatabaseSafety.js';

const redisUrl = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379';

try {
  const mongo = assertDisposableTestDatabase({
    nodeEnv: process.env.NODE_ENV,
    uri: process.env.TEST_MONGODB_URI,
  });
  console.log('[release-gate] Disposable MongoDB target validated:', mongo.databaseName, mongo.hosts.join(','));
  console.log('[release-gate] Redis target (informational):', redisUrl.replace(/\/\/.*@/, '//***@'));
  console.log('[release-gate] No migration or seed was executed. Set RUN_RELEASE_GATE_SEED=1 to run hierarchy matrix seed in a future step.');
  process.exit(0);
} catch (error) {
  console.error('[release-gate] Environment rejected:', error.message);
  process.exit(1);
}
