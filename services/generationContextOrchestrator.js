import { embedSingleText } from './contextIngestionService.js';
import { retrieveGroundingChunks } from './contextRetrievalService.js';
import { vectorSearchContextChunks } from './contextVectorSearchService.js';
import { resolveLibraryResourcesToContextSourceIds } from './libraryResourceService.js';
import { listEligibleAutoContextResources, previewAutoContextResources } from './knowledgeMemoryService.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import ingestionConfig from '../config/ingestionConfig.js';
import { buildQueryText } from './groundedGenerationService.js';

export const CONTEXT_MODES = Object.freeze({
  STANDARD: 'STANDARD',
  AUTO_CONTEXT: 'AUTO_CONTEXT',
  SELECTED_CONTEXT: 'SELECTED_CONTEXT',
  STRICT_SOURCE: 'STRICT_SOURCE',
});

export class InsufficientContextError extends Error {
  constructor(message, code = 'INSUFFICIENT_CONTEXT') {
    super(message);
    this.name = 'InsufficientContextError';
    this.code = code;
  }
}

const resolveSourceIdsForMode = async ({
  user,
  contextMode,
  selectedLibraryResourceIds = [],
  selectedContextSourceIds = [],
  academicContext = {},
  topic = '',
}) => {
  const mode = String(contextMode || CONTEXT_MODES.STANDARD).toUpperCase();
  if (mode === CONTEXT_MODES.STANDARD) return { mode, sourceIds: [], libraryResourceIds: [] };

  if (selectedContextSourceIds?.length) {
    return { mode, sourceIds: selectedContextSourceIds, libraryResourceIds: selectedLibraryResourceIds || [] };
  }

  if (selectedLibraryResourceIds?.length) {
    const sourceIds = await resolveLibraryResourcesToContextSourceIds(user, selectedLibraryResourceIds);
    return { mode, sourceIds, libraryResourceIds: selectedLibraryResourceIds };
  }

  if (mode === CONTEXT_MODES.AUTO_CONTEXT) {
    const visibility = await resolveAcademicVisibility(user);
    const eligible = await listEligibleAutoContextResources({
      tenantId: visibility.tenantId,
      user: { ...user, visibilityRecord: visibility },
      academicScope: academicContext,
      topic,
      courseId: academicContext?.courseId,
    });
    if (!eligible.length) {
      // No eligible institution knowledge is not fatal — the caller falls
      // back to topic-based generation so the request is still fulfilled
      // (Blueprint §4C). Only STRICT_SOURCE refuses on missing material.
      return { mode, sourceIds: [], libraryResourceIds: [] };
    }
    const libraryResourceIds = eligible.slice(0, 10).map((r) => r._id);
    const sourceIds = await resolveLibraryResourcesToContextSourceIds(user, libraryResourceIds);
    return { mode, sourceIds, libraryResourceIds };
  }

  throw new InsufficientContextError('Selected or automatic institution knowledge is required for this context mode.', 'CONTEXT_REQUIRED');
};

