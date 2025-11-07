import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/env.js';
import { connect } from './utils/db.js';
import { requestLogger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/error.js';

// Import routes
import authRoutes from './routes/auth.js';
import examRoutes from './routes/exams.js';
import questionRoutes from './routes/questions.js';
import questionPaperRoutes from './routes/questionPapers.js';
import sessionRoutes from './routes/sessions.js';
import attemptRoutes from './routes/attempts.js';
import resultRoutes from './routes/results.js';
import studentRoutes from './routes/student.js';
import adminRoutes from './routes/admin.js';
import uploadRoutes from './routes/upload.js';
import aiRoutes from './routes/ai.js';

const app = express();

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/exams', questionRoutes);
app.use('/api/exams', questionPaperRoutes);
app.use('/api/exam-sessions', sessionRoutes);
app.use('/api/exam-attempts', attemptRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/exams', aiRoutes);

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
const startServer = async () => {
  try {
    await connect();
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

