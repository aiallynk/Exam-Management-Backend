import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import { generateGroundedCandidates } from './groundedGenerationService.js';
import { isQuestionGrounded } from './groundingValidatorService.js';
import { createBatchNoveltyTracker, probeNovelty, reserveNovelty } from './noveltyService.js';
import { evaluateQuestionRepeatPolicy, REPEAT_POLICIES, recordQuestionIntelligenceSignal, SIGNAL_TYPES } from './questionMemoryService.js';
import { normalizeQuestionType } from '../utils/questionTypeRegistry.js';

// Source-Grounded AI Question Generation — the candidate-pool pipeline
// (master prompt §25-26): oversample -> grounding-validate ->
// novelty-validate -> accept until targetCount or attempt budget
// exhausted. Never relaxes grounding/novelty to hit the requested count —
// returns however many genuinely valid questions it found, plus
// diagnostics explaining why it stopped short.

const REJECTION_REASONS = Object.freeze({
  INVALID_SHAPE: 'INVALID_SHAPE',
  NOT_GROUNDED: 'NOT_GROUNDED',
  DUPLICATE_BATCH: 'DUPLICATE_BATCH',
  DUPLICATE_NOVELTY: 'DUPLICATE_NOVELTY',
  MEMORY_BLOCKED: 'MEMORY_BLOCKED',
  MEMORY_REGENERATE: 'MEMORY_REGENERATE',
});

const bumpReason = (reasons, key) => {
  reasons[key] = (reasons[key] || 0) + 1;
};

const normalizeDistribution = (distribution = []) => {
  const counts = {};
  (Array.isArray(distribution) ? distribution : []).forEach((item) => {
    const type = normalizeQuestionType(item?.type);
    const count = Math.max(0, Number.parseInt(item?.count, 10) || 0);
    if (type && count > 0) counts[type] = (counts[type] || 0) + count;
  });
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
};

const resolveMissingDistribution = (requestedDistribution, acceptedByType) =>
  requestedDistribution
    .map(({ type, count }) => ({
      type,
      count: Math.max(count - (acceptedByType[type] || 0), 0),
    }))
    .filter((item) => item.count > 0);

const oversampleDistribution = (distribution) =>
  distribution.map(({ type, count }) => ({
    type,
    count: Math.max(count, Math.ceil(count * sourceGroundedConfig.CANDIDATE_POOL_OVERSAMPLE_FACTOR)),
  }));

/**
 * Runs the full oversample -> validate -> accept loop for one
 * generate-questions call. `generatorFn` defaults to
 * generateGroundedCandidates but is injectable for testing.
 */
