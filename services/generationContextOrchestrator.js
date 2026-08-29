import { embedSingleText } from './contextIngestionService.js';
import { retrieveGroundingChunks } from './contextRetrievalService.js';
import { vectorSearchContextChunks } from './contextVectorSearchService.js';
import { resolveLibraryResourcesToContextSourceIds } from './libraryResourceService.js';
import { listEligibleAutoContextResources } from './knowledgeMemoryService.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
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
      throw new InsufficientContextError('No eligible institution knowledge was found for this assessment context.', 'NO_AUTO_CONTEXT');
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
    if (mode === CONTEXT_MODES.STRICT_SOURCE || mode === CONTEXT_MODES.SELECTED_CONTEXT) {
      throw new InsufficientContextError('Insufficient source material for the selected context mode.', 'NO_READY_SOURCES');
    }
    return base;
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

  if (!retrievedChunks.length && (mode === CONTEXT_MODES.STRICT_SOURCE || mode === CONTEXT_MODES.SELECTED_CONTEXT)) {
    throw new InsufficientContextError('Insufficient source material was retrieved for generation.', 'INSUFFICIENT_SOURCE_MATERIAL');
  }

  return {
    ...base,
    contextMode: mode,
    selectedLibraryResourceIds: libraryResourceIds,
    selectedContextSourceIds: sourceIds,
    retrievedChunks,
    sourceProvenance: retrievedChunks.map((chunk, index) => ({
      chunkIndex: index + 1,
      sourceId: chunk.sourceId,
      libraryResourceId: chunk.libraryResourceId || null,
      similarity: chunk.similarity ?? null,
      textPreview: String(chunk.text || '').slice(0, 200),
    })),
  };
};
