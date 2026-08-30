// Content Library ingestion tuning — batch sizes, chunk targets, stale detection.
export default Object.freeze({
  // Semantic chunk targets (~700–1200 tokens at ~4 chars/token).
  TARGET_CHUNK_CHARS: 4000,
  CHUNK_OVERLAP_CHARS: 200,
  MIN_CHUNK_CHARS: 400,

  // Embedding micro-batches (conservative; token budget is secondary guard).
  MAX_EMBEDDING_INPUTS_PER_BATCH: 48,
  MAX_EMBEDDING_ESTIMATED_TOKENS_PER_BATCH: 240000,
  CHARS_PER_TOKEN_ESTIMATE: 4,

  // PDF page classification thresholds (chars per page from pdf-parse).
  PDF_TEXT_NATIVE_CHARS_PER_PAGE: 120,
  PDF_SCANNED_CHARS_PER_PAGE: 40,
  PDF_MIN_TOTAL_TEXT_CHARS: 200,

  // Stale job detection.
  STALE_HEARTBEAT_MS: 5 * 60 * 1000,

  // AUTO_CONTEXT retrieval token budget (approximate).
  AUTO_CONTEXT_MAX_TOKENS: 12000,

  // Ingestion priority (future ECONOMY mode hook).
  DEFAULT_INGESTION_PRIORITY: 'FAST',
});
