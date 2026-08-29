import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableTestDatabase } from '../utils/testDatabaseSafety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Required environment variables - app will fail to start if these are missing
 */
const IS_TEST_ENVIRONMENT = process.env.NODE_ENV === 'test';
const REQUIRED_ENV_VARS = [
  IS_TEST_ENVIRONMENT ? 'TEST_MONGODB_URI' : 'MONGODB_URI',
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

  if (IS_TEST_ENVIRONMENT) {
    assertDisposableTestDatabase({ nodeEnv: process.env.NODE_ENV, uri: process.env.TEST_MONGODB_URI });
  }

  // Validate MongoDB URI format (basic check)
  if (!IS_TEST_ENVIRONMENT && process.env.MONGODB_URI && !process.env.MONGODB_URI.startsWith('mongodb://') && !process.env.MONGODB_URI.startsWith('mongodb+srv://')) {
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
  mongodbUri: IS_TEST_ENVIRONMENT ? process.env.TEST_MONGODB_URI : process.env.MONGODB_URI,
  mongodbDbName: IS_TEST_ENVIRONMENT
    ? assertDisposableTestDatabase({ nodeEnv: process.env.NODE_ENV, uri: process.env.TEST_MONGODB_URI }).databaseName
    : (process.env.MONGODB_DB_NAME || 'exam_system'),
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  tokenTtlMinutes: parseInt(process.env.TOKEN_TTL_MINUTES || '15', 10),
  refreshTtlDays: parseInt(process.env.REFRESH_TTL_DAYS || '7', 10),
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: resolveOpenAiModel(),
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  // Optional. Name of an Atlas Vector Search index over
  // QuestionEmbedding.embedding. When unset (default), tenant-scoped
  // question semantic similarity falls back to an in-application cosine
  // comparison — see services/questionEmbeddingService.js.
  questionVectorSearchIndex: process.env.QUESTION_VECTOR_SEARCH_INDEX || '',
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
  // S3-backed image storage (uploads + AI-generated question diagrams), keyed
  // per tenant/exam — see services/storage/imageStorage.js. Not required at
  // boot; image endpoints hard-fail with a clear error until these are set.
  // Separate from the DB-configured backup-storage feature (routes/systemBackup.js).
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || '',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  // Optional — only needed for non-AWS S3-compatible providers (MinIO, R2, etc).
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3ForcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
  s3ImageRootPrefix: process.env.S3_IMAGE_ROOT_PREFIX || 'xamigo',
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

  // ==========================================================
  // AI PROVIDER CREDENTIALS (backend-only secrets — never VITE_*)
  // ==========================================================
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  // ==========================================================
  // AI CONFIGURATION
  // ==========================================================
  // `database` = operation routing loaded from SystemConfig; env defaults
  // below are bootstrap fallback only when no DB record exists.
  // `env` = derive routing directly from env defaults (tests/local).
  aiConfigSource: String(process.env.AI_CONFIG_SOURCE || 'database').trim().toLowerCase(),
  aiDefaultQuestionProvider: process.env.AI_DEFAULT_QUESTION_PROVIDER
    || process.env.AI_QUESTION_PROVIDER
    || 'openai',
  aiDefaultEvaluationProvider: process.env.AI_DEFAULT_EVALUATION_PROVIDER
    || process.env.AI_EVALUATION_PROVIDER
    || 'gemini',

  // Runtime safety
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS || 60000),
  aiMaxRetries: Number(process.env.AI_MAX_RETRIES || 2),
  aiStrictProviderRouting: String(process.env.AI_STRICT_PROVIDER_ROUTING || 'true').toLowerCase() !== 'false',
  aiEnableProviderFallback: String(process.env.AI_ENABLE_PROVIDER_FALLBACK || 'false').toLowerCase() === 'true',
  aiUseMockProviders: String(process.env.AI_USE_MOCK_PROVIDERS || 'false').toLowerCase() === 'true',

  // Legacy per-domain provider aliases — deprecated; prefer AI_DEFAULT_* +
  // database routing. Kept for backward compatibility during migration.
  aiQuestionProvider: process.env.AI_DEFAULT_QUESTION_PROVIDER || process.env.AI_QUESTION_PROVIDER || 'openai',
  aiEmbeddingProvider: process.env.AI_EMBEDDING_PROVIDER || process.env.AI_DEFAULT_QUESTION_PROVIDER || process.env.AI_QUESTION_PROVIDER || 'openai',
  aiEvaluationProvider: process.env.AI_DEFAULT_EVALUATION_PROVIDER || process.env.AI_EVALUATION_PROVIDER || 'gemini',
  aiVisionProvider: process.env.AI_VISION_PROVIDER || process.env.AI_DEFAULT_EVALUATION_PROVIDER || process.env.AI_EVALUATION_PROVIDER || 'gemini',
  aiHandwritingProvider: process.env.AI_HANDWRITING_PROVIDER || process.env.AI_DEFAULT_EVALUATION_PROVIDER || process.env.AI_EVALUATION_PROVIDER || 'gemini',
  aiFormativeFeedbackProvider: process.env.AI_FORMATIVE_FEEDBACK_PROVIDER || process.env.AI_DEFAULT_EVALUATION_PROVIDER || process.env.AI_EVALUATION_PROVIDER || 'gemini',
  aiQuestionImageProvider: process.env.AI_QUESTION_IMAGE_PROVIDER || process.env.AI_DEFAULT_QUESTION_PROVIDER || process.env.AI_QUESTION_PROVIDER || 'openai',

  // OpenAI models (OPENAI_MODEL remains the legacy fallback)
  openaiQuestionModel: process.env.OPENAI_QUESTION_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  openaiClassificationModel: process.env.OPENAI_CLASSIFICATION_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  openaiImageModel: process.env.OPENAI_IMAGE_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,

  // Gemini models
  geminiEvaluationModel: process.env.GEMINI_EVALUATION_MODEL || 'gemini-2.0-flash',
  geminiVisionModel: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_EVALUATION_MODEL || 'gemini-2.0-flash',
  geminiHandwritingModel: process.env.GEMINI_HANDWRITING_MODEL || process.env.GEMINI_VISION_MODEL || process.env.GEMINI_EVALUATION_MODEL || 'gemini-2.0-flash',
  geminiFeedbackModel: process.env.GEMINI_FEEDBACK_MODEL || process.env.GEMINI_EVALUATION_MODEL || 'gemini-2.0-flash',
};

export default config;
