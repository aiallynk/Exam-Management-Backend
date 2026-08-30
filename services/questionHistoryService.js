import QuestionIntelligenceSignal from '../models/QuestionIntelligenceSignal.js';
import { updateTenantGenerationProfileFromSignal } from './tenantGenerationProfileService.js';

// Question Generation History + creator-feedback signals (spec Parts 12–15).
// This is a controlled, tenant-scoped learning loop — NOT model fine-tuning.
// Signals are append-only, never mutate a historic question, and are only
// ever read back through tenant-local aggregation. No signal here creates a
// provider fine-tune job (there is no such code path anywhere).

const SIGNAL_BY_OUTCOME = {
  GENERATED: 'QUESTION_GENERATED',
  ACCEPTED: 'QUESTION_APPROVED',
  EDITED: 'QUESTION_HUMAN_EDITED',
  REJECTED: 'QUESTION_REJECTED',
  REGENERATED: 'QUESTION_REGENERATED',
  SAVED_TO_BANK: 'QUESTION_SAVED_TO_BANK',
  USED_IN_EXAM: 'QUESTION_USED',
};

const s = (v) => (v == null ? undefined : String(v));

const fingerprintsFromProvenance = (provenance) => {
  const refs = provenance && Array.isArray(provenance.sourceReferences) ? provenance.sourceReferences : [];
  const hashes = refs.map((r) => r.evidenceHash).filter(Boolean);
  return hashes.length ? [...new Set(hashes)] : undefined;
};

const write = async (doc) => {
  try {
    const row = await QuestionIntelligenceSignal.create(doc);
    // Fold the signal into the rolling tenant profile (guarded by sample size
    // inside the profile service). Never blocks, never throws upward.
    void updateTenantGenerationProfileFromSignal(row).catch(() => {});
    return row;
  } catch {
    return null;
  }
};

/**
 * One row per generate-questions call (batch-level), plus lightweight
 * per-question context. Fire-and-forget from routes/ai.js.
 */
export const recordGenerationEvent = async ({
  tenantId,
  userId = null,
  assessmentId = null,
  generationRunId = null,
  generationMode = 'STANDARD',
  questionTypes = [],
  difficulty,
  topic,
  questions = [],
}) => {
  if (!tenantId) return null;
  const grounded = questions.filter((q) => q?.provenance?.sourceReferences?.length);
  return write({
    tenantId,
    signalType: 'QUESTION_GENERATED',
    outcome: 'GENERATED',
    userId,
    assessmentId,
    generationRunId,
    generationMode,
    difficulty: s(difficulty),
    topic: s(topic),
    questionType: questionTypes.length === 1 ? questionTypes[0] : undefined,
    metadata: {
      requestedTypes: questionTypes,
      generatedCount: questions.length,
      groundedCount: grounded.length,
      supplementedCount: questions.length - grounded.length,
    },
  });
};

/**
 * A single creator decision on one question (Use This Question / Manual Edit /
 * AI Modify / Reject / Save to Bank / Used in exam).
 */
export const recordCreatorDecision = async ({
  tenantId,
  outcome,
  userId = null,
  assessmentId = null,
  generationRunId = null,
  questionId = null,
  questionVersionId = null,
  question = null,
  editDistance = null,
  semanticDelta = null,
}) => {
  if (!tenantId || !SIGNAL_BY_OUTCOME[outcome]) return null;
  const provenance = question?.provenance || null;
  return write({
    tenantId,
    signalType: SIGNAL_BY_OUTCOME[outcome],
    outcome,
    userId,
    assessmentId,
    generationRunId: generationRunId || provenance?.generationRunId || null,
    questionId,
    questionVersionId,
    generationMode: provenance?.generationMode,
    questionType: s(question?.questionType),
    difficulty: s(question?.difficulty),
    bloomLevel: s(question?.bloomLevel),
    cognitiveDemand: s(question?.cognitiveDemand),
    topic: s(provenance?.creatorInstructionSnapshot ? undefined : question?.topic),
    sourceFingerprints: fingerprintsFromProvenance(provenance),
    metadata: {
      stemLength: question?.questionText ? String(question.questionText).length : undefined,
      editDistance: editDistance == null ? undefined : editDistance,
      semanticDelta: semanticDelta == null ? undefined : semanticDelta,
      groundingVerdict: provenance?.groundingVerdict,
      revalidationState: provenance?.revalidationState,
    },
  });
};

export { SIGNAL_BY_OUTCOME };
