import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import config from './config/env.js';
import { connect } from './utils/db.js';
import { requestLogger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/error.js';
import { authRateLimiter, apiRateLimiter, aiRateLimiter, uploadRateLimiter } from './middleware/rateLimiter.js';
import { csrfProtection } from './middleware/csrf.js';
import { requestTimeout } from './middleware/timeout.js';
import { requestContextMiddleware } from './middleware/requestContext.js';

// Import routes
import authRoutes from './routes/auth.js';
import examRoutes from './routes/exams.js';
import questionRoutes from './routes/questions.js';
import questionPaperRoutes from './routes/questionPapers.js';
import sessionRoutes from './routes/sessions.js';
import attemptRoutes from './routes/attempts.js';
import examinerAssignmentRoutes from './routes/examinerAssignments.js';
import examEvaluatorRoutes from './routes/examEvaluators.js';
import resultRoutes from './routes/results.js';
import candidateRoutes from './routes/candidates.js'; // Universal: renamed from student.js
import adminRoutes from './routes/admin.js';
import systemBackupRoutes from './routes/systemBackup.js';
import uploadRoutes from './routes/upload.js';
import aiRoutes from './routes/ai.js';
import superAdminRoutes from './routes/superAdmin.js';
import tenantAdminRoutes from './routes/tenantAdmin.js';
import tenantFeatureRoutes from './routes/tenantFeatures.js';
import tenantEvaluatorRoutes from './routes/tenantEvaluators.js';
import languageRoutes from './routes/languages.js';
import sectionRoutes from './routes/sections.js';
import normalizationRoutes from './routes/normalization.js';
import answerKeyRoutes from './routes/answerKeys.js';
import analyticsRoutes from './routes/analytics.js';
import auditLogRoutes from './routes/auditLogs.js';
import proctoringRoutes from './routes/proctoring.js';
import examPackageRoutes from './routes/examPackages.js';
import examPackageStatusRoutes from './routes/examPackageStatus.js';
import omrRoutes from './routes/omr.js';
import compilerRoutes from './routes/compiler.js';
import notificationRoutes from './routes/notifications.js';
import systemAlertRoutes from './routes/systemAlerts.js';
import publicRoutes from './routes/public.js';
import wizKidsRoutes from './routes/wizKids.js';
import wizKidsBatchesRoutes from './routes/wizKidsBatches.js';
import wizKidsExamsRoutes from './routes/wizKidsExams.js';
import wizKidsQuestionBankRoutes from './routes/wizKidsQuestionBank.js';
import wizKidsPracticeRoutes from './routes/wizKidsPractice.js';
import wizKidsSpeedRoutes from './routes/wizKidsSpeed.js';
import wizKidsGeneratorRoutes from './routes/wizKidsGenerator.js';
import wizKidsAnalyticsRoutes from './routes/wizKidsAnalytics.js';
import wizKidsGamificationRoutes from './routes/wizKidsGamification.js';
import wizKidsCandidateRoutes from './routes/wizKidsCandidate.js';
import wizKidsTestCompletionRoutes from './routes/wizKidsTestCompletion.js';
import wizKidsFlashMathsRoutes from './routes/wizKidsFlashMaths.js';
import { startSubscriptionExpiryScheduler } from './services/subscriptionLifecycleService.js';
import { startAutoTenantBackupScheduler } from './services/autoBackupSchedulerService.js';
import { startIncrementalBackupScheduler } from './services/incrementalBackupSchedulerService.js';
import { queueExistingExamPackageBackfillOnStartup } from './services/examPackageRegenerationService.js';
import { getBackupConfiguration, refreshBackupConfiguration } from './services/backup/backupConfiguration.js';
import {
  superAdminBackupsRouter,
  tenantAdminBackupsRouter,
  superAdminBackupSchedulesRouter,
  tenantAdminBackupSchedulesRouter,
  superAdminRestoresRouter,
  tenantAdminRestoresRouter,
  backupStorageSettingsRouter,
  backupJobsRouter,
} from './routes/backupManagement.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const resolveLanIp = () => {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
};

// Fast liveness endpoint for connectivity checks (no DB dependency).
app.get('/ping', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'pong',
    timestamp: new Date().toISOString(),
  });
});

