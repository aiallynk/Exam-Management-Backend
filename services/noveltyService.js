import crypto from 'node:crypto';
import config from '../config/env.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import NoveltySignature from '../models/NoveltySignature.js';

// Source-Grounded AI Question Generation — the novelty/anti-duplication
// engine (master prompt §19-31). Enforces uniqueness in code, not prompt
// wording, at three levels simultaneously:
//   - batch:   in-memory check within one generation call (createBatchNoveltyTracker)
//   - tenant:  NoveltySignature rows with scope='TENANT' (tenantId set)
//   - global:  NoveltySignature rows with scope='GLOBAL' (tenantId=null)
//
// PRIVACY: every signature is an HMAC-SHA256 digest keyed with a
// server-only secret (NOVELTY_SIGNATURE_SECRET). A signature is not
// reversible back to the original question/answer text without that
// secret, so GLOBAL-scope rows never expose one tenant's content to
// another — only whether a signature collides, never what produced it.
//
// CONCURRENCY: novelty is only ever atomically *claimed* via
// reserveNovelty(), which is a set of NoveltySignature.create() calls
// relying on the {scope,layer,signature} unique index (see the model) —
// never a find-then-insert. probeNovelty() is a cheap read-only
// pre-filter for candidate scanning; the actual accept/reject decision
// for the specific candidate that gets counted toward a batch MUST go
// through reserveNovelty(), which is what prevents two concurrent
// generation requests (same or different tenants) from both "winning"
// the same signature.

const getHmacSecret = () => {
  const secret = config.noveltySignatureSecret;
  if (!secret) {
    throw new Error(
      'NOVELTY_SIGNATURE_SECRET is not configured. Set it before enabling Source-Grounded AI generation ' +
        '(see env.example) — the novelty/anti-duplication engine cannot run without it.'
    );
  }
  return secret;
};

const hmacHex = (value) =>
  crypto.createHmac('sha256', getHmacSecret()).update(String(value)).digest('hex');

// --- Canonicalization ------------------------------------------------

export const canonicalizeQuestionText = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation-insensitive
    .replace(/\s+/g, ' ')
    .trim();

const canonicalizeOptions = (options) => {
  if (!Array.isArray(options)) return '';
  return options
    .map((option) => canonicalizeQuestionText(typeof option === 'string' ? option : option?.text || ''))
    .filter(Boolean)
    .sort() // order-insensitive — reordered options are still the same question
    .join('|');
};

// Combines stem + options + expected answer + type into one canonical
// string for exact-duplicate detection. Deliberately NOT case/whitespace/
// punctuation/option-order sensitive — those variations are still the
// same question for our purposes (master prompt §21).
export const buildCanonicalQuestionRepresentation = ({
  questionText,
  options,
  correctAnswer,
  questionType,
}) => {
  const stem = canonicalizeQuestionText(questionText);
  const optionsPart = canonicalizeOptions(options);
  const answerPart = canonicalizeQuestionText(
    typeof correctAnswer === 'string' ? correctAnswer : JSON.stringify(correctAnswer ?? '')
  );
  const typePart = String(questionType || '').trim().toUpperCase();
  return `${typePart}::${stem}::${optionsPart}::${answerPart}`;
};

export const computeExactSignature = (canonicalRepresentation) => hmacHex(canonicalRepresentation);

// --- Near-duplicate (keyed shingles + banded MinHash-lite) -----------

const tokenize = (canonicalText) => canonicalText.split(' ').filter(Boolean);

const buildShingles = (tokens, k = sourceGroundedConfig.NOVELTY_SHINGLE_SIZE) => {
  if (tokens.length < k) return tokens.length ? [tokens.join(' ')] : [];
  const shingles = [];
  for (let i = 0; i <= tokens.length - k; i += 1) {
    shingles.push(tokens.slice(i, i + k).join(' '));
  }
  return shingles;
};

const NUM_MINHASH_FUNCTIONS = 8;
const BAND_SIZE = 2; // 4 bands of 2 -> a near-duplicate needs to match on at least one full band

// Deterministic per-seed keyed hash of a shingle, reduced to a 32-bit
// unsigned integer for MinHash comparison.
const seededShingleHash = (shingle, seed) => {
  const digest = crypto.createHmac('sha256', getHmacSecret()).update(`${seed}:${shingle}`).digest();
  return digest.readUInt32BE(0);
};

// Returns NUM_MINHASH_FUNCTIONS minimum-hash values over the shingle set —
// a compact, similarity-preserving fingerprint: two texts with high
// shingle (Jaccard) overlap are likely to share several of these minima.
const computeMinHashValues = (shingles) => {
  const values = new Array(NUM_MINHASH_FUNCTIONS).fill(0xffffffff);
  if (!shingles.length) return values;
  for (let seed = 0; seed < NUM_MINHASH_FUNCTIONS; seed += 1) {
    for (const shingle of shingles) {
      const hashed = seededShingleHash(shingle, seed);
      if (hashed < values[seed]) values[seed] = hashed;
    }
  }
  return values;
};

// Locality-sensitive banding: two documents are treated as "candidate
// near-duplicates" if ANY band's values match exactly, not only if the
// full signature matches — this is what makes near-duplicate detection
// tolerant to a few reworded words rather than requiring near-total
// similarity (master prompt §22).
export const computeNearSignatureBands = (questionText) => {
  const tokens = tokenize(canonicalizeQuestionText(questionText));
  const shingles = buildShingles(tokens);
  const minHashValues = computeMinHashValues(shingles);
  const bands = [];
  for (let i = 0; i < NUM_MINHASH_FUNCTIONS; i += BAND_SIZE) {
    const bandValues = minHashValues.slice(i, i + BAND_SIZE).join(',');
    bands.push(hmacHex(`band:${i / BAND_SIZE}:${bandValues}`));
  }
  return bands;
};

