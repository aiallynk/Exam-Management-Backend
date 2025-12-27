import dotenv from 'dotenv';

dotenv.config();

/**
 * Required environment variables - app will fail to start if these are missing
 */
const REQUIRED_ENV_VARS = [
  'MONGODB_URI',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
];

/**
 * Validate required environment variables
 * Throws error with helpful message if any are missing
 */
function validateEnvVars() {
  const missing = REQUIRED_ENV_VARS.filter((varName) => !process.env[varName]);
  
  if (missing.length > 0) {
    const errorMessage = `
❌ Missing required environment variables:
${missing.map((v) => `   - ${v}`).join('\n')}

Please set these in your .env file or environment.
See server/env.example for reference.
    `.trim();
    
    throw new Error(errorMessage);
  }
  
  // Validate JWT secrets are not default/weak values
  if (process.env.JWT_SECRET === 'change-me' || process.env.JWT_SECRET === 'secret') {
    console.warn('⚠️  WARNING: JWT_SECRET appears to be using a default/weak value. Please change it in production!');
  }
  
  if (process.env.JWT_REFRESH_SECRET === 'change-me-too' || process.env.JWT_REFRESH_SECRET === 'secret') {
    console.warn('⚠️  WARNING: JWT_REFRESH_SECRET appears to be using a default/weak value. Please change it in production!');
  }
  
  // Validate MongoDB URI format (basic check)
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.startsWith('mongodb://') && !process.env.MONGODB_URI.startsWith('mongodb+srv://')) {
    console.warn('⚠️  WARNING: MONGODB_URI format may be incorrect. Expected mongodb:// or mongodb+srv://');
  }
}

// Validate environment variables on module load
validateEnvVars();

const config = {
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
  assetBaseUrl: process.env.ASSET_BASE_URL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
};

export default config;

