import { normalizeQuestionType } from './questionTypeRegistry.js';

// Source-Grounded AI generation — "always fulfil the request" helper
// (Blueprint §4C). The grounded producer (candidatePoolOrchestratorService)
// deliberately returns FEWER questions than asked rather than inventing
// unsupported content. For the SELECTED_CONTEXT / AUTO_CONTEXT modes the
// route then tops up the shortfall on the same topic, using the retrieved
// source text as context. This module is the pure per-type shortfall math,
// extracted so it is unit-testable without a DB or an AI provider.

const toCount = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Normalize a `[{ type, count }]` distribution into a `{ TYPE: count }` map,
 * dropping unknown types and non-positive counts and summing duplicates.
 */
export const distributionToCountMap = (distribution = []) => {
  const map = {};
  (Array.isArray(distribution) ? distribution : []).forEach((item) => {
    const type = normalizeQuestionType(item?.type);
    const count = toCount(item?.count);
    if (type && count > 0) map[type] = (map[type] || 0) + count;
  });
  return map;
};

/**
 * Given what was requested and what grounded generation actually produced,
 * return the remaining work as a `[{ type, count }]` distribution plus its
 * total.
 *
 * - `requestedDistribution`: `[{ type, count }]` — the exact per-type ask.
 *   When empty/absent, falls back to `requestedCount` of `fallbackTypes`
 *   (evenly split, remainder to the earlier types), mirroring the frontend's
 *   own even-split in CreateExamEnhanced.jsx.
 * - `generatedByType`: `{ TYPE: count }` — grounded questions already accepted.
 *
 * Never returns negative counts (grounded over-production of one type never
 * creates negative top-up for another).
 */
export const computeShortfallDistribution = ({
  requestedDistribution = [],
  requestedCount = 0,
  generatedByType = {},
  fallbackTypes = [],
} = {}) => {
  const generated = {};
  Object.entries(generatedByType || {}).forEach(([type, count]) => {
    const t = normalizeQuestionType(type);
    if (t) generated[t] = (generated[t] || 0) + toCount(count);
  });

  let requested = distributionToCountMap(requestedDistribution);

  if (Object.keys(requested).length === 0) {
    const types = (Array.isArray(fallbackTypes) ? fallbackTypes : [])
      .map(normalizeQuestionType)
      .filter(Boolean);
    const total = toCount(requestedCount);
    if (!types.length || !total) {
      // No explicit distribution and no usable type list: express the
      // shortfall as a bare count against a single synthetic bucket the
      // caller maps back to its own default type.
      const alreadyGenerated = Object.values(generated).reduce((s, n) => s + n, 0);
      const remaining = Math.max(total - alreadyGenerated, 0);
      return { shortfallDistribution: [], shortfallCount: remaining };
    }
    const per = Math.floor(total / types.length);
    const remainder = total % types.length;
    requested = {};
    types.forEach((type, index) => {
      const count = per + (index < remainder ? 1 : 0);
      if (count > 0) requested[type] = (requested[type] || 0) + count;
    });
  }

  const shortfallDistribution = Object.entries(requested)
    .map(([type, count]) => ({ type, count: Math.max(count - (generated[type] || 0), 0) }))
    .filter((item) => item.count > 0);

  const shortfallCount = shortfallDistribution.reduce((sum, item) => sum + item.count, 0);
  return { shortfallDistribution, shortfallCount };
};