export const generateWithNoveltyAndGrounding = async ({
  tenantId,
  userId,
  generationRunId,
  sourceIds,
  topic,
  instructions,
  difficulty,
  questionTypes,
  questionTypeDistribution = [],
  targetCount,
  examTitle,
  examDescription,
  blueprintTopic,
  generatorFn = generateGroundedCandidates,
  groundingFn = isQuestionGrounded,
  noveltyProbeFn = probeNovelty,
  noveltyReserveFn = reserveNovelty,
  memoryPolicyFn = evaluateQuestionRepeatPolicy,
  batchTrackerFactory = createBatchNoveltyTracker,
  memoryPolicy = null,
  maxMemoryRegenerations = 2,
}) => {
  const accepted = [];
  const acceptedByType = {};
  const requestedDistribution = normalizeDistribution(questionTypeDistribution);
  const exactDistributionRequested = requestedDistribution.length > 0;
  const effectiveTargetCount = exactDistributionRequested
    ? requestedDistribution.reduce((sum, item) => sum + item.count, 0)
    : targetCount;
  const rejectionReasons = {};
  const batchTracker = batchTrackerFactory();
  let insufficientSourceMaterial = false;
  let insufficientReason = null;
  let attempts = 0;
  let consecutiveEmptyAttempts = 0;
  // Flips on once an attempt comes back LLM_REPORTED_INSUFFICIENT — which
  // only ever happens when chunks WERE retrieved but the model still
  // refused (see generateGroundedCandidates) — most often because a
  // narrow/generic Topic was interpreted too literally against specific
  // source passages. Every subsequent attempt in this loop then drops the
  // Topic from the retrieval query and asks the model to interpret it
  // broadly, instead of repeating the exact same request and getting the
  // same refusal again.
  let broadenFocus = false;
  let memoryRegenerationBudget = maxMemoryRegenerations;

  const resolvedMemoryPolicy = memoryPolicy || {
    exact: REPEAT_POLICIES.BLOCK,
    semantic: REPEAT_POLICIES.WARN,
    recentUsage: REPEAT_POLICIES.REGENERATE,
  };

  while (
    accepted.length < effectiveTargetCount &&
    attempts < sourceGroundedConfig.CANDIDATE_POOL_MAX_ATTEMPTS &&
    consecutiveEmptyAttempts < 2
  ) {
    attempts += 1;
    const missingDistribution = exactDistributionRequested
      ? resolveMissingDistribution(requestedDistribution, acceptedByType)
      : [];
    const attemptDistribution = exactDistributionRequested
      ? oversampleDistribution(missingDistribution)
      : [];
    const remaining = effectiveTargetCount - accepted.length;
    const requestCount = exactDistributionRequested
      ? attemptDistribution.reduce((sum, item) => sum + item.count, 0)
      : Math.ceil(remaining * sourceGroundedConfig.CANDIDATE_POOL_OVERSAMPLE_FACTOR);
    const attemptQuestionTypes = exactDistributionRequested
      ? missingDistribution.map((item) => item.type)
      : questionTypes;

    const {
      candidates,
      insufficientSourceMaterial: attemptInsufficient,
      insufficientReason: attemptInsufficientReason,
    } = await generatorFn({
      tenantId,
      userId,
      sourceIds,
      topic,
      instructions,
      difficulty,
      questionTypes: attemptQuestionTypes,
      questionTypeDistribution: attemptDistribution,
      count: requestCount,
      examTitle,
      examDescription,
      excludeQuestionTexts: accepted.map((question) => question.questionText),
      broadenFocus,
    });

    if (attemptInsufficient) {
      insufficientSourceMaterial = true;
      insufficientReason = insufficientReason || attemptInsufficientReason || null;
      if (attemptInsufficientReason === 'LLM_REPORTED_INSUFFICIENT') {
        broadenFocus = true;
      }
    }

    if (!candidates.length) {
      consecutiveEmptyAttempts += 1;
      continue;
    }
    consecutiveEmptyAttempts = 0;

    for (const candidate of candidates) {
      if (accepted.length >= effectiveTargetCount) break;

      if (!candidate?.questionText || !candidate?.questionType) {
        bumpReason(rejectionReasons, REJECTION_REASONS.INVALID_SHAPE);
        continue;
      }

      const candidateType = normalizeQuestionType(candidate.questionType);
      if (!candidateType) {
        bumpReason(rejectionReasons, REJECTION_REASONS.INVALID_SHAPE);
        continue;
      }
      // A valid but over-produced type is not allowed to consume another
      // type's quota. Ignore it before grounding/novelty reservation and
      // let the next attempt request only the still-missing type(s).
      if (
        exactDistributionRequested &&
        (acceptedByType[candidateType] || 0) >=
          (requestedDistribution.find((item) => item.type === candidateType)?.count || 0)
      ) {
        continue;
      }

      if (batchTracker.isDuplicate(candidate)) {
        bumpReason(rejectionReasons, REJECTION_REASONS.DUPLICATE_BATCH);
        continue;
      }

      const grounding = await groundingFn({
        questionText: candidate.questionText,
        correctAnswer: candidate.correctAnswer,
        retrievedChunks: candidate.retrievedChunksForValidation || [],
        tenantId,
        userId,
      });
      if (!grounding.grounded) {
        bumpReason(rejectionReasons, REJECTION_REASONS.NOT_GROUNDED);
        continue;
      }

      const blueprint = {
        topic: blueprintTopic || topic,
        concept: candidate.category || candidate.title || topic,
        answerFingerprint: candidate.correctAnswer,
        questionType: candidate.questionType,
        difficulty,
      };

      const memoryCheck = await memoryPolicyFn({
        tenantId,
        question: candidate,
        blueprint,
        policy: resolvedMemoryPolicy,
        userId,
      });

      if (memoryCheck.decision === REPEAT_POLICIES.BLOCK) {
        bumpReason(rejectionReasons, REJECTION_REASONS.MEMORY_BLOCKED);
        await recordQuestionIntelligenceSignal({
          tenantId,
          signalType: SIGNAL_TYPES.QUESTION_REJECTED,
          metadata: { reason: 'MEMORY_BLOCK', outcomes: memoryCheck.outcomes },
        });
        continue;
      }

      if (memoryCheck.decision === REPEAT_POLICIES.REGENERATE) {
        bumpReason(rejectionReasons, REJECTION_REASONS.MEMORY_REGENERATE);
        memoryRegenerationBudget -= 1;
        await recordQuestionIntelligenceSignal({
          tenantId,
          signalType: SIGNAL_TYPES.QUESTION_REGENERATED,
          metadata: { reason: 'MEMORY_REGENERATE', outcomes: memoryCheck.outcomes },
        });
        if (memoryRegenerationBudget <= 0) {
          bumpReason(rejectionReasons, REJECTION_REASONS.MEMORY_BLOCKED);
        }
        continue;
      }

      const probe = await noveltyProbeFn({ tenantId, question: candidate, blueprint });
      if (probe.likelyDuplicate) {
        bumpReason(rejectionReasons, REJECTION_REASONS.DUPLICATE_NOVELTY);
        continue;
      }

      const reservation = await noveltyReserveFn({ tenantId, question: candidate, blueprint, generationRunId });
      if (!reservation.novel) {
        bumpReason(rejectionReasons, REJECTION_REASONS.DUPLICATE_NOVELTY);
        continue;
      }

      batchTracker.record(candidate);
      // eslint-disable-next-line no-unused-vars
      const { retrievedChunksForValidation, ...candidateWithoutTransientFields } = candidate;
      accepted.push({
        ...candidateWithoutTransientFields,
        provenance: {
          ...candidate.provenance,
          generationRunId,
          memoryDecision: memoryCheck.decision,
          memoryWarnings: memoryCheck.decision === REPEAT_POLICIES.WARN ? memoryCheck.outcomes : undefined,
          noveltySignatures: {
            exact: reservation.exactSignature,
            near: reservation.nearSignature,
            blueprint: reservation.blueprintSignature,
          },
        },
      });
      acceptedByType[candidateType] = (acceptedByType[candidateType] || 0) + 1;
    }
  }

  const rejectedCount = Object.values(rejectionReasons).reduce((sum, count) => sum + count, 0);

  // When the shortfall isn't explained by insufficientSourceMaterial (the
  // LLM/retrieval never said "not enough material"), the actual cause is
  // whichever rejection reason fired most often — e.g. every candidate
  // failed grounding validation, or every candidate duplicated existing
  // content. Surfaced so the caller can show a specific message (master
  // prompt §44) instead of one generic "insufficient" string for every
  // distinct failure mode.
  let dominantRejectionReason = null;
  if (accepted.length < effectiveTargetCount && !insufficientReason && rejectedCount > 0) {
    dominantRejectionReason = Object.entries(rejectionReasons).sort((a, b) => b[1] - a[1])[0][0];
  }

  const missingDistribution = exactDistributionRequested
    ? resolveMissingDistribution(requestedDistribution, acceptedByType)
    : [];

  return {
    questions: accepted.map((question, index) => ({ ...question, order: index + 1 })),
    acceptedCount: accepted.length,
    rejectedCount,
    rejectionReasons,
    insufficientSourceMaterial: insufficientSourceMaterial && accepted.length < effectiveTargetCount,
    insufficientReason: accepted.length < effectiveTargetCount ? insufficientReason : null,
    dominantRejectionReason,
    attempts,
    requestedDistribution: Object.fromEntries(requestedDistribution.map(({ type, count }) => [type, count])),
    generatedDistribution: { ...acceptedByType },
    missingDistribution,
  };
};
