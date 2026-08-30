import QuestionUsage from '../models/QuestionUsage.js';
import QuestionIntelligenceSignal from '../models/QuestionIntelligenceSignal.js';
import {
  buildCanonicalQuestionRepresentation,
  computeExactSignature,
  probeNovelty,
  reserveNovelty,
} from './noveltyService.js';
import { findSemanticQuestionMatches } from './questionEmbeddingService.js';
import { logError } from '../utils/logger.js';

const RECENT_USAGE_LOOKBACK_DAYS = Number(process.env.QUESTION_RECENT_USAGE_LOOKBACK_DAYS || 90);
const RECENT_USAGE_MIN_COUNT = Number(process.env.QUESTION_RECENT_USAGE_MIN_COUNT || 1);

export const REPEAT_POLICIES = Object.freeze({
  ALLOW: 'ALLOW',
  WARN: 'WARN',
  REGENERATE: 'REGENERATE',
  BLOCK: 'BLOCK',
});

const SIGNAL_TYPES = Object.freeze({
  QUESTION_APPROVED: 'QUESTION_APPROVED',
  QUESTION_REJECTED: 'QUESTION_REJECTED',
  QUESTION_HUMAN_EDITED: 'QUESTION_HUMAN_EDITED',
  QUESTION_REGENERATED: 'QUESTION_REGENERATED',
  QUESTION_USED: 'QUESTION_USED',
  QUESTION_REUSED: 'QUESTION_REUSED',
  HIGH_FAILURE_RATE: 'HIGH_FAILURE_RATE',
  EVALUATOR_OVERRIDE: 'EVALUATOR_OVERRIDE',
});

export const recordQuestionIntelligenceSignal = async ({ tenantId, signalType, questionId = null, questionVersionId = null, metadata = {} }) => {
  try {
    await QuestionIntelligenceSignal.create({
      tenantId,
      signalType,
      questionId,
      questionVersionId,
      metadata,
    });
  } catch (error) {
    logError(error, { context: 'questionMemoryService.recordSignal', tenantId, signalType });
  }
};

export const buildQuestionFingerprint = async ({ tenantId, question, userId = null }) => {
  const canonical = buildCanonicalQuestionRepresentation({
    questionText: question.questionText,
    options: question.options,
    correctAnswer: question.correctAnswer,
    questionType: question.questionType,
  });
  const exactSignature = computeExactSignature(canonical);
  const semantic = await findSemanticQuestionMatches({
    tenantId,
    queryText: question.questionText,
    limit: 5,
    userId,
  });
  return {
    exactSignature,
    semanticMatches: semantic.matches || [],
    questionType: question.questionType || null,
    difficulty: question.difficulty || null,
    bloomLevel: question.bloomLevel || null,
    cognitiveDemand: question.cognitiveDemand || null,
    topic: question.topic || null,
    concept: question.concept || null,
  };
};

