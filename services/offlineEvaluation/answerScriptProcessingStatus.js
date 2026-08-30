const PROCESSING_SCRIPT_STATUSES = new Set([
  'UPLOADED', 'QUEUED', 'NORMALIZING', 'IDENTIFYING_CANDIDATE', 'CANDIDATE_LOCKED',
  'SEGMENTING', 'EXTRACTING', 'EVALUATING', 'PROCESSING', 'FINALIZING',
]);

const STAGE_DEFINITIONS = [
  { id: 'UPLOADED', label: 'Upload received' },
  { id: 'PREPARING_PAGES', label: 'Pages prepared' },
  { id: 'OCR_PROCESSING', label: 'Reading handwriting' },
  { id: 'MAPPING_ANSWERS', label: 'Mapping answers' },
  { id: 'AI_EVALUATING', label: 'Evaluating responses' },
  { id: 'GENERATING_ANNOTATIONS', label: 'Adding teacher-style annotations' },
  { id: 'BUILDING_EVALUATED_PDF', label: 'Preparing evaluated PDF' },
  { id: 'READY_FOR_REVIEW', label: 'Ready for review' },
  { id: 'FINALIZED', label: 'Finalized' },
];

const resolveCurrentStage = (script = {}) => {
  const status = String(script.status || '').toUpperCase();
  const stage = String(script.processingMeta?.stage || '').toUpperCase();
  if (status === 'FAILED' || status === 'DERIVATIVE_FAILED') return 'FAILED';
  if (['COMPLETED', 'FINALIZED'].includes(status)) return 'FINALIZED';
  if (['EVALUATED', 'NEEDS_REVIEW', 'REVIEWING'].includes(status)) return 'READY_FOR_REVIEW';
  if (status === 'FINALIZING' || stage.includes('RENDER')) return 'BUILDING_EVALUATED_PDF';
  if (stage.includes('MATERIALIZE')) return 'GENERATING_ANNOTATIONS';
  if (status === 'EVALUATING' || stage.includes('EVALUATING')) return 'AI_EVALUATING';
  if (status === 'SEGMENTING' || stage.includes('SEGMENT') || status === 'NEEDS_MAPPING') return 'MAPPING_ANSWERS';
  if (status === 'EXTRACTING' || stage.includes('EXTRACT')) return 'OCR_PROCESSING';
  if (status === 'NORMALIZING' || status === 'QUEUED') return 'PREPARING_PAGES';
  if (status === 'UPLOADED') return 'UPLOADED';
  if (PROCESSING_SCRIPT_STATUSES.has(status)) return 'OCR_PROCESSING';
  return 'READY_FOR_REVIEW';
};

const stageIndex = (stageId) => {
  const index = STAGE_DEFINITIONS.findIndex((entry) => entry.id === stageId);
  return index >= 0 ? index : 0;
};

export const buildProcessingStatusPayload = (script = {}, { segments = [], evaluationSummary = {} } = {}) => {
  const currentStage = resolveCurrentStage(script);
  const currentIndex = stageIndex(currentStage);
  const stages = STAGE_DEFINITIONS.map((entry, index) => ({
    ...entry,
    state: currentStage === 'FAILED'
      ? (index <= currentIndex ? 'complete' : 'pending')
      : index < currentIndex ? 'complete' : index === currentIndex ? 'active' : 'pending',
  }));
  const totalPages = Number(script.processingMeta?.pagesTotal || script.pageCount || 0);
  const processedPages = Number(script.processingMeta?.pagesProcessed || 0);
  const totalQuestions = Number(evaluationSummary.questionCount || segments.filter((segment) => segment.questionId).length || 0);
  const evaluatedQuestions = Number(
    evaluationSummary.evaluatedCount
    || segments.filter((segment) => segment.evaluationStatus === 'EVALUATED').length
    || 0,
  );
  const status = String(script.status || '').toUpperCase();
  const polling = PROCESSING_SCRIPT_STATUSES.has(status);
  let message = stages.find((entry) => entry.id === currentStage)?.label || 'Processing';
  if (currentStage === 'OCR_PROCESSING' && totalPages > 0) {
    message = `Reading page ${Math.min(processedPages || 1, totalPages)} of ${totalPages}`;
  } else if (currentStage === 'AI_EVALUATING' && totalQuestions > 0) {
    message = `Evaluating question ${Math.min(evaluatedQuestions || 1, totalQuestions)} of ${totalQuestions}`;
  }
  return {
    status,
    currentStage,
    stages,
    processedPages,
    totalPages,
    evaluatedQuestions,
    totalQuestions,
    message,
    polling,
    updatedAt: script.processingMeta?.heartbeatAt || script.updatedAt || new Date(),
  };
};

export const isProcessingScriptStatus = (status) => PROCESSING_SCRIPT_STATUSES.has(String(status || '').toUpperCase());
