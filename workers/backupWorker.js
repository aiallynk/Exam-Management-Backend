import { connect } from '../utils/db.js';
import { assertBackupConfiguration, refreshBackupConfiguration } from '../services/backup/backupConfiguration.js';
import { createBackupWorkers } from '../services/backup/backupWorkerService.js';
import { createRestoreWorkers } from '../services/backup/restoreWorkerService.js';
import { startBackupScheduleService, stopBackupScheduleService } from '../services/backup/backupScheduleService.js';
import { closeBackupQueues } from '../services/backup/backupQueueService.js';

const start = async () => { await connect(); await refreshBackupConfiguration(); assertBackupConfiguration(); const workers = [...createBackupWorkers(), ...createRestoreWorkers()]; startBackupScheduleService(); const stop = async () => { stopBackupScheduleService(); await Promise.all(workers.map((worker) => worker.close())); await closeBackupQueues(); process.exit(0); }; process.once('SIGTERM', stop); process.once('SIGINT', stop); console.log(`[backup-worker] started ${workers.length} workers`); };
start().catch((error) => { console.error('[backup-worker] failed to start:', error.message || error); process.exit(1); });
