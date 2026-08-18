// Source-Grounded AI Question Generation — every tunable constant this
// feature needs, centralized so none of it is scattered as inline magic
// numbers across services/routes (mirrors the intent of the
// MAX_IMPORT_AI_CHUNKS-style constants in services/aiService.js, pulled
// into its own module since this feature has far more knobs than fit
// comfortably at the top of one file).
export default Object.freeze({
  // --- Ingestion ---
  MAX_CONTEXT_SOURCES_PER_SET: 10,
  CONTEXT_CHUNK_SIZE_CHARS: 1200,
  CONTEXT_CHUNK_OVERLAP_CHARS: 150,
  MAX_PARALLEL_EMBEDDING_REQUESTS: 4,

  // --- Retrieval ---
  RETRIEVAL_TOP_K: 24,
  RETRIEVAL_MIN_SIMILARITY: 0.18,

  // --- Candidate pool / novelty ---
  CANDIDATE_POOL_OVERSAMPLE_FACTOR: 1.6,
  CANDIDATE_POOL_MAX_ATTEMPTS: 3,
  NOVELTY_NEAR_DUP_SIMILARITY_THRESHOLD: 0.85,
  NOVELTY_SHINGLE_SIZE: 3,

  // --- Grounding validator ---
  // Heuristic term-coverage score range that escalates to a single cheap
  // LLM verification call rather than deciding purely on the heuristic.
  GROUNDING_VALIDATOR_AMBIGUITY_BAND: [0.35, 0.65],

  // --- SSRF-safe URL fetch ---
  SSRF_FETCH_TIMEOUT_MS: 8000,
  SSRF_MAX_REDIRECTS: 3,
  SSRF_MAX_RESPONSE_BYTES: 5 * 1024 * 1024,
  // text/csv is needed for Google Sheets export (see
  // services/googleDriveSourceProvider.js) — every other URL source keeps
  // going through the same html/plain/pdf branches as before.
  SSRF_ALLOWED_CONTENT_TYPES: ['text/html', 'text/plain', 'application/pdf', 'text/csv'],
});
