import Exam from '../models/Exam.js';
import {
  autoGeneratePackagesOnPublish,
  getPackageInfo,
} from './examPackageService.js';
import { logError, logInfo } from '../utils/logger.js';

const PACKAGE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  GENERATED: 'GENERATED',
  FAILED: 'FAILED',
});

const inFlightRegeneration = new Set();
const pendingRegeneration = new Map();
const inFlightJobKeyByExam = new Map();
const lastCompletedJobKeyByExam = new Map();
const DEFAULT_BACKFILL_BATCH_SIZE = 100;
let startupBackfillQueued = false;

const buildLatestPackageUrl = (examId) =>
  `/api/exam-packages/${examId}/download`;

const normalizeQuestionPaperIds = (questionPaperIds) => {
  if (!Array.isArray(questionPaperIds)) return null;
  const values = questionPaperIds
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return values.length ? values : null;
};

const mergeQuestionPaperIds = (existingIds, incomingIds) => {
  const existing = normalizeQuestionPaperIds(existingIds) || [];
  const incoming = normalizeQuestionPaperIds(incomingIds) || [];
  const merged = [...new Set([...existing, ...incoming])];
  return merged.length ? merged : null;
};

const normalizeExamUpdatedAt = (value) => {
  if (!value) return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString();
};

const buildRegenerationJobKey = (examId, examUpdatedAt) => {
  const normalizedExamId = String(examId || '').trim();
  const normalizedUpdatedAt = normalizeExamUpdatedAt(examUpdatedAt);
  if (!normalizedExamId || !normalizedUpdatedAt) {
    return '';
  }
  return `${normalizedExamId}:${normalizedUpdatedAt}`;
};

const getLatestUpdatedAt = (existingUpdatedAt, incomingUpdatedAt) => {
  const normalizedExisting = normalizeExamUpdatedAt(existingUpdatedAt);
  const normalizedIncoming = normalizeExamUpdatedAt(incomingUpdatedAt);

  if (!normalizedExisting) return normalizedIncoming || '';
  if (!normalizedIncoming) return normalizedExisting;

  return normalizedIncoming > normalizedExisting
    ? normalizedIncoming
    : normalizedExisting;
};

const getSafeErrorMessage = (value, fallback = 'Unknown package regeneration error') => {
  const raw = String(value || '').trim();
  return raw ? raw.slice(0, 500) : fallback;
};

