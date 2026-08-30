import AnswerScript from '../../models/AnswerScript.js';
import AnswerScriptBatch from '../../models/AnswerScriptBatch.js';

export const refreshAnswerScriptBatchCounters = async (batchId) => {
  if (!batchId) return null;
  const batch = await AnswerScriptBatch.findById(batchId);
  if (!batch) return null;

  const scripts = await AnswerScript.find({ batchId }).select('status').lean();
  let queued = 0;
  let uploading = 0;
  let processing = 0;
  let needsMapping = 0;
  let needsReview = 0;
  let completed = 0;
  let failed = 0;
  let duplicates = 0;
  let cancelled = 0;

  scripts.forEach((script) => {
    const status = String(script.status || '').toUpperCase();
    if (status === 'UPLOADING') uploading += 1;
    else if (['UPLOADED', 'QUEUED'].includes(status)) queued += 1;
    else if (['NORMALIZING', 'IDENTIFYING_CANDIDATE', 'CANDIDATE_LOCKED', 'SEGMENTING', 'EXTRACTING', 'EVALUATING', 'FINALIZING', 'PROCESSING'].includes(status)) processing += 1;
    else if (status === 'NEEDS_MAPPING') needsMapping += 1;
    else if (['NEEDS_REVIEW', 'REVIEWING'].includes(status)) needsReview += 1;
    else if (['COMPLETED', 'EVALUATED', 'FINALIZED', 'PROCESSED'].includes(status)) completed += 1;
    else if (status === 'FAILED') failed += 1;
    else if (status === 'POSSIBLE_DUPLICATE') duplicates += 1;
    else if (status === 'CANCELLED') cancelled += 1;
  });

  batch.totalFiles = scripts.length;
  batch.uploadingCount = uploading;
  batch.queuedCount = queued;
  batch.processingCount = processing;
  batch.needsMappingCount = needsMapping;
  batch.needsReviewCount = needsReview;
  batch.completedCount = completed;
  batch.failedCount = failed;
  batch.duplicateCount = duplicates;
  batch.cancelledCount = cancelled;
  const resolved = completed + needsReview + needsMapping + failed + duplicates + cancelled;
  if (uploading) batch.status = 'UPLOADING';
  else if ((failed || duplicates || cancelled) && resolved >= batch.totalFiles) batch.status = completed || needsReview || needsMapping ? 'PARTIAL' : 'FAILED';
  else if (resolved >= batch.totalFiles && batch.totalFiles > 0) batch.status = 'COMPLETED';
  else batch.status = processing ? 'PROCESSING' : 'QUEUED';
  if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(batch.status)) batch.completedAt = batch.completedAt || new Date();
  await batch.save();
  return batch;
};
