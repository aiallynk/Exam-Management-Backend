/**
 * Attempt Reconciliation Service
 * Handles validation and reconciliation of offline exam attempts
 */

import ExamAttempt from '../models/ExamAttempt.js';
import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import Question from '../models/Question.js';
import Answer from '../models/Answer.js';
import ExamPackage from '../models/ExamPackage.js';

const normalizeStatusValue = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase();
};

const clampNonNegativeInteger = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const normalizeViolationType = (value) => {
  const normalized = normalizeStatusValue(value);
  if (!normalized) return 'OTHER';
  return normalized.replace(/[\s-]+/g, '_');
};

const toLegacyViolationEventType = (value) => {
  const type = normalizeViolationType(value);
  if (type === 'SCREENSHOT' || type === 'SCREEN_CAPTURE' || type === 'SCREEN_RECORDING') {
    return 'SCREENSHOT';
  }
  if (
    type === 'BACKGROUND' ||
    type === 'APP_BACKGROUND' ||
    type === 'APP_SWITCH' ||
    type === 'USER_LEAVE_HINT' ||
    type === 'WINDOW_FOCUS_LOST'
  ) {
    return 'BACKGROUND';
  }
  if (type === 'SCREEN_LOCK') {
    return 'SCREEN_LOCK';
  }
  if (type === 'APP_KILL' || type === 'APP_PAUSED' || type === 'APP_STOPPED') {
    return 'APP_KILL';
  }
  if (type === 'SPLIT_SCREEN') {
    return 'SPLIT_SCREEN';
  }
  if (type === 'COPY_PASTE' || type === 'COPY_PASTE_ATTEMPT') {
    return 'COPY_PASTE';
  }
  return 'OTHER';
};

const resolveExamStatusFromViolationCount = (violationCount, requestedStatus = '') => {
  const normalizedRequestedStatus = normalizeStatusValue(requestedStatus);
  if (normalizedRequestedStatus === 'FAIR' ||
      normalizedRequestedStatus === 'SUSPICIOUS' ||
      normalizedRequestedStatus === 'CHEATING') {
    return normalizedRequestedStatus;
  }

  if (violationCount <= 0) return 'FAIR';
  if (violationCount <= 2) return 'SUSPICIOUS';
  return 'CHEATING';
};

const normalizeViolationLogs = (rawLogs, { attempt, fallbackExamId, fallbackUserId } = {}) => {
  if (!Array.isArray(rawLogs)) return [];

  return rawLogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const eventTimestampRaw = entry.timestamp || entry.time || entry.createdAt;
      const parsedTimestamp = eventTimestampRaw ? new Date(eventTimestampRaw) : new Date();
      const timestamp = Number.isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp;

      const violationType = normalizeViolationType(entry.violationType || entry.type || entry.eventType);
      const examId =
        entry.examId ||
        fallbackExamId ||
        attempt?.examId?._id ||
        attempt?.examId ||
        null;
      const userId = entry.userId || fallbackUserId || attempt?.userId || null;

      const detailsRaw = entry.details;
      const details =
        typeof detailsRaw === 'string'
          ? detailsRaw
          : typeof detailsRaw === 'object' && detailsRaw !== null
            ? JSON.stringify(detailsRaw)
            : (entry.message || '').toString();

      const deviceInfo =
        entry.deviceInfo && typeof entry.deviceInfo === 'object'
          ? { ...entry.deviceInfo }
          : {};

      return {
        userId,
        examId,
        timestamp,
        violationType,
        details: details.slice(0, 500),
        deviceInfo,
      };
    })
    .filter(Boolean);
};

/**
 * Validate timestamps for offline attempt
 * @param {Object} attemptData - Offline attempt data
 * @returns {Object} Validation result
 */