// --- Blueprint (abstract "what is this question really testing") -----

export const computeBlueprintSignature = ({ topic, concept, answerFingerprint, questionType, difficulty }) => {
  const parts = [
    canonicalizeQuestionText(topic),
    canonicalizeQuestionText(concept),
    canonicalizeQuestionText(answerFingerprint),
    String(questionType || '').trim().toUpperCase(),
    String(difficulty || '').trim().toUpperCase(),
  ];
  return hmacHex(parts.join('::'));
};

// --- Reservation (the atomic, race-safe primitive) --------------------

// Attempts exactly one atomic reservation. Returns { novel: true, record }
// on success, { novel: false } if this signature is already claimed.
export const registerAndCheckNovelty = async ({ scope, tenantId, layer, signature, generationRunId }) => {
  try {
    const record = await NoveltySignature.create({
      scope,
      tenantId: scope === 'GLOBAL' ? null : tenantId,
      layer,
      signature,
      generationRunId: generationRunId || null,
    });
    return { novel: true, record };
  } catch (error) {
    if (error?.code === 11000) return { novel: false };
    throw error;
  }
};

const buildLayerSignatures = ({ question, blueprint }) => {
  const canonicalRepresentation = buildCanonicalQuestionRepresentation(question);
  return {
    exact: computeExactSignature(canonicalRepresentation),
    nearBands: computeNearSignatureBands(question.questionText),
    blueprint: blueprint ? computeBlueprintSignature(blueprint) : null,
  };
};

// Read-only pre-filter — cheap way for the candidate-pool orchestrator to
// skip an obviously-duplicate candidate before spending a grounding-
// validation LLM call on it. Never mutates state, so it is safe to call
// repeatedly and does not participate in the concurrency guarantee —
// only reserveNovelty() below does.
export const probeNovelty = async ({ tenantId, question, blueprint }) => {
  const { exact, nearBands, blueprint: blueprintSignature } = buildLayerSignatures({ question, blueprint });
  const scopes = [
    { scope: 'TENANT', tenantId },
    { scope: 'GLOBAL', tenantId: null },
  ];
  const orConditions = [];
  for (const { scope, tenantId: scopedTenantId } of scopes) {
    orConditions.push({ scope, tenantId: scopedTenantId, layer: 'EXACT', signature: exact });
    for (const band of nearBands) {
      orConditions.push({ scope, tenantId: scopedTenantId, layer: 'NEAR', signature: band });
    }
    if (blueprintSignature) {
      orConditions.push({ scope, tenantId: scopedTenantId, layer: 'BLUEPRINT', signature: blueprintSignature });
    }
  }
  const collision = await NoveltySignature.findOne({ $or: orConditions }).select('layer scope').lean();
  return { likelyDuplicate: Boolean(collision), collision: collision || null };
};

// Atomically claims every signature layer (exact, every near-duplicate
// band, blueprint) at both TENANT and GLOBAL scope for one accepted
// candidate. If ANY reservation collides, every reservation this call
// itself already made is rolled back (compensating delete, scoped only
// to this call's own just-created rows) and { novel: false } is
// returned — the candidate must be rejected, not partially registered.
export const reserveNovelty = async ({ tenantId, question, blueprint, generationRunId }) => {
  const { exact, nearBands, blueprint: blueprintSignature } = buildLayerSignatures({ question, blueprint });
  const attempts = [];
  const scopes = [
    { scope: 'TENANT', tenantId },
    { scope: 'GLOBAL', tenantId: null },
  ];
  for (const { scope, tenantId: scopedTenantId } of scopes) {
    attempts.push({ scope, tenantId: scopedTenantId, layer: 'EXACT', signature: exact });
    for (const band of nearBands) {
      attempts.push({ scope, tenantId: scopedTenantId, layer: 'NEAR', signature: band });
    }
    if (blueprintSignature) {
      attempts.push({ scope, tenantId: scopedTenantId, layer: 'BLUEPRINT', signature: blueprintSignature });
    }
  }

  const claimed = [];
  for (const attempt of attempts) {
    const result = await registerAndCheckNovelty({ ...attempt, generationRunId });
    if (!result.novel) {
      // Roll back everything this call itself claimed before failing —
      // never leave a partial reservation for a rejected candidate.
      if (claimed.length) {
        await NoveltySignature.deleteMany({ _id: { $in: claimed.map((record) => record._id) } });
      }
      return { novel: false, collidedLayer: attempt.layer, collidedScope: attempt.scope };
    }
    claimed.push(result.record);
  }

  return { novel: true, exactSignature: exact, nearSignature: nearBands[0], blueprintSignature };
};

// In-memory, per-generation-run dedup — catches two candidates racing
// against each other within the SAME batch before either ever reaches
// the database (master prompt §19.A). Cheap and avoids wasting a DB
// round trip / unique-index race for what is, within one batch, a
// perfectly ordinary duplicate.
export const createBatchNoveltyTracker = () => {
  const seenExact = new Set();
  const seenNearBands = new Set();
  return {
    isDuplicate(question) {
      const canonicalRepresentation = buildCanonicalQuestionRepresentation(question);
      const exact = computeExactSignature(canonicalRepresentation);
      if (seenExact.has(exact)) return true;
      const nearBands = computeNearSignatureBands(question.questionText);
      return nearBands.some((band) => seenNearBands.has(band));
    },
    record(question) {
      const canonicalRepresentation = buildCanonicalQuestionRepresentation(question);
      seenExact.add(computeExactSignature(canonicalRepresentation));
      computeNearSignatureBands(question.questionText).forEach((band) => seenNearBands.add(band));
    },
  };
};
