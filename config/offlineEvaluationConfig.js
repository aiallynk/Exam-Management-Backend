// Master Phase 4 — every tunable constant for offline answer-script
// evaluation, centralized so confidence thresholds are deterministic
// application policy, not invented per-request by an LLM (Part K's
// explicit requirement). Mirrors the style of config/sourceGroundedConfig.js.
const positiveNumber = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const positiveInteger = (name, fallback, bounds = {}) =>
  Math.floor(positiveNumber(name, fallback, bounds));

export default Object.freeze({
  // --- Upload limits ---
  MAX_ANSWER_SCRIPT_SIZE_BYTES: positiveInteger('ANSWER_SCRIPT_MAX_FILE_BYTES', 40 * 1024 * 1024),
  MAX_ANSWER_SCRIPT_PAGES: positiveInteger('ANSWER_SCRIPT_MAX_PAGES', 60, { max: 500 }),
  MAX_FILES_PER_BATCH: positiveInteger('ANSWER_SCRIPT_MAX_FILES_PER_BATCH', 30, { max: 100 }),
  CLIENT_UPLOAD_CONCURRENCY: positiveInteger('ANSWER_SCRIPT_CLIENT_UPLOAD_CONCURRENCY', 4, { max: 8 }),
  MULTIPART_THRESHOLD_BYTES: positiveInteger('ANSWER_SCRIPT_MULTIPART_THRESHOLD_BYTES', 15 * 1024 * 1024),
  MULTIPART_PART_SIZE_BYTES: positiveInteger('ANSWER_SCRIPT_MULTIPART_PART_SIZE_BYTES', 8 * 1024 * 1024, { min: 5 * 1024 * 1024 }),
  ALLOWED_ANSWER_SCRIPT_MIME_TYPES: ['application/pdf', 'image/jpeg', 'image/png'],

  // --- Adaptive normalization ---
  NORMAL_WORKING_DPI: positiveInteger('ANSWER_SCRIPT_WORKING_DPI', 220, { min: 120, max: 300 }),
  HIGH_CONFIDENCE_RETRY_DPI: positiveInteger('ANSWER_SCRIPT_RETRY_DPI', 300, { min: 220, max: 400 }),
  WORKING_LONG_EDGE_PX: positiveInteger('ANSWER_SCRIPT_WORKING_LONG_EDGE_PX', 2600, { min: 1400, max: 5000 }),
  PREVIEW_LONG_EDGE_PX: positiveInteger('ANSWER_SCRIPT_PREVIEW_LONG_EDGE_PX', 1600, { min: 800, max: 2600 }),
  THUMBNAIL_LONG_EDGE_PX: positiveInteger('ANSWER_SCRIPT_THUMBNAIL_LONG_EDGE_PX', 320, { min: 160, max: 640 }),
  IDENTITY_HEADER_FRACTION: positiveNumber('ANSWER_SCRIPT_IDENTITY_HEADER_FRACTION', 0.32, { min: 0.15, max: 0.5 }),

  // --- Durable queues / provider limits ---
  DOCUMENT_CONCURRENCY: positiveInteger('ANSWER_SCRIPT_DOCUMENT_CONCURRENCY', 2, { max: 64 }),
  AI_CONCURRENCY: positiveInteger('ANSWER_SCRIPT_AI_CONCURRENCY', 2, { max: 64 }),
  RENDER_CONCURRENCY: positiveInteger('ANSWER_SCRIPT_RENDER_CONCURRENCY', 1, { max: 32 }),
  MAX_ACTIVE_PER_TENANT: positiveInteger('ANSWER_SCRIPT_MAX_PER_TENANT', 2, { max: 32 }),
  MAX_ACTIVE_PER_UPLOADER: positiveInteger('ANSWER_SCRIPT_MAX_PER_UPLOADER', 1, { max: 16 }),
  PROVIDER_REQUESTS_PER_MINUTE: positiveInteger('ANSWER_SCRIPT_PROVIDER_REQUESTS_PER_MINUTE', 30, { max: 10000 }),
  STALE_AFTER_MS: positiveInteger('ANSWER_SCRIPT_STALE_AFTER_MS', 10 * 60 * 1000, { min: 60 * 1000 }),
  RETENTION_POLICY_KEY: String(process.env.ANSWER_SCRIPT_RETENTION_POLICY_KEY || 'platform-default').trim(),

  // --- Candidate mapping (Part E) ---
  // Below this, a roll-number/name match is a "suggestion" only — never
  // auto-applied.
  CANDIDATE_MATCH_AUTO_CONFIDENCE: 0.85,
  CANDIDATE_MATCH_SUGGESTION_MIN_CONFIDENCE: 0.4,
  MAX_CANDIDATE_SUGGESTIONS: 5,

  // --- Question mapping confidence (Part H) ---
  QUESTION_MAPPING_HIGH_CONFIDENCE: 0.75, // auto-route to evaluation
  QUESTION_MAPPING_LOW_CONFIDENCE: 0.4, // below this, mandatory manual mapping

  // --- Evaluation confidence routing (Part K) ---
  EVALUATION_HIGH_CONFIDENCE: 0.85, // bulk-review eligible where policy allows
  EVALUATION_MEDIUM_CONFIDENCE: 0.6, // evaluator review recommended
  // below EVALUATION_MEDIUM_CONFIDENCE => evaluator review mandatory

  // --- Page quality (Part F) ---
  // POOR/UNREADABLE pages (services/offlineEvaluation/pageQualityService.js)
  // are never sent to OCR — they route straight to NEEDS_REVIEW.

  // --- Presigned access (Part D/X) ---
  PRIVATE_URL_EXPIRY_SECONDS: 300,
});
