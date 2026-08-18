import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

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

  // NOVELTY_SIGNATURE_SECRET is NOT in REQUIRED_ENV_VARS on purpose: the
  // Source-Grounded AI feature it backs ships behind an UNRELEASED
  // capability flag (see services/tenantFeatureService.js), so no request
  // can reach it yet. Requiring it at boot would fail every existing
  // deployment's startup the moment this code ships, for a feature nobody
  // can use yet. services/noveltyService.js throws a clear error the first
  // time it's actually invoked without this set, instead.
  if (process.env.NOVELTY_SIGNATURE_SECRET === 'change-me-too' || process.env.NOVELTY_SIGNATURE_SECRET === 'secret') {
    console.warn('⚠️  WARNING: NOVELTY_SIGNATURE_SECRET appears to be using a default/weak value. Please change it before enabling Source-Grounded generation in production!');
  }

  // Validate MongoDB URI format (basic check)
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.startsWith('mongodb://') && !process.env.MONGODB_URI.startsWith('mongodb+srv://')) {
    console.warn('⚠️  WARNING: MONGODB_URI format may be incorrect. Expected mongodb:// or mongodb+srv://');
  }
}

// Validate environment variables on module load
validateEnvVars();

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const resolveOpenAiModel = () => {
  const configured = String(process.env.OPENAI_MODEL || '').trim();
  return configured || DEFAULT_OPENAI_MODEL;
};

const config = {
  port: process.env.PORT || 4000,
  host: process.env.HOST || '0.0.0.0',
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  tokenTtlMinutes: parseInt(process.env.TOKEN_TTL_MINUTES || '15', 10),
  refreshTtlDays: parseInt(process.env.REFRESH_TTL_DAYS || '7', 10),
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: resolveOpenAiModel(),
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  // Source-Grounded AI Question Generation novelty ledger HMAC key. Not in
  // REQUIRED_ENV_VARS — see the boot-time warning above for why.
  noveltySignatureSecret: process.env.NOVELTY_SIGNATURE_SECRET || '',
  // Optional. When set, Google Drive FILE sources (see
  // services/googleDriveSourceProvider.js) are fetched via the official
  // Drive v3 files.get?alt=media endpoint instead of the public
  // uc?export=download page trick — more reliable for large/binary files.
  // Never required: publicly-shared ("Anyone with the link") files are
  // still readable without it.
  googleDriveApiKey: process.env.GOOGLE_DRIVE_API_KEY || '',
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  corsOrigin:
    process.env.CORS_ORIGIN || 'https://exam-management-frontend-psi.vercel.app',
  appBaseUrl:
    process.env.APP_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://exam-management-frontend-psi.vercel.app',
  assetBaseUrl: process.env.ASSET_BASE_URL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  judge0BaseUrl: process.env.JUDGE0_BASE_URL || 'https://ce.judge0.com',
  judge0ApiKey: process.env.JUDGE0_API_KEY || '',
  judge0ApiUser: process.env.JUDGE0_API_USER || '',
  judge0CpuTimeLimit: Number(process.env.JUDGE0_CPU_TIME_LIMIT || 2),
  judge0WallTimeLimit: Number(process.env.JUDGE0_WALL_TIME_LIMIT || 5),
  judge0MemoryLimitKb: Number(process.env.JUDGE0_MEMORY_LIMIT_KB || 131072),
  judge0EnableNetwork: String(process.env.JUDGE0_ENABLE_NETWORK || 'false').toLowerCase() === 'true',
  judge0PollingIntervalMs: Number(process.env.JUDGE0_POLLING_INTERVAL_MS || 1000),
  judge0MaxPolls: Number(process.env.JUDGE0_MAX_POLLS || 20),
};

export default config;

