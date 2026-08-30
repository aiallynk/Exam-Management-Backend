import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const normalizeRoll = (value) => String(value || '').trim().replace(/^0+/, '') || '';

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

const buildSuggestion = (entry, score, reason) => ({
  userId: entry.userId,
  name: entry.displayName,
  rollNumber: entry.rollNumber,
  enrollmentId: entry.enrollmentId,
  score: Number(score.toFixed(3)),
  reason,
});

const findRollMatches = (roster, roll) => roster.filter((entry) => roll && entry.normalizedRoll && entry.normalizedRoll === roll);
const findNameMatches = (roster, name) => roster.filter((entry) => name && entry.normalizedName && entry.normalizedName === name);

export const suggestFromRoster = ({
  roster,
  detectedRollNumber,
  detectedCandidateName,
  detectedExternalStudentId,
  originalFileName = '',
}) => {
  if (!roster.length) return [];

  const roll = normalizeRoll(detectedRollNumber);
  const name = normalize(detectedCandidateName);
  const externalId = String(detectedExternalStudentId || '').trim();
  const fileHint = normalize(originalFileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));

  const scored = [];

  roster.forEach((entry) => {
    let score = 0;
    let reason = 'NAME_FUZZY';

    if (roll && entry.normalizedRoll && roll === entry.normalizedRoll) {
      score = 0.98;
      reason = 'ROLL_EXACT';
      if (name && entry.normalizedName) {
        score = name === entry.normalizedName ? 0.995 : similarity(name, entry.displayName) >= 0.85 ? 0.97 : 0.55;
        reason = score >= 0.97 ? 'ROLL_AND_NAME' : 'ROLL_NAME_CONFLICT';
      }
    } else if (externalId && entry.externalStudentId && externalId === entry.externalStudentId) {
      score = 0.96;
      reason = 'EXTERNAL_ID';
    } else if (name && entry.normalizedName === name) {
      score = 0.82;
      reason = 'NAME_EXACT';
    } else if (name) {
      score = similarity(name, entry.displayName) * 0.75;
      reason = 'NAME_FUZZY';
    } else if (fileHint && (fileHint.includes(entry.normalizedName) || (entry.normalizedRoll && fileHint.includes(entry.normalizedRoll)))) {
      score = 0.45;
      reason = 'FILE_NAME_HINT';
    }

    if (score >= offlineEvaluationConfig.CANDIDATE_MATCH_SUGGESTION_MIN_CONFIDENCE) {
      scored.push(buildSuggestion(entry, score, reason));
    }
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, offlineEvaluationConfig.MAX_CANDIDATE_SUGGESTIONS);
};

export const resolveMappingFromRoster = ({
  roster,
  detectedRollNumber,
  detectedCandidateName,
  detectedExternalStudentId,
  originalFileName = '',
  identityConfidence = 0,
}) => {
  if (!roster.length) return { status: 'NEEDS_MAPPING', suggestions: [], conflict: 'EMPTY_ROSTER' };

  const roll = normalizeRoll(detectedRollNumber);
  const name = normalize(detectedCandidateName);
  const externalId = String(detectedExternalStudentId || '').trim();

  if (externalId) {
    const externalMatches = roster.filter((entry) => entry.externalStudentId && entry.externalStudentId === externalId);
    if (externalMatches.length === 1) {
      return {
        status: 'AUTO_MAP',
        candidateId: externalMatches[0].userId,
        enrollmentId: externalMatches[0].enrollmentId,
        confidence: 0.96,
        method: 'CANDIDATE_ID',
      };
    }
    if (externalMatches.length > 1) {
      return {
        status: 'NEEDS_MAPPING',
        conflict: 'EXTERNAL_ID_NOT_UNIQUE',
        suggestions: externalMatches.map((entry) => buildSuggestion(entry, 0.7, 'EXTERNAL_ID_AMBIGUOUS')),
      };
    }
  }

  const rollMatches = findRollMatches(roster, roll);
  if (rollMatches.length === 1) {
    const entry = rollMatches[0];
    if (name && entry.normalizedName && name !== entry.normalizedName) {
      return {
        status: 'NEEDS_MAPPING',
        conflict: 'ROLL_NAME_MISMATCH',
        suggestions: suggestFromRoster({ roster, detectedRollNumber, detectedCandidateName, detectedExternalStudentId, originalFileName }),
      };
    }
    return {
      status: 'AUTO_MAP',
      candidateId: entry.userId,
      enrollmentId: entry.enrollmentId,
      confidence: Math.max(0.95, identityConfidence || 0.9),
      method: 'ROLL_NUMBER',
    };
  }
  if (rollMatches.length > 1) {
    return { status: 'NEEDS_MAPPING', conflict: 'ROLL_NOT_UNIQUE', suggestions: rollMatches.map((e) => buildSuggestion(e, 0.7, 'ROLL_AMBIGUOUS')) };
  }

  const exactNameMatches = findNameMatches(roster, name);
  if (exactNameMatches.length === 1 && (identityConfidence || 0) >= offlineEvaluationConfig.CANDIDATE_MATCH_AUTO_CONFIDENCE) {
    return {
      status: 'AUTO_MAP',
      candidateId: exactNameMatches[0].userId,
      enrollmentId: exactNameMatches[0].enrollmentId,
      confidence: Math.max(identityConfidence || 0.8, 0.8),
      method: 'MANUAL',
    };
  }
  if (exactNameMatches.length > 1) {
    return {
      status: 'NEEDS_MAPPING',
      conflict: 'NAME_NOT_UNIQUE',
      suggestions: exactNameMatches.map((e) => buildSuggestion(e, 0.75, 'NAME_AMBIGUOUS')),
    };
  }

  const suggestions = suggestFromRoster({ roster, detectedRollNumber, detectedCandidateName, detectedExternalStudentId, originalFileName });
  const best = suggestions[0];
  const runnerUp = suggestions[1];
  // File names are never primary identity evidence and must never auto-map.
  if (
    best
    && best.reason !== 'FILE_NAME_HINT'
    && best.score >= offlineEvaluationConfig.CANDIDATE_MATCH_AUTO_CONFIDENCE
    && (!runnerUp || best.score - runnerUp.score >= 0.12)
  ) {
    return {
      status: 'AUTO_MAP',
      candidateId: best.userId,
      enrollmentId: best.enrollmentId,
      confidence: best.score,
      method: 'MANUAL',
    };
  }

  return { status: 'NEEDS_MAPPING', suggestions };
};