export const validateTimestamps = (attemptData) => {
  const {
    offlineStartTime,
    offlineSubmitTime,
    startTime,
    submitTime,
    timestampDrift,
  } = attemptData;

  const errors = [];
  const warnings = [];

  // Check timestamp drift (should be within 5 minutes)
  const MAX_DRIFT_MS = 5 * 60 * 1000; // 5 minutes
  if (Math.abs(timestampDrift) > MAX_DRIFT_MS) {
    errors.push({
      type: 'TIMESTAMP_DRIFT',
      message: `Device time drift exceeds maximum allowed: ${Math.abs(timestampDrift)}ms`,
      severity: 'high',
    });
  }

  // Validate offline start time
  if (offlineStartTime) {
    const offlineStart = new Date(offlineStartTime);
    const serverStart = new Date(startTime);
    const diff = Math.abs(offlineStart - serverStart);

    if (diff > MAX_DRIFT_MS) {
      warnings.push({
        type: 'START_TIME_MISMATCH',
        message: `Offline start time differs from server start time by ${diff}ms`,
        severity: 'medium',
      });
    }
  }

  // Validate offline submit time
  if (offlineSubmitTime && submitTime) {
    const offlineSubmit = new Date(offlineSubmitTime);
    const serverSubmit = new Date(submitTime);
    const diff = Math.abs(offlineSubmit - serverSubmit);

    if (diff > MAX_DRIFT_MS) {
      warnings.push({
        type: 'SUBMIT_TIME_MISMATCH',
        message: `Offline submit time differs from server submit time by ${diff}ms`,
        severity: 'medium',
      });
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
};

/**
 * Detect anomalies in attempt data
 * @param {Object} attemptData - Offline attempt data
 * @param {Object} exam - Exam document
 * @returns {Object} Anomaly detection result
 */
export const detectAnomalies = (attemptData, exam) => {
  const {
    answers,
    sectionTimings,
    violationEvents,
    violationLogs,
    offlineStartTime,
    offlineSubmitTime,
    packageVersion,
    packageHash,
  } = attemptData;

  const anomalies = [];
  const flags = [];

  const violationFeed = Array.isArray(violationLogs) && violationLogs.length > 0
    ? violationLogs
    : (Array.isArray(violationEvents) ? violationEvents : []);

  // Check violation events
  if (violationFeed.length > 0) {
    const violationCount = violationFeed.length;
    if (violationCount > 5) {
      flags.push('HIGH_VIOLATION_COUNT');
      anomalies.push({
        type: 'HIGH_VIOLATION_COUNT',
        message: `High number of violations detected: ${violationCount}`,
        severity: 'high',
      });
    }

    // Check for suspicious patterns
    const screenshotCount = violationFeed.filter((event) => {
      const type = normalizeViolationType(event?.violationType || event?.type || event?.eventType);
      return type === 'SCREENSHOT' || type === 'SCREEN_CAPTURE' || type === 'SCREEN_RECORDING';
    }).length;
    if (screenshotCount > 3) {
      flags.push('MULTIPLE_SCREENSHOTS');
      anomalies.push({
        type: 'MULTIPLE_SCREENSHOTS',
        message: `Multiple screenshots detected: ${screenshotCount}`,
        severity: 'high',
      });
    }

    const backgroundCount = violationFeed.filter((event) => {
      const type = normalizeViolationType(event?.violationType || event?.type || event?.eventType);
      return type === 'BACKGROUND' ||
        type === 'APP_BACKGROUND' ||
        type === 'APP_SWITCH' ||
        type === 'WINDOW_FOCUS_LOST' ||
        type === 'USER_LEAVE_HINT';
    }).length;
    if (backgroundCount > 10) {
      flags.push('FREQUENT_BACKGROUND');
      anomalies.push({
        type: 'FREQUENT_BACKGROUND',
        message: `Frequent app background events: ${backgroundCount}`,
        severity: 'medium',
      });
    }
  }

  // Check attempt duration
  if (offlineStartTime && offlineSubmitTime) {
    const duration = new Date(offlineSubmitTime) - new Date(offlineStartTime);
    const examDuration = exam.duration * 60 * 1000; // Convert minutes to milliseconds
    const gracePeriod = (exam.gracePeriod || 0) * 60 * 1000;
    const maxDuration = examDuration + gracePeriod;

    if (duration < examDuration * 0.1) {
      // Less than 10% of exam time
      flags.push('SUSPICIOUSLY_SHORT');
      anomalies.push({
        type: 'SUSPICIOUSLY_SHORT',
        message: `Attempt duration is suspiciously short: ${Math.round(duration / 1000 / 60)} minutes`,
        severity: 'high',
      });
    }

    if (duration > maxDuration * 1.2) {
      // More than 20% over max duration
      flags.push('EXCEEDED_MAX_DURATION');
      anomalies.push({
        type: 'EXCEEDED_MAX_DURATION',
        message: `Attempt duration exceeds maximum allowed: ${Math.round(duration / 1000 / 60)} minutes`,
        severity: 'medium',
      });
    }
  }

  // Check section timings
  if (sectionTimings && Array.isArray(sectionTimings)) {
    sectionTimings.forEach((sectionTiming, index) => {
      if (sectionTiming.timeSpent < 0) {
        flags.push('NEGATIVE_SECTION_TIME');
        anomalies.push({
          type: 'NEGATIVE_SECTION_TIME',
          message: `Negative time spent in section ${index + 1}`,
          severity: 'high',
        });
      }
    });
  }

  // Check answer patterns (basic checks)
  if (answers && typeof answers === 'object') {
    const answerCount = Object.keys(answers).length;
    if (answerCount === 0) {
      flags.push('NO_ANSWERS');
      anomalies.push({
        type: 'NO_ANSWERS',
        message: 'No answers provided in attempt',
        severity: 'high',
      });
    }
  }

  return {
    hasAnomalies: anomalies.length > 0,
    anomalies,
    flags,
  };
};

/**
 * Reconcile offline attempt
 * @param {Object} attemptData - Offline attempt data
 * @returns {Promise<Object>} Reconciliation result
 */
export const reconcileOfflineAttempt = async (attemptData) => {
  const {
    attemptId,
    packageVersion,
    packageHash,
    deviceFingerprint,
    answers,
    sectionTimings,
    violationEvents,
    violationLogs,
    violationCount,
    examStatus,
    timestampDrift,
    offlineStartTime,
    offlineSubmitTime,
  } = attemptData;

  // Get attempt
  const attempt = await ExamAttempt.findById(attemptId)
    .populate('examId')
    .populate('sessionId')
    .populate('questionPaperId');

  if (!attempt) {
    throw new Error('Attempt not found');
  }

  if (attempt.isCompleted) {
    throw new Error('Attempt already submitted');
  }

  const exam = attempt.examId;
  const session = attempt.sessionId;

  // Validate package version and hash
  if (packageVersion) {
    const packageDoc = await ExamPackage.findOne({
      examId: exam._id,
      questionPaperId: attempt.questionPaperId?._id || attempt.questionPaperId,
      version: packageVersion,
      isActive: true,
    });

    if (!packageDoc) {
      throw new Error(`Package version ${packageVersion} not found`);
    }

    if (packageHash && packageDoc.packageHash !== packageHash) {
      throw new Error('Package hash mismatch - package may have been tampered with');
    }
  }

  // Validate timestamps
  const timestampValidation = validateTimestamps({
    ...attemptData,
    startTime: attempt.startTime,
    submitTime: new Date(), // Current server time
  });

  if (!timestampValidation.isValid) {
    // Log errors but don't block submission - flag for review
    console.warn('Timestamp validation errors:', timestampValidation.errors);
  }

  // Detect anomalies
  const anomalyDetection = detectAnomalies(attemptData, exam);

  // Update attempt with offline data
  attempt.offlineMode = true;
  attempt.packageVersion = packageVersion;
  attempt.packageHash = packageHash;
  attempt.deviceFingerprint = deviceFingerprint;
  attempt.offlineStartTime = offlineStartTime ? new Date(offlineStartTime) : attempt.startTime;
  attempt.offlineSubmitTime = offlineSubmitTime ? new Date(offlineSubmitTime) : new Date();
  attempt.timestampDrift = timestampDrift || 0;

  const rawViolationLogList = Array.isArray(violationLogs) && violationLogs.length > 0
    ? violationLogs
    : (Array.isArray(violationEvents) ? violationEvents : []);
  const normalizedLogs = normalizeViolationLogs(rawViolationLogList, {
    attempt,
    fallbackExamId: attempt.examId?._id || attempt.examId,
    fallbackUserId: attempt.userId,
  });
  const resolvedViolationCount = Math.max(
    clampNonNegativeInteger(
      violationCount,
      normalizedLogs.length,
    ),
    normalizedLogs.length,
  );

  // Store violation events (legacy) and normalized logs (new schema)
  attempt.violationEvents = normalizedLogs.map((event) => ({
    type: toLegacyViolationEventType(event.violationType),
    timestamp: event.timestamp,
    details: event.details || '',
  }));
  attempt.violationLogs = normalizedLogs;
  attempt.violationCount = resolvedViolationCount;
  attempt.examStatus = resolveExamStatusFromViolationCount(
    resolvedViolationCount,
    examStatus,
  );
  attempt.proctoringViolations = [
    ...(Array.isArray(attempt.proctoringViolations) ? attempt.proctoringViolations : []),
    ...normalizedLogs,
  ];

  // Update section timers
  if (sectionTimings && Array.isArray(sectionTimings)) {
    sectionTimings.forEach(sectionTiming => {
      if (attempt.sectionTimers.has(sectionTiming.sectionId)) {
        const timer = attempt.sectionTimers.get(sectionTiming.sectionId);
        timer.timeSpent = sectionTiming.timeSpent || 0;
        attempt.sectionTimers.set(sectionTiming.sectionId, timer);
      }
    });
  }

  // Flag suspicious activity if anomalies detected
  if (anomalyDetection.hasAnomalies) {
    attempt.suspiciousActivity = true;
    attempt.suspiciousActivityFlags = [
      ...(attempt.suspiciousActivityFlags || []),
      ...anomalyDetection.flags,
    ];
  }

  // Set submit time
  attempt.submitTime = new Date();
  attempt.isCompleted = true;

  await attempt.save();

  // Merge answers (create Answer documents)
  await mergeAnswers(attemptId, answers, attempt.questionPaperId?._id || attempt.questionPaperId);

  return {
    success: true,
    attemptId: attempt._id.toString(),
    warnings: timestampValidation.warnings,
    anomalies: anomalyDetection.anomalies,
    flags: anomalyDetection.flags,
  };
};

/**
 * Merge offline answers into Answer documents
 * @param {string} attemptId - Attempt ID
 * @param {Object} answers - Answers object { questionId: answer }
 * @param {string} questionPaperId - Question Paper ID
 * @returns {Promise<void>}
 */
export const mergeAnswers = async (attemptId, answers, questionPaperId) => {
  if (!answers || typeof answers !== 'object') {
    return;
  }

  // Get all questions for this question paper
  const questions = await Question.find({
    questionPaperId,
  });

  const questionMap = new Map();
  questions.forEach(q => {
    questionMap.set(q._id.toString(), q);
  });

  // Process each answer
  for (const [questionId, answerValue] of Object.entries(answers)) {
    const question = questionMap.get(questionId);
    if (!question) {
      console.warn(`Question ${questionId} not found in question paper`);
      continue;
    }

    // Check if answer already exists
    let answerDoc = await Answer.findOne({
      attemptId,
      questionId,
    });

    if (answerDoc) {
      // Update existing answer
      answerDoc.answerText = normalizeAnswer(question.questionType, answerValue);
      answerDoc.updatedAt = new Date();
      await answerDoc.save();
    } else {
      // Create new answer
      answerDoc = new Answer({
        attemptId,
        questionId,
        answerText: normalizeAnswer(question.questionType, answerValue),
      });
      await answerDoc.save();
    }
  }
};

/**
 * Normalize answer based on question type
 * @param {string} questionType - Question type
 * @param {*} answerValue - Answer value
 * @returns {string} Normalized answer
 */
const normalizeAnswer = (questionType, answerValue) => {
  if (answerValue === null || answerValue === undefined) {
    return '';
  }

  if (questionType === 'MULTIPLE_OPTIONS') {
    // Handle array of answers
    if (Array.isArray(answerValue)) {
      return JSON.stringify(answerValue.map(String).filter(Boolean));
    }
    if (typeof answerValue === 'string') {
      try {
        const parsed = JSON.parse(answerValue);
        if (Array.isArray(parsed)) {
          return JSON.stringify(parsed.map(String).filter(Boolean));
        }
      } catch (e) {
        // Not JSON, treat as comma-separated
        const parts = answerValue.split(/[,;|\n]/).map(s => s.trim()).filter(Boolean);
        return JSON.stringify(parts);
      }
    }
  }

  return String(answerValue);
};
