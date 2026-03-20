import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
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
import resultRoutes from './routes/results.js';
import candidateRoutes from './routes/candidates.js'; // Universal: renamed from student.js
import adminRoutes from './routes/admin.js';
import systemBackupRoutes from './routes/systemBackup.js';
import uploadRoutes from './routes/upload.js';
import aiRoutes from './routes/ai.js';
import superAdminRoutes from './routes/superAdmin.js';
import tenantAdminRoutes from './routes/tenantAdmin.js';
import languageRoutes from './routes/languages.js';
import sectionRoutes from './routes/sections.js';
import normalizationRoutes from './routes/normalization.js';
import answerKeyRoutes from './routes/answerKeys.js';
import analyticsRoutes from './routes/analytics.js';
import auditLogRoutes from './routes/auditLogs.js';
import proctoringRoutes from './routes/proctoring.js';
import examPackageRoutes from './routes/examPackages.js';
import omrRoutes from './routes/omr.js';
import compilerRoutes from './routes/compiler.js';
import notificationRoutes from './routes/notifications.js';
import systemAlertRoutes from './routes/systemAlerts.js';
import { startSubscriptionExpiryScheduler } from './services/subscriptionLifecycleService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

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
app.use(requestLogger);

// Apply CSRF protection to API routes (state-changing requests)
app.use('/api', csrfProtection);

// Apply general API rate limiting to all /api routes
app.use('/api', apiRateLimiter);

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

// API Routes with specific rate limiting
// Auth routes - strict rate limiting to prevent brute force
app.use('/api/auth', authRateLimiter, authRoutes);

// Upload routes - strict rate limiting to prevent storage abuse
app.use('/api/upload', uploadRateLimiter, uploadRoutes);

// Other API routes (already have general apiRateLimiter applied above)
// Note: AI-specific rate limiting is applied within aiRoutes
// AI routes - available at both /api/ai and /api/exams for backward compatibility
app.use('/api/ai', aiRoutes);
// Exams routes - no rate limiting (skipped in apiRateLimiter)
app.use('/api/exams', examRoutes);
app.use('/api/exams', questionRoutes);
app.use('/api/exams', questionPaperRoutes);
app.use('/api/exams', aiRoutes); // Keep AI routes at /api/exams for backward compatibility
app.use('/api/exam-sessions', sessionRoutes);
app.use('/api/exam-attempts', attemptRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/candidates', candidateRoutes); // Universal: renamed from /api/student to /api/candidates
app.use('/api/admin/system', systemBackupRoutes);
app.use('/api/admin', systemBackupRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/super-admin/system-alerts', systemAlertRoutes);
app.use('/api/tenant-admin', tenantAdminRoutes);
app.use('/api/languages', languageRoutes);
app.use('/api/sections', sectionRoutes);
app.use('/api/normalization', normalizationRoutes);
app.use('/api/answer-keys', answerKeyRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/proctoring', proctoringRoutes);
app.use('/api/exam-packages', examPackageRoutes);
app.use('/api/omr', omrRoutes);
app.use('/api/compiler', compilerRoutes);
app.use('/api/code', compilerRoutes);
app.use('/api/notifications', notificationRoutes);

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
const startServer = async () => {
  try {
    await connect();
    startSubscriptionExpiryScheduler();
    app.listen(config.port, () => {
      console.log(`🚀 Server running on http://localhost:${config.port}`);
      console.log(`📊 Environment: ${config.nodeEnv}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;