const findRecentUsageMatches = async ({ tenantId, exactSignature, courseOfferingId = null }) => {
  const since = new Date(Date.now() - RECENT_USAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const usageFilter = {
    tenantId,
    occurredAt: { $gte: since },
    event: { $in: ['USED_IN_ASSESSMENT', 'PUBLISHED', 'SELECTED'] },
  };
  if (courseOfferingId) usageFilter.courseOfferingId = courseOfferingId;

  const recentUsages = await QuestionUsage.find(usageFilter)
    .sort({ occurredAt: -1 })
    .limit(200)
    .select('questionId questionVersionId examId occurredAt')
    .lean();
  if (recentUsages.length < RECENT_USAGE_MIN_COUNT) return [];

  return recentUsages.slice(0, 5).map((entry) => ({
    questionId: entry.questionId,
    questionVersionId: entry.questionVersionId,
    examId: entry.examId,
    occurredAt: entry.occurredAt,
    layer: 'RECENT_USAGE',
    signature: exactSignature,
  }));
};

export const evaluateQuestionRepeatPolicy = async ({
  tenantId,
  question,
  blueprint = null,
  userId = null,
  policy = { exact: REPEAT_POLICIES.BLOCK, semantic: REPEAT_POLICIES.WARN, recentUsage: REPEAT_POLICIES.WARN, conceptPattern: REPEAT_POLICIES.WARN },
  courseOfferingId = null,
}) => {
  const novelty = await probeNovelty({ tenantId, question, blueprint });
  const fingerprint = await buildQuestionFingerprint({ tenantId, question, userId });

  const outcomes = [];
  if (novelty.collision?.layer === 'EXACT') outcomes.push({ layer: 'EXACT', policy: policy.exact, detail: novelty.collision });
  if (novelty.collision?.layer === 'NEAR') outcomes.push({ layer: 'SEMANTIC', policy: policy.semantic, detail: novelty.collision });
  if (novelty.collision?.layer === 'BLUEPRINT') {
    outcomes.push({ layer: 'CONCEPT_PATTERN', policy: policy.conceptPattern || policy.recentUsage, detail: novelty.collision });
  }
  if ((fingerprint.semanticMatches || []).length) {
    outcomes.push({ layer: 'SEMANTIC_EMBEDDING', policy: policy.semantic, matches: fingerprint.semanticMatches });
  }

  const recentMatches = await findRecentUsageMatches({
    tenantId,
    exactSignature: fingerprint.exactSignature,
    courseOfferingId,
  });
  if (recentMatches.length >= RECENT_USAGE_MIN_COUNT) {
    outcomes.push({ layer: 'RECENT_USAGE', policy: policy.recentUsage, matches: recentMatches });
  }

  const severityOrder = [REPEAT_POLICIES.BLOCK, REPEAT_POLICIES.REGENERATE, REPEAT_POLICIES.WARN, REPEAT_POLICIES.ALLOW];
  const decision = outcomes.reduce((worst, entry) => {
    const currentIdx = severityOrder.indexOf(entry.policy || REPEAT_POLICIES.ALLOW);
    const worstIdx = severityOrder.indexOf(worst);
    return currentIdx < worstIdx ? entry.policy : worst;
  }, REPEAT_POLICIES.ALLOW);

  return { decision, outcomes, fingerprint, novelty };
};

export const claimQuestionMemory = async ({ tenantId, question, blueprint = null }) =>
  reserveNovelty({ tenantId, question, blueprint });

export const onQuestionPublished = async ({ tenantId, questionId, questionVersionId = null, frameworkVersionId = null, examId = null }) => {
  await QuestionUsage.create({
    tenantId,
    questionId,
    questionVersionId,
    frameworkVersionId,
    examId,
    event: 'PUBLISHED',
    occurredAt: new Date(),
  }).catch((error) => logError(error, { context: 'questionMemoryService.onQuestionPublished', tenantId, questionId }));
  await recordQuestionIntelligenceSignal({ tenantId, signalType: SIGNAL_TYPES.QUESTION_USED, questionId, questionVersionId });
};

export { SIGNAL_TYPES };

export const indexQuestionMemory = async ({ tenantId, userId, questionId, questionVersionId, questionText, questionType, difficulty }) => {
  const { recordQuestionEmbedding, recordQuestionVersionEmbedding } = await import('./questionEmbeddingService.js');
  if (questionVersionId) {
    await recordQuestionVersionEmbedding({ tenantId, questionVersionId, questionText, questionType, difficulty, userId });
  } else if (questionId) {
    await recordQuestionEmbedding({ tenantId, questionId, questionText, questionType, difficulty, userId });
  }
  return { indexed: true, questionId, questionVersionId };
};

export const mapFrameworkMemoryPolicy = (memoryRules = {}) => {
  const action = String(memoryRules.action || 'WARN').toUpperCase();
  const mapped = action === 'BLOCK' ? REPEAT_POLICIES.BLOCK : action === 'REGENERATE' ? REPEAT_POLICIES.REGENERATE : action === 'ALLOW' ? REPEAT_POLICIES.ALLOW : REPEAT_POLICIES.WARN;
  return { exact: mapped, semantic: mapped, recentUsage: mapped, conceptPattern: mapped };
};