export const buildGenerationContext = async ({
  user,
  creationMode = 'STANDARD',
  academicContext = {},
  assessmentPurpose = null,
  resolvedSpecification = null,
  topic = '',
  questionBlueprint = null,
  selectedLibraryResourceIds = [],
  selectedContextSourceIds = [],
  contextMode = CONTEXT_MODES.STANDARD,
  creatorInstructions = '',
  instructions = '',
}) => {
  const mode = String(contextMode || CONTEXT_MODES.STANDARD).toUpperCase();
  const visibility = await resolveAcademicVisibility(user);

  const base = {
    tenantId: visibility.tenantId,
    creationMode,
    contextMode: mode,
    academicContext,
    assessmentPurpose,
    resolvedSpecification,
    topic,
    questionBlueprint,
    creatorInstructions: creatorInstructions || instructions,
    governanceRules: resolvedSpecification?.rules || null,
    cognitiveTargets: resolvedSpecification?.rules?.cognitiveDemandDistribution || null,
    difficultyTargets: resolvedSpecification?.rules?.difficultyDistribution || null,
    bloomTargets: resolvedSpecification?.rules?.bloomDistribution || null,
    retrievedChunks: [],
    sourceProvenance: [],
    questionHistoryExclusions: [],
    selectedLibraryResourceIds: [],
    selectedContextSourceIds: [],
  };

  if (mode === CONTEXT_MODES.STANDARD) return base;

  const { sourceIds, libraryResourceIds } = await resolveSourceIdsForMode({
    user,
    contextMode: mode,
    selectedLibraryResourceIds,
    selectedContextSourceIds,
    academicContext,
    topic,
  });

  if (!sourceIds.length) {
    // STRICT_SOURCE still refuses (its UI copy promises "only from selected
    // material"). SELECTED_CONTEXT / AUTO_CONTEXT no longer hard-fail on a
    // thin selection: the caller (routes/ai.js) grounds what it can and tops
    // up the remainder on the same topic — see Blueprint §4C.
    if (mode === CONTEXT_MODES.STRICT_SOURCE) {
      throw new InsufficientContextError('Insufficient source material for Strict Source Only generation.', 'NO_READY_SOURCES');
    }
    return { ...base, selectedLibraryResourceIds: libraryResourceIds || [], contextShortfall: { reason: 'NO_READY_SOURCES' } };
  }

  const queryText = buildQueryText({ topic, instructions: creatorInstructions || instructions, questionTypes: questionBlueprint?.questionTypes });
  const queryEmbedding = await embedSingleText(queryText, { tenantId: visibility.tenantId, userId: user._id });

  let retrievedChunks = await vectorSearchContextChunks({
    tenantId: visibility.tenantId,
    sourceIds,
    queryEmbedding,
    topK: sourceGroundedConfig.RETRIEVAL_TOP_K,
  });
  if (!retrievedChunks.length) {
    retrievedChunks = await retrieveGroundingChunks({
      tenantId: visibility.tenantId,
      sourceIds,
      queryEmbedding,
      topK: sourceGroundedConfig.RETRIEVAL_TOP_K,
    });
  }

  if (!retrievedChunks.length && mode === CONTEXT_MODES.STRICT_SOURCE) {
    throw new InsufficientContextError('Insufficient relevant institution material for Strict Source Only generation.', 'INSUFFICIENT_SOURCE_CONTEXT');
  }

  const trimChunksToTokenBudget = (chunks, maxTokens = ingestionConfig.AUTO_CONTEXT_MAX_TOKENS) => {
    const selected = [];
    let usedTokens = 0;
    for (const chunk of chunks) {
      const pieceTokens = Math.ceil(String(chunk.text || '').length / ingestionConfig.CHARS_PER_TOKEN_ESTIMATE);
      if (usedTokens + pieceTokens > maxTokens) break;
      selected.push(chunk);
      usedTokens += pieceTokens;
    }
    return { selected, usedTokens, candidateCount: chunks.length };
  };

  const budgeted = trimChunksToTokenBudget(retrievedChunks);
  retrievedChunks = budgeted.selected;

  // SELECTED_CONTEXT / AUTO_CONTEXT: an empty retrieval is not fatal — return
  // the resolved sourceIds so routes/ai.js can still ground against the raw
  // chunks and top up the shortfall (Blueprint §4C). STRICT_SOURCE already
  // threw above.
  const contextShortfall = !retrievedChunks.length ? { reason: 'NO_RETRIEVED_CONTEXT' } : null;

  return {
    ...base,
    contextMode: mode,
    ...(contextShortfall ? { contextShortfall } : {}),
    selectedLibraryResourceIds: libraryResourceIds,
    selectedContextSourceIds: sourceIds,
    retrievedChunks,
    contextDiagnostics: {
      candidateChunks: budgeted.candidateCount,
      selectedChunks: retrievedChunks.length,
      selectedContextTokens: budgeted.usedTokens,
    },
    sourceProvenance: retrievedChunks.map((chunk, index) => ({
      chunkIndex: index + 1,
      sourceId: chunk.sourceId,
      libraryResourceId: chunk.libraryResourceId || null,
      textPreview: String(chunk.text || '').slice(0, 200),
    })),
    previewResources: await previewAutoContextResources({
      tenantId: visibility.tenantId,
      user: { ...user, visibilityRecord: visibility },
      academicContext,
      topic,
      courseId: academicContext?.courseId,
    }),
  };
};
