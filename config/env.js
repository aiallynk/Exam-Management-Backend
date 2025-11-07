import dotenv from 'dotenv';

dotenv.config();

export default {
  port: process.env.PORT || 4000,
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  tokenTtlMinutes: parseInt(process.env.TOKEN_TTL_MINUTES || '15', 10),
  refreshTtlDays: parseInt(process.env.REFRESH_TTL_DAYS || '7', 10),
  openaiApiKey: process.env.OPENAI_API_KEY,
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  corsOrigin:
    process.env.CORS_ORIGIN || 'https://exam-management-frontend-psi.vercel.app',
  appBaseUrl:
    process.env.APP_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://exam-management-frontend-psi.vercel.app',
  nodeEnv: process.env.NODE_ENV || 'development',
};