const updateExamPackageState = async (examId, update) => {
  await Exam.updateOne({ _id: examId }, { $set: update });
};

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const runRegenerationJob = async ({
  examId,
  userId,
  reason,
  forceRegenerate,
  questionPaperIds,
}) => {
  try {
    const exam = await Exam.findById(examId).select(
      '_id examType tenantId offlinePackageVersion packageVersion'
    );
    if (!exam) {
      logInfo(
        `Skipped package regeneration for missing exam ${examId} (${reason})`,
        'ExamPackageRegenerationService'
      );
      return;
    }

    if (exam.examType === 'OMR') {
      logInfo(
        `Skipped package regeneration for exam ${examId} (type=${exam.examType})`,
        'ExamPackageRegenerationService'
      );
      return;
    }
    if (!exam.tenantId) {
      const tenantError = `Exam ${examId} is missing tenantId. Package regeneration cannot proceed.`;
      await updateExamPackageState(examId, {
        packageStatus: PACKAGE_STATUS.FAILED,
        packageLastError: getSafeErrorMessage(tenantError, 'Package generation failed'),
        latestPackageUrl: '',
      });
      logInfo(tenantError, 'ExamPackageRegenerationService');
      return;
    }

    await updateExamPackageState(examId, {
      packageStatus: PACKAGE_STATUS.PROCESSING,
      packageLastError: '',
      latestPackageUrl: buildLatestPackageUrl(examId),
    });

    logInfo(
      `Package regeneration started for exam ${examId} (reason=${reason})`,
      'ExamPackageRegenerationService'
    );

    const generationResult = await autoGeneratePackagesOnPublish(examId, userId, {
      forceRegenerate: Boolean(forceRegenerate),
      questionPaperIds: normalizeQuestionPaperIds(questionPaperIds),
    });

    const latestPackage = await getPackageInfo(examId, null);
    const hasLatestPackage = Boolean(latestPackage);
    const hasGeneratedPackage = generationResult.generated > 0;
    const hasErrors = generationResult.errors.length > 0;

    if (!hasErrors && (hasGeneratedPackage || hasLatestPackage)) {
      const resolvedVersion = Number(
        latestPackage?.version ??
          exam.packageVersion ??
          exam.offlinePackageVersion ??
          0
      );
      const generatedAt = latestPackage?.createdAt
        ? new Date(latestPackage.createdAt)
        : new Date();

      await updateExamPackageState(examId, {
        packageStatus: PACKAGE_STATUS.READY,
        packageGeneratedAt: generatedAt,
        packageVersion: resolvedVersion,
        packageLastGeneratedAt: generatedAt,
        latestPackageUrl: buildLatestPackageUrl(examId),
        packageLastError: '',
        offlinePackageVersion: resolvedVersion,
        offlinePackageGeneratedAt: generatedAt,
        offlinePackageEnabled: true,
      });

      logInfo(
        `Package regeneration ready for exam ${examId} (reason=${reason}, generated=${generationResult.generated}, skipped=${generationResult.skipped})`,
        'ExamPackageRegenerationService'
      );
      logInfo(
        `Package status DB updated to READY for exam ${examId}`,
        'ExamPackageRegenerationService'
      );
      return;
    }

    if (hasErrors) {
      const firstError =
        generationResult.errors.find((entry) => entry?.error)?.error ||
        generationResult.errors[0]?.message ||
        'Package generation failed';

      await updateExamPackageState(examId, {
        packageStatus: PACKAGE_STATUS.FAILED,
        packageLastError: getSafeErrorMessage(firstError, 'Package generation failed'),
        latestPackageUrl: '',
      });

      logInfo(
        `Package regeneration failed for exam ${examId} (${getSafeErrorMessage(firstError)})`,
        'ExamPackageRegenerationService'
      );
      return;
    }

    const shouldFailForInvalidContent =
      !hasGeneratedPackage &&
      !hasLatestPackage &&
      (
        generationResult.success === false ||
        Number(generationResult.noQuestionPapers || 0) > 0 ||
        String(generationResult.message || '').trim().length > 0
      );

    if (shouldFailForInvalidContent) {
      const failureMessage =
        generationResult.errors.find((entry) => entry?.error)?.error ||
        String(generationResult.message || '').trim() ||
        'No valid question papers with questions found for package generation';

      await updateExamPackageState(examId, {
        packageStatus: PACKAGE_STATUS.FAILED,
        packageLastError: getSafeErrorMessage(failureMessage, 'Package generation failed'),
        latestPackageUrl: '',
      });

      logInfo(
        `Package regeneration failed for exam ${examId} (${getSafeErrorMessage(failureMessage)})`,
        'ExamPackageRegenerationService'
      );
      return;
    }

    await updateExamPackageState(examId, {
      packageStatus: PACKAGE_STATUS.PENDING,
      packageGeneratedAt: null,
      packageLastError: '',
      latestPackageUrl: '',
      offlinePackageEnabled: false,
    });

    logInfo(
      `No package regenerated for exam ${examId} (reason=${reason}, no valid question paper content)`,
      'ExamPackageRegenerationService'
    );
  } catch (error) {
    await updateExamPackageState(examId, {
      packageStatus: PACKAGE_STATUS.FAILED,
      packageLastError: getSafeErrorMessage(error?.message),
      latestPackageUrl: '',
    }).catch(() => {});

    logError(
      error,
      `ExamPackageRegenerationService - runRegenerationJob exam=${examId}`
    );
  } finally {
    const completedJobKey = inFlightJobKeyByExam.get(examId);
    if (completedJobKey) {
      lastCompletedJobKeyByExam.set(examId, completedJobKey);
    }
    inFlightJobKeyByExam.delete(examId);
    inFlightRegeneration.delete(examId);
    const pendingRequest = pendingRegeneration.get(examId);
    if (pendingRequest) {
      pendingRegeneration.delete(examId);
      queueExamPackageRegeneration(pendingRequest);
    }
  }
};

