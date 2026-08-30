import { normalizeRegion } from './answerAnnotationService.js';

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'that', 'this', 'with', 'as', 'by', 'it']);

export const normalizeEvidencePhrase = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^\w\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const tokenOverlapScore = (left, right) => {
  const a = normalizeEvidencePhrase(left).split(' ').filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const b = normalizeEvidencePhrase(right).split(' ').filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const overlap = a.filter((word) => setB.has(word)).length;
  return overlap / Math.max(a.length, b.length);
};

const mergeRegions = (regions = []) => {
  const valid = regions.map((region) => normalizeRegion(region)).filter(Boolean);
  if (!valid.length) return null;
  const x = Math.min(...valid.map((region) => region.x));
  const y = Math.min(...valid.map((region) => region.y));
  const right = Math.max(...valid.map((region) => region.x + region.width));
  const bottom = Math.max(...valid.map((region) => region.y + region.height));
  return normalizeRegion({ x, y, width: right - x, height: bottom - y });
};

export const matchPhraseToLineBoxes = (phrase, lineBoxes = [], { minScore = 0.45 } = {}) => {
  const normalizedPhrase = normalizeEvidencePhrase(phrase);
  if (!normalizedPhrase || normalizedPhrase.length < 4) return null;
  let best = null;
  for (const line of lineBoxes || []) {
    const region = normalizeRegion(line);
    if (!region) continue;
    const score = tokenOverlapScore(normalizedPhrase, line.text || '');
    if (score >= minScore && (!best || score > best.score)) {
      best = { region, score, lineId: line.id || '', evidenceText: String(line.text || '').slice(0, 500) };
    }
  }
  if (best) return best;
  const phraseTokens = normalizedPhrase.split(' ').filter((word) => word.length > 2);
  if (phraseTokens.length < 2) return null;
  const matched = [];
  for (const token of phraseTokens.slice(0, 8)) {
    const hit = (lineBoxes || []).find((line) => normalizeEvidencePhrase(line.text).includes(token));
    if (hit) matched.push(hit);
  }
  if (matched.length >= Math.min(2, phraseTokens.length)) {
    const region = mergeRegions(matched);
    if (region) {
      return {
        region,
        score: matched.length / phraseTokens.length,
        lineId: matched[0]?.id || '',
        evidenceText: matched.map((line) => line.text).join(' ').slice(0, 500),
      };
    }
  }
  return null;
};

const marginRegionForSegment = (segment, index = 0) => {
  const base = normalizeRegion(segment?.boundingRegion);
  if (!base) return null;
  const width = Math.min(0.22, Math.max(0.14, base.width * 0.28));
  const height = Math.min(0.05, Math.max(0.032, base.height * 0.14));
  return normalizeRegion({
    x: Math.min(0.84, base.x + base.width + 0.012),
    y: Math.min(0.94, base.y + index * (height + 0.012)),
    width,
    height,
  });
};

export const buildEvidenceObservations = (result = {}) => {
  const ai = result?.aiEvaluation && typeof result.aiEvaluation === 'object' ? result.aiEvaluation : {};
  const observations = [];
  const push = (entry) => {
    if (!entry?.feedback && !entry?.quotedText) return;
    observations.push(entry);
  };
  (Array.isArray(ai.correctConcepts) ? ai.correctConcepts : []).slice(0, 2).forEach((concept) => {
    push({ type: 'CORRECT', quotedText: String(concept), feedback: String(concept).slice(0, 300) });
  });
  (Array.isArray(ai.incorrectStatements) ? ai.incorrectStatements : []).slice(0, 4).forEach((statement) => {
    push({ type: 'INCORRECT', quotedText: String(statement), feedback: String(statement).slice(0, 300), severity: 'major' });
  });
  (Array.isArray(ai.missingConcepts) ? ai.missingConcepts : []).slice(0, 4).forEach((concept) => {
    push({ type: 'MISSING', quotedText: '', feedback: `Missing: ${String(concept).slice(0, 220)}`, severity: 'major' });
  });
  if (Number(result?.pointsEarned || 0) > 0 && Number(result?.maxScore || 0) > 0 && Number(result.pointsEarned) < Number(result.maxScore)) {
    push({
      type: 'PARTIAL',
      quotedText: '',
      feedback: String(result.feedback || ai.feedback || 'Partial credit awarded.').slice(0, 300),
      severity: 'minor',
    });
  }
  const providerObservations = Array.isArray(result?.observations)
    ? result.observations
    : Array.isArray(ai.observations) ? ai.observations : [];
  providerObservations.forEach((item) => {
    const type = String(item?.type || 'COMMENT').toUpperCase();
    if (!['CORRECT', 'INCORRECT', 'PARTIAL', 'MISSING'].includes(type)) return;
    push({
      type,
      quotedText: item?.quotedText || item?.evidenceText || '',
      feedback: item?.feedback || item?.message || '',
      rubricCriterionId: item?.rubricCriterionId || '',
      severity: item?.severity || 'minor',
    });
  });
  return observations;
};

export const mapObservationsToAnnotations = ({ segment, result, pageId }) => {
  if (!pageId) return [];
  const lineBoxes = Array.isArray(segment?.lineBoxes) ? segment.lineBoxes : [];
  const observations = buildEvidenceObservations(result);
  const items = [];
  let marginIndex = 0;
  observations.forEach((observation) => {
    const type = observation.type === 'MISSING' ? 'MISSING_POINT' : observation.type;
    const phrase = observation.quotedText || observation.feedback;
    const match = observation.type === 'MISSING'
      ? null
      : matchPhraseToLineBoxes(phrase, lineBoxes);
    const region = match?.region || marginRegionForSegment(segment, marginIndex);
    if (!region) return;
    if (!match) marginIndex += 1;
    items.push({
      type,
      region,
      lineId: match?.lineId || '',
      evidenceText: match?.evidenceText || observation.quotedText || '',
      message: String(observation.feedback || observation.quotedText || '').slice(0, 1000),
      confidence: match?.score ?? (observation.type === 'MISSING' ? 0.55 : 0.35),
    });
  });
  return items;
};
