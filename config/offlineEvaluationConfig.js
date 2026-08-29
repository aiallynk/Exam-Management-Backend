// Master Phase 4 — every tunable constant for offline answer-script
// evaluation, centralized so confidence thresholds are deterministic
// application policy, not invented per-request by an LLM (Part K's
// explicit requirement). Mirrors the style of config/sourceGroundedConfig.js.
export default Object.freeze({
  // --- Upload limits ---
  MAX_ANSWER_SCRIPT_SIZE_BYTES: 40 * 1024 * 1024, // 40MB — a multi-page scanned booklet
  MAX_ANSWER_SCRIPT_PAGES: 60,
  ALLOWED_ANSWER_SCRIPT_MIME_TYPES: ['application/pdf', 'image/jpeg', 'image/png'],

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