export const queueExamPackageRegeneration = ({
  examId,
  userId,
  reason = 'EXAM_UPDATED',
  forceRegenerate = true,
  questionPaperIds = null,
  examUpdatedAt = null,
} = {}) => {
  const normalizedExamId = String(examId || '').trim();
  const normalizedUserId = String(userId || '').trim();
  const jobKey = buildRegenerationJobKey(normalizedExamId, examUpdatedAt);

  if (!normalizedExamId || !normalizedUserId) {
    return { queued: false, reason: 'invalid_payload' };
  }

  const lastCompletedJobKey = lastCompletedJobKeyByExam.get(normalizedExamId) || '';
  if (jobKey && jobKey === lastCompletedJobKey) {
    return { queued: false, reason: 'duplicate_exam_revision' };
  }

  if (inFlightRegeneration.has(normalizedExamId)) {
    const pendingRequest = pendingRegeneration.get(normalizedExamId);
    const inFlightJobKey = inFlightJobKeyByExam.get(normalizedExamId) || '';
    if (jobKey && jobKey === inFlightJobKey) {
      return { queued: false, reason: 'duplicate_exam_revision' };
    }

    const mergedUpdatedAt = getLatestUpdatedAt(
      pendingRequest?.examUpdatedAt,
      examUpdatedAt
    );
    const mergedJobKey = buildRegenerationJobKey(
      normalizedExamId,
      mergedUpdatedAt
    );

    const pendingJobKey = buildRegenerationJobKey(
      normalizedExamId,
      pendingRequest?.examUpdatedAt
    );
    if (mergedJobKey && mergedJobKey === pendingJobKey) {
      return { queued: false, reason: 'duplicate_exam_revision' };
    }

    pendingRegeneration.set(normalizedExamId, {
      examId: normalizedExamId,
      userId: normalizedUserId,
      reason: pendingRequest
        ? `${pendingRequest.reason}+${reason}`
        : reason,
      forceRegenerate: Boolean(forceRegenerate) || Boolean(pendingRequest?.forceRegenerate),
      questionPaperIds: mergeQuestionPaperIds(
        pendingRequest?.questionPaperIds,
        questionPaperIds
      ),
      examUpdatedAt: mergedUpdatedAt || null,
    });
    logInfo(
      `Queued follow-up package regeneration for in-flight exam ${normalizedExamId} (${reason})`,
      'ExamPackageRegenerationService'
    );
    return { queued: false, reason: 'already_processing_queued' };
  }

  inFlightRegeneration.add(normalizedExamId);
  if (jobKey) {
    inFlightJobKeyByExam.set(normalizedExamId, jobKey);
  } else {
    inFlightJobKeyByExam.delete(normalizedExamId);
  }

  void updateExamPackageState(normalizedExamId, {
    packageStatus: PACKAGE_STATUS.PENDING,
    packageLastError: '',
    latestPackageUrl: buildLatestPackageUrl(normalizedExamId),
  }).catch(() => {});

  setImmediate(() => {
    void runRegenerationJob({
      examId: normalizedExamId,
      userId: normalizedUserId,
      reason,
      forceRegenerate,
      questionPaperIds,
    });
  });

  return { queued: true };
};

export const isExamPackageRegenerationInFlight = (examId) =>
  inFlightRegeneration.has(String(examId || '').trim());

export const waitForExamPackageRegenerationDrain = async ({
  timeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 250,
} = {}) => {
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5 * 60 * 1000;
  const safePollInterval =
    Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 250;
  const deadline = Date.now() + safeTimeout;

  while (Date.now() < deadline) {
    if (inFlightRegeneration.size === 0 && pendingRegeneration.size === 0) {
      return {
        drained: true,
        inFlight: 0,
        pending: 0,
      };
    }
    await delay(safePollInterval);
  }

  return {
    drained: inFlightRegeneration.size === 0 && pendingRegeneration.size === 0,
    inFlight: inFlightRegeneration.size,
    pending: pendingRegeneration.size,
  };
};

export const queueExistingExamPackageBackfill = async ({
  batchSize = DEFAULT_BACKFILL_BATCH_SIZE,
  limit = null,
} = {}) => {
  const safeBatchSize =
    Number.isFinite(batchSize) && batchSize > 0
      ? Math.floor(batchSize)
      : DEFAULT_BACKFILL_BATCH_SIZE;
  const normalizedLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;

  let scanned = 0;
  let queued = 0;
  let skipped = 0;
  let lastSeenId = null;

  while (true) {
    const remaining = normalizedLimit === null ? safeBatchSize : normalizedLimit - scanned;
    if (remaining <= 0) break;

    const currentBatchSize =
      normalizedLimit === null ? safeBatchSize : Math.min(safeBatchSize, remaining);

    const filter = {
      examType: { $ne: 'OMR' },
      packageStatus: {
        $nin: [PACKAGE_STATUS.GENERATED, PACKAGE_STATUS.READY, PACKAGE_STATUS.FAILED],
      },
    };
    if (lastSeenId) {
      filter._id = { $gt: lastSeenId };
    }

    const exams = await Exam.find(filter)
      .sort({ _id: 1 })
      .limit(currentBatchSize)
      .select('_id createdBy updatedAt packageStatus')
      .lean();

    if (!exams.length) break;

    for (const exam of exams) {
      scanned += 1;
      const normalizedExamId = String(exam?._id || '').trim();
      const normalizedUserId = String(exam?.createdBy || '').trim();

      if (!normalizedExamId || !normalizedUserId) {
        skipped += 1;
        continue;
      }

      const queueResult = queueExamPackageRegeneration({
        examId: normalizedExamId,
        userId: normalizedUserId,
        reason: 'EXISTING_EXAM_BACKFILL',
        forceRegenerate: false,
        examUpdatedAt: exam?.updatedAt || null,
      });

      if (queueResult.queued) {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    lastSeenId = exams[exams.length - 1]?._id || null;
  }

  return { scanned, queued, skipped };
};

export const queueExistingExamPackageBackfillOnStartup = () => {
  if (startupBackfillQueued) {
    return;
  }
  startupBackfillQueued = true;

  setImmediate(() => {
    void queueExistingExamPackageBackfill()
      .then((result) => {
        logInfo(
          `Queued exam package backfill on startup (scanned=${result.scanned}, queued=${result.queued}, skipped=${result.skipped})`,
          'ExamPackageRegenerationService'
        );
      })
      .catch((error) => {
        logError(error, 'ExamPackageRegenerationService - startup backfill');
      });
  });
};
