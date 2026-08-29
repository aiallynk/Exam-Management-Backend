import User from '../../models/User.js';
import ExamParticipant from '../../models/ExamParticipant.js';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';

// Part E — candidate identification. No dedicated "roll number" field
// exists anywhere in the current schema (User/Enrollment) — see
// docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md. This is a genuine,
// honestly-scoped gap: matching is name/email-based fuzzy similarity
// against the exam's real candidate pool (ExamParticipant), not a stub,
// but it is NOT a roll-number-registry lookup, because that registry
// doesn't exist in the product yet. A detected roll number is still
// captured and shown to the human reviewer — it's just not the primary
// match key today.

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Small self-contained Levenshtein distance -> similarity score. No new
// dependency for one string-matching utility.
const similarity = (a, b) => {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j += 1) dist[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  const distance = dist[rows - 1][cols - 1];
  return 1 - distance / Math.max(left.length, right.length);
};

// The bounded, exam-relevant candidate pool to match against — never the
// whole tenant unscoped, to keep both accuracy and privacy exposure tight.
const getCandidatePool = async ({ tenantId, examId }) => {
  const participants = await ExamParticipant.find({ examId, examRole: 'CANDIDATE' }).select('userId').lean();
  const participantIds = participants.map((p) => p.userId);
  const filter = participantIds.length
    ? { _id: { $in: participantIds }, tenantId }
    : { tenantId, role: 'CANDIDATE' }; // public exam (no pre-assignment) — whole tenant candidate pool
  return User.find(filter).select('name email').limit(2000).lean();
};

export const suggestCandidates = async ({ tenantId, examId, detectedRollNumber, detectedCandidateName }) => {
  const pool = await getCandidatePool({ tenantId, examId });
  const rollLocalPart = String(detectedRollNumber || '').trim();
  const nameGuess = String(detectedCandidateName || '').trim();
  if (!rollLocalPart && !nameGuess) return [];

  const scored = pool.map((user) => {
    const emailLocalPart = String(user.email || '').split('@')[0];
    const rollScore = rollLocalPart
      ? Math.max(similarity(rollLocalPart, emailLocalPart), emailLocalPart.includes(rollLocalPart.toLowerCase()) ? 0.9 : 0)
      : 0;
    const nameScore = nameGuess ? similarity(nameGuess, user.name) : 0;
    // Roll/ID match is weighted higher than name-only — Part E explicitly
    // warns against mapping on name alone.
    const score = rollLocalPart && nameGuess ? rollScore * 0.7 + nameScore * 0.3 : Math.max(rollScore, nameScore * 0.6);
    return { userId: user._id, name: user.name, rollNumber: emailLocalPart, score: Number(score.toFixed(3)) };
  });

  return scored
    .filter((entry) => entry.score >= offlineEvaluationConfig.CANDIDATE_MATCH_SUGGESTION_MIN_CONFIDENCE)
    .sort((a, b) => b.score - a.score)
    .slice(0, offlineEvaluationConfig.MAX_CANDIDATE_SUGGESTIONS);
};

// Returns { candidateId, confidence, method } or null if nothing clears
// the auto-confidence bar — the caller (ingestion service) falls back to
// NEEDS_MAPPING either way, this just decides whether a human still has to
// look at it.
export const autoMapCandidate = async ({ tenantId, examId, detectedRollNumber, detectedCandidateName }) => {
  const suggestions = await suggestCandidates({ tenantId, examId, detectedRollNumber, detectedCandidateName });
  const best = suggestions[0];
  if (!best || best.score < offlineEvaluationConfig.CANDIDATE_MATCH_AUTO_CONFIDENCE) return null;
  // Auto-map only when the best candidate is unambiguously ahead of the
  // second-best — two close matches must go to a human either way.
  const runnerUp = suggestions[1];
  if (runnerUp && best.score - runnerUp.score < 0.1) return null;
  return { candidateId: best.userId, confidence: best.score, method: detectedRollNumber ? 'ROLL_NUMBER' : 'MANUAL' };
};
