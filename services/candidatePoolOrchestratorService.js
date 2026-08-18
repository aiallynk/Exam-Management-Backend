import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import { generateGroundedCandidates } from './groundedGenerationService.js';
import { isQuestionGrounded } from './groundingValidatorService.js';
import { createBatchNoveltyTracker, probeNovelty, reserveNovelty } from './noveltyService.js';

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
});

const bumpReason = (reasons, key) => {
  reasons[key] = (reasons[key] || 0) + 1;
};

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
  targetCount,
  examTitle,
  examDescription,
  juniorContext,
  blueprintTopic,
  generatorFn = generateGroundedCandidates,
}) => {
  const accepted = [];
  const rejectionReasons = {};
  const batchTracker = createBatchNoveltyTracker();
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

  while (
    accepted.length < targetCount &&
    attempts < sourceGroundedConfig.CANDIDATE_POOL_MAX_ATTEMPTS &&
    consecutiveEmptyAttempts < 2
  ) {
    attempts += 1;
    const remaining = targetCount - accepted.length;
    const requestCount = Math.ceil(remaining * sourceGroundedConfig.CANDIDATE_POOL_OVERSAMPLE_FACTOR);

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
      questionTypes,
      count: requestCount,
      examTitle,
      examDescription,
      juniorContext,
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
      if (accepted.length >= targetCount) break;

      if (!candidate?.questionText || !candidate?.questionType) {
        bumpReason(rejectionReasons, REJECTION_REASONS.INVALID_SHAPE);
        continue;
      }

      if (batchTracker.isDuplicate(candidate)) {
        bumpReason(rejectionReasons, REJECTION_REASONS.DUPLICATE_BATCH);
        continue;
      }

      const grounding = await isQuestionGrounded({
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

      const probe = await probeNovelty({ tenantId, question: candidate, blueprint });
      if (probe.likelyDuplicate) {
        bumpReason(rejectionReasons, REJECTION_REASONS.DUPLICATE_NOVELTY);
        continue;
      }

      const reservation = await reserveNovelty({ tenantId, question: candidate, blueprint, generationRunId });
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
          noveltySignatures: {
            exact: reservation.exactSignature,
            near: reservation.nearSignature,
            blueprint: reservation.blueprintSignature,
          },
        },
      });
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
  if (accepted.length < targetCount && !insufficientReason && rejectedCount > 0) {
    dominantRejectionReason = Object.entries(rejectionReasons).sort((a, b) => b[1] - a[1])[0][0];
  }

  return {
    questions: accepted.map((question, index) => ({ ...question, order: index + 1 })),
    acceptedCount: accepted.length,
    rejectedCount,
    rejectionReasons,
    insufficientSourceMaterial: insufficientSourceMaterial && accepted.length < targetCount,
    insufficientReason: accepted.length < targetCount ? insufficientReason : null,
    dominantRejectionReason,
    attempts,
  };
};