// Middleware
// Compression middleware - compress responses for better performance
app.use(compression({
  filter: (req, res) => {
    // Don't compress if client doesn't support it or if response is already compressed
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Use compression for all text-based responses
    return compression.filter(req, res);
  },
  level: 6, // Compression level (1-9, 6 is a good balance)
}));

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
// CORS: allow multiple origins (comma-separated), localhost (dev only), and Vercel previews
const buildCorsOrigin = () => {
  const normalizeOrigin = (value) => {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  };

  const defaults = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
  ].map(normalizeOrigin).filter(Boolean);
  const configured = (config.corsOrigin || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  const allowed = Array.from(new Set([...configured, ...defaults]));
  const isDevelopment = config.nodeEnv === 'development';
  
  // Allowed localhost ports (only in development)
  const allowedLocalhostPorts = [5173, 5174, 3000, 3001, 4000, 4001, 5000, 5001, 8080, 8081];
  
  return (origin, callback) => {
    if (!origin) return callback(null, true); // allow non-browser requests
    const normalizedOrigin = normalizeOrigin(origin);
    
    // Allow exact matches
    if (allowed.includes(normalizedOrigin)) return callback(null, true);
    
    // Allow localhost only in development mode and only for specific ports
    if (isDevelopment) {
      try {
        const url = new URL(normalizedOrigin);
        const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
        
        if (
          (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
          allowedLocalhostPorts.includes(port)
        ) {
          return callback(null, true);
        }
      } catch (e) {
        // Invalid URL, continue to other checks
      }
    }
    
    // Allow any Vercel preview/production subdomain if a *.vercel.app is configured
    try {
      const allowVercelWildcard = allowed.some((o) => o.endsWith('.vercel.app'));
      const allowDevTunnelWildcard =
        isDevelopment && allowed.some((o) => o.endsWith('.devtunnels.ms'));
      if (allowVercelWildcard) {
        const url = new URL(normalizedOrigin);
        if (/\.vercel\.app$/.test(url.hostname)) {
          return callback(null, true);
        }
      }
      if (allowDevTunnelWildcard) {
        const url = new URL(normalizedOrigin);
        if (/\.devtunnels\.ms$/.test(url.hostname)) {
          return callback(null, true);
        }
      }
    } catch (e) {
      // Invalid URL, continue to rejection
    }
    
    return callback(new Error('Not allowed by CORS'));
  };
};
app.use(
  cors({
    origin: buildCorsOrigin(),
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(requestTimeout(30000)); // 30 second timeout for all requests
app.use(requestContextMiddleware);
app.use((req, _res, next) => {
  if (config.nodeEnv !== 'production') {
    console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  }
  next();
});
app.use(requestLogger);

const API_BASE_PATHS = ['/api', '/api/v1'];

// Apply shared middleware to all supported API versions.
API_BASE_PATHS.forEach((basePath) => {
  app.use(basePath, csrfProtection);
  app.use(basePath, apiRateLimiter);
});

const uploadsPath = path.isAbsolute(config.uploadDir)
  ? config.uploadDir
  : path.join(__dirname, config.uploadDir);
app.use('/uploads', express.static(uploadsPath));

// Health check with database connectivity verification
app.get('/health', async (req, res) => {
  try {
    const mongoose = (await import('mongoose')).default;
    const dbState = mongoose.connection.readyState;
    
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const isConnected = dbState === 1;
    
    if (!isConnected) {
      return res.status(503).json({
        status: 'unhealthy',
        database: 'disconnected',
        dbState,
        timestamp: new Date().toISOString(),
      });
    }
    
    // Optional: Ping database to ensure it's responsive
    try {
      await mongoose.connection.db.admin().ping();
    } catch (pingError) {
      return res.status(503).json({
        status: 'unhealthy',
        database: 'unresponsive',
        error: pingError.message,
        timestamp: new Date().toISOString(),
      });
    }
    
    res.json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

const registerApiRoutes = (basePath) => {
  // API Routes with specific rate limiting
  // Auth routes - strict rate limiting to prevent brute force
  app.use(`${basePath}/auth`, authRateLimiter, authRoutes);
  app.use(`${basePath}/public`, publicRoutes);

  // Upload routes - strict rate limiting to prevent storage abuse
  app.use(`${basePath}/upload`, uploadRateLimiter, uploadRoutes);

  // Other API routes (already have general apiRateLimiter applied above)
  // Note: AI-specific rate limiting is applied within aiRoutes
  // AI routes - available at both /api/ai and /api/exams for backward compatibility
  app.use(`${basePath}/ai`, aiRoutes);
  // Exams routes - no rate limiting (skipped in apiRateLimiter)
  app.use(`${basePath}/exams`, examRoutes);
  app.use(`${basePath}/exams`, questionRoutes);
  app.use(`${basePath}/exams`, questionPaperRoutes);
  app.use(`${basePath}/exams`, examEvaluatorRoutes);
  app.use(`${basePath}/exams`, aiRoutes); // Keep AI routes at /api/exams for backward compatibility
  app.use(`${basePath}/exam-sessions`, sessionRoutes);
  app.use(`${basePath}/exam-attempts`, attemptRoutes);
  app.use(`${basePath}/examiner-assignments`, examinerAssignmentRoutes);
  app.use(`${basePath}/results`, resultRoutes);
  app.use(`${basePath}/candidates`, candidateRoutes); // Universal: renamed from /api/student to /api/candidates
  app.use(`${basePath}/admin/system`, systemBackupRoutes);
  app.use(`${basePath}/admin`, systemBackupRoutes);
  app.use(`${basePath}/admin`, adminRoutes);
  app.use(`${basePath}/super-admin`, superAdminRoutes);
  app.use(`${basePath}/super-admin/system-alerts`, systemAlertRoutes);
  app.use(`${basePath}/tenant-admin`, tenantAdminRoutes);
  app.use(`${basePath}/tenant/features`, tenantFeatureRoutes);
  app.use(`${basePath}/tenant/evaluators`, tenantEvaluatorRoutes);
  app.use(`${basePath}/languages`, languageRoutes);
  app.use(`${basePath}/sections`, sectionRoutes);
  app.use(`${basePath}/normalization`, normalizationRoutes);
  app.use(`${basePath}/answer-keys`, answerKeyRoutes);
  app.use(`${basePath}/analytics`, analyticsRoutes);
  app.use(`${basePath}/audit-logs`, auditLogRoutes);
  app.use(`${basePath}/proctoring`, proctoringRoutes);
  app.use(`${basePath}/exam-packages`, examPackageRoutes);
  app.use(`${basePath}/exam`, examPackageStatusRoutes);
  app.use(`${basePath}/omr`, omrRoutes);
  app.use(`${basePath}/compiler`, compilerRoutes);
  app.use(`${basePath}/code`, compilerRoutes);
  app.use(`${basePath}/notifications`, notificationRoutes);
  app.use(`${basePath}/wizkids`, wizKidsRoutes);
  app.use(`${basePath}/wizkids/batches`, wizKidsBatchesRoutes);
  app.use(`${basePath}/wizkids/exams`, wizKidsExamsRoutes);
  app.use(`${basePath}/wizkids/question-bank`, wizKidsQuestionBankRoutes);
  app.use(`${basePath}/wizkids/attempts`, wizKidsPracticeRoutes);
  app.use(`${basePath}/wizkids/attempts`, wizKidsSpeedRoutes);
  app.use(`${basePath}/wizkids/attempts`, wizKidsTestCompletionRoutes);
  app.use(`${basePath}/wizkids/generator`, wizKidsGeneratorRoutes);
  app.use(`${basePath}/wizkids/analytics`, wizKidsAnalyticsRoutes);
  app.use(`${basePath}/wizkids/gamification`, wizKidsGamificationRoutes);
  app.use(`${basePath}/wizkids/candidate`, wizKidsCandidateRoutes);
  app.use(`${basePath}/wizkids/flash-maths`, wizKidsFlashMathsRoutes);

  // New backup/restore APIs are intentionally canonical and v1-only. Legacy local-file
  // endpoints remain mounted above only as a temporary migration compatibility path.
  if (basePath === '/api/v1') {
    app.use(`${basePath}/super-admin/backups`, superAdminBackupsRouter);
    app.use(`${basePath}/tenant-admin/backups`, tenantAdminBackupsRouter);
    app.use(`${basePath}/super-admin/backup-schedules`, superAdminBackupSchedulesRouter);
    app.use(`${basePath}/tenant-admin/backup-schedules`, tenantAdminBackupSchedulesRouter);
    app.use(`${basePath}/super-admin/restores`, superAdminRestoresRouter);
    app.use(`${basePath}/tenant-admin/restores`, tenantAdminRestoresRouter);
    app.use(`${basePath}/super-admin/backup-storage-settings`, backupStorageSettingsRouter);
    app.use(`${basePath}/jobs`, backupJobsRouter);
  }
};

API_BASE_PATHS.forEach(registerApiRoutes);
API_BASE_PATHS.forEach((basePath) => {
  app.get(`${basePath}/ping`, (_req, res) => {
    res.status(200).json({
      status: 'ok',
      message: 'pong',
      timestamp: new Date().toISOString(),
    });
  });
});

// Error handling
app.use(notFound);
app.use(errorHandler);

const startHttpServer = () =>
  new Promise((resolve, reject) => {
    const configuredHost = String(config.host || '').trim().toLowerCase();
    const isLoopbackHost =
      configuredHost === 'localhost' ||
      configuredHost === '127.0.0.1' ||
      configuredHost === '::1';
    const listenHost = isLoopbackHost ? '0.0.0.0' : config.host;

    if (isLoopbackHost) {
      console.warn(
        `[SERVER] HOST="${config.host}" binds loopback only. Overriding to "${listenHost}" for device accessibility.`,
      );
    }

    const server = app.listen(config.port, listenHost, () => {
      resolve(server);
    });
    server.once('error', reject);
  });

// Start server
const startServer = async () => {
  try {
    await connect();
    await refreshBackupConfiguration();
    await startHttpServer();
    queueExistingExamPackageBackfillOnStartup();
    startSubscriptionExpiryScheduler();
    if (!getBackupConfiguration().enabled) {
      startAutoTenantBackupScheduler();
      startIncrementalBackupScheduler();
    } else {
      console.log('[backup] Legacy local-disk backup schedulers are disabled; use the dedicated backup worker.');
    }
    const lanIp = resolveLanIp();
    console.log(`LAN URL: http://${lanIp || '127.0.0.1'}:${config.port}`);
    console.log(`Bound host: ${config.host}`);
    console.log(`Preferred mobile URL: http://${lanIp || 'YOUR_LAN_IP'}:${config.port}/api`);
    console.log(`🚀 Server running on http://localhost:${config.port}`);
    console.log(`📊 Environment: ${config.nodeEnv}`);
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `❌ Port ${config.port} is already in use. Stop the existing process or set a different PORT in .env.`,
      );
    }
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
