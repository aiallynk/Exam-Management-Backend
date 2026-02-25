/**
 * Enhanced Proctoring Service
 * Handles copy/paste blocking, multiple login detection, IP/device logging,
 * suspicious activity flagging, and strict focus-loss auto submit.
 */

import ExamAttempt from '../models/ExamAttempt.js';

const FOCUS_VIOLATION_SUBMISSION_SOURCE = 'STRICT_FOCUS_LOSS_AUTO_SUBMIT';

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const assertAttemptOwnership = (attempt, actorUserId) => {
  if (!actorUserId) return;
  if (!attempt?.userId) {
    throw createHttpError(403, 'Forbidden');
  }
  if (attempt.userId.toString() !== actorUserId.toString()) {
    throw createHttpError(403, 'Forbidden - Attempt does not belong to current user');
  }
};

const lockAllSectionTimersOnSubmit = (attempt, submitTime) => {
  if (!attempt?.sectionTimers || typeof attempt.sectionTimers.entries !== 'function') {
    return;
  }

  const nextSectionTimers = new Map();
  for (const [sectionId, timerValue] of attempt.sectionTimers.entries()) {
    const raw = timerValue?.toObject ? timerValue.toObject() : { ...(timerValue || {}) };
    const durationSeconds = toNonNegativeInt(raw.durationSeconds, 0);
    const currentRemaining = toNonNegativeInt(raw.remainingSeconds, 0);
    const inferredSpent = Math.max(durationSeconds - currentRemaining, 0);
    const currentSpent = toNonNegativeInt(raw.timeSpent, 0);

    nextSectionTimers.set(sectionId, {
      ...raw,
      startTime: raw.startTime || raw.startedAt || submitTime,
      startedAt: raw.startedAt || raw.startTime || submitTime,
      endTime: submitTime,
      completedAt: raw.completedAt || submitTime,
      lastResumedAt: null,
      isActive: false,
      isLocked: true,
      isCompleted: true,
      remainingSeconds: 0,
      timeSpent: Math.max(currentSpent, inferredSpent),
    });
  }

  attempt.sectionTimers = nextSectionTimers;
  attempt.currentSectionId = null;
  attempt.sectionStateUpdatedAt = submitTime;
};

const appendSuspiciousFlag = (attempt, activityType, details = {}) => {
  if (!attempt.suspiciousActivityFlags) {
    attempt.suspiciousActivityFlags = [];
  }

  attempt.suspiciousActivityFlags.push({
    type: activityType,
    timestamp: new Date(),
    details,
  });
  attempt.suspiciousActivity = true;
};

const autoSubmitAttemptOnFocusViolation = (attempt, violation = {}) => {
  const submitTime = new Date();
  const reason = violation.reason || 'Focus loss detected during exam';
  const eventType = violation.eventType || 'FOCUS_VIOLATION';

  attempt.isCompleted = true;
  attempt.submitTime = submitTime;
  attempt.submittedAt = submitTime;
  attempt.isDisqualified = true;
  attempt.disqualifyReason = reason;
  attempt.lastActivity = submitTime;

  const existingScore = attempt.scoreSummary || {};
  attempt.scoreSummary = {
    totalScore: Number(existingScore.totalScore) || 0,
    maxScore: Number(existingScore.maxScore) || 0,
    percentage: Number(existingScore.percentage) || 0,
    computedAt: submitTime,
  };

  const submittedAtClient =
    typeof violation.clientTimestamp === 'string'
      ? new Date(violation.clientTimestamp)
      : null;
  attempt.submitMeta = {
    submissionSource: FOCUS_VIOLATION_SUBMISSION_SOURCE,
    submittedAtClient:
      submittedAtClient && !Number.isNaN(submittedAtClient.getTime())
        ? submittedAtClient
        : null,
    totalRemainingSeconds:
      violation.totalRemainingSeconds !== undefined
        ? toNonNegativeInt(violation.totalRemainingSeconds, 0)
        : null,
    currentSectionId:
      typeof violation.currentSectionId === 'string' &&
      /^[a-fA-F0-9]{24}$/.test(violation.currentSectionId)
        ? violation.currentSectionId
        : null,
  };

  lockAllSectionTimersOnSubmit(attempt, submitTime);
  appendSuspiciousFlag(attempt, 'STRICT_FOCUS_VIOLATION', {
    eventType,
    reason,
    submissionSource: FOCUS_VIOLATION_SUBMISSION_SOURCE,
  });
};

/**
 * Log device and IP information for an attempt
 */
export const logDeviceInfo = async (attemptId, deviceInfo, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  attempt.deviceInfo = {
    ipAddress: deviceInfo.ipAddress || '',
    userAgent: deviceInfo.userAgent || '',
    deviceId: deviceInfo.deviceId || '',
    screenResolution: deviceInfo.screenResolution || '',
    timezone: deviceInfo.timezone || '',
    language: deviceInfo.language || '',
  };

  return await attempt.save();
};

/**
 * Check for multiple logins from different devices/IPs
 */
export const checkMultipleLogins = async (userId, examId, currentDeviceInfo) => {
  const activeAttempts = await ExamAttempt.find({
    userId,
    examId,
    isCompleted: false,
    isDisqualified: false,
  });

  if (activeAttempts.length === 0) {
    return { hasMultipleLogins: false, attempts: [] };
  }

  const differentDevices = activeAttempts.filter((attempt) => {
    if (!attempt.deviceInfo || !attempt.deviceInfo.ipAddress) {
      return false;
    }

    const attemptIP = attempt.deviceInfo.ipAddress;
    const attemptDeviceId = attempt.deviceInfo.deviceId;
    const currentIP = currentDeviceInfo.ipAddress;
    const currentDeviceId = currentDeviceInfo.deviceId;

    return attemptIP !== currentIP || attemptDeviceId !== currentDeviceId;
  });

  return {
    hasMultipleLogins: differentDevices.length > 0,
    attempts: differentDevices.map((a) => ({
      attemptId: a._id,
      deviceInfo: a.deviceInfo,
      startTime: a.startTime,
    })),
  };
};

/**
 * Flag suspicious activity
 */
export const flagSuspiciousActivity = async (attemptId, activityType, details = {}, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  appendSuspiciousFlag(attempt, activityType, details);
  return await attempt.save();
};

/**
 * Strict anti-cheat: any focus loss immediately auto-submits and disqualifies.
 */
export const enforceStrictFocusViolation = async (
  attemptId,
  violation = {},
  actorUserId = null
) => {
  if (!attemptId) {
    throw new Error('Attempt ID is required');
  }

  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  const eventType = String(violation?.eventType || 'FOCUS_VIOLATION').toUpperCase();
  if (eventType === 'TAB_SWITCH' || eventType === 'TAB_HIDDEN') {
    attempt.tabSwitchCount = (attempt.tabSwitchCount || 0) + 1;
  }

  if (attempt.isCompleted) {
    appendSuspiciousFlag(attempt, 'STRICT_FOCUS_VIOLATION_AFTER_COMPLETION', {
      eventType,
      reason: violation?.reason || 'Focus loss reported after completion',
    });
    await attempt.save();
    return {
      autoSubmitted: false,
      alreadyCompleted: true,
      attempt,
    };
  }

  autoSubmitAttemptOnFocusViolation(attempt, {
    ...violation,
    eventType,
  });
  await attempt.save();

  return {
    autoSubmitted: true,
    alreadyCompleted: false,
    attempt,
  };
};

/**
 * Record tab switch (strict mode: auto submit)
 */
export const recordTabSwitch = async (attemptId, actorUserId = null, metadata = {}) => {
  return enforceStrictFocusViolation(
    attemptId,
    {
      eventType: 'TAB_SWITCH',
      reason: 'Tab switch detected. Exam auto-submitted immediately.',
      ...metadata,
    },
    actorUserId
  );
};

/**
 * Record window blur (strict mode: auto submit)
 */
export const recordWindowBlur = async (attemptId, actorUserId = null, metadata = {}) => {
  return enforceStrictFocusViolation(
    attemptId,
    {
      eventType: 'WINDOW_BLUR',
      reason: 'Window focus change detected. Exam auto-submitted immediately.',
      ...metadata,
    },
    actorUserId
  );
};

/**
 * Record copy/paste attempt
 */
export const recordCopyPasteAttempt = async (attemptId, action, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  appendSuspiciousFlag(attempt, 'COPY_PASTE_ATTEMPT', {
    action,
    timestamp: new Date(),
  });

  return await attempt.save();
};

/**
 * Record right-click attempt
 */
export const recordRightClickAttempt = async (attemptId, actorUserId = null) => {
  if (!attemptId) {
    throw new Error('Attempt ID is required');
  }

  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  appendSuspiciousFlag(attempt, 'RIGHT_CLICK_ATTEMPT', {
    timestamp: new Date(),
  });

  return await attempt.save();
};

/**
 * Record keyboard shortcut attempt
 */
export const recordKeyboardShortcut = async (attemptId, shortcut, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  appendSuspiciousFlag(attempt, 'KEYBOARD_SHORTCUT_ATTEMPT', {
    shortcut,
    timestamp: new Date(),
  });

  return await attempt.save();
};

/**
 * Get suspicious activity summary for an attempt
 */
export const getSuspiciousActivitySummary = async (attemptId, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  const flags = attempt.suspiciousActivityFlags || [];
  const processedFlags = flags.map((flag) => {
    if (typeof flag === 'string') {
      return {
        type: flag,
        timestamp: attempt.startTime || new Date(),
        details: {},
      };
    }
    return flag;
  });

  const flagsByType = {};
  processedFlags.forEach((flag) => {
    if (!flagsByType[flag.type]) {
      flagsByType[flag.type] = [];
    }
    flagsByType[flag.type].push({
      timestamp: flag.timestamp || flag.details?.timestamp || attempt.startTime || new Date(),
      details: flag.details || {},
    });
  });

  const summary = Object.keys(flagsByType).reduce((acc, type) => {
    acc[type] = flagsByType[type].length;
    return acc;
  }, {});

  const isSuspicious = attempt.suspiciousActivity || processedFlags.length > 0;
  const isDisqualified = attempt.isDisqualified || false;

  return {
    isSuspicious,
    isDisqualified,
    flags: processedFlags.sort((a, b) => {
      const timeA = a.timestamp || a.details?.timestamp || new Date(0);
      const timeB = b.timestamp || b.details?.timestamp || new Date(0);
      return new Date(timeA) - new Date(timeB);
    }),
    summary,
    totalFlags: processedFlags.length,
    tabSwitchCount: attempt.tabSwitchCount || 0,
    deviceInfo: attempt.deviceInfo || {},
    disqualifyReason: attempt.disqualifyReason || null,
    submissionSource: attempt.submitMeta?.submissionSource || null,
  };
};

/**
 * Get all suspicious attempts for an exam
 */
export const getSuspiciousAttempts = async (examId) => {
  const attempts = await ExamAttempt.find({
    examId,
    suspiciousActivity: true,
  }).populate('userId', 'name email').sort({ createdAt: -1 });

  return attempts.map((attempt) => ({
    attemptId: attempt._id,
    userId: attempt.userId._id,
    userName: attempt.userId.name,
    userEmail: attempt.userId.email,
    startTime: attempt.startTime,
    submitTime: attempt.submitTime,
    suspiciousActivityFlags: attempt.suspiciousActivityFlags || [],
    deviceInfo: attempt.deviceInfo,
    tabSwitchCount: attempt.tabSwitchCount || 0,
  }));
};

/**
 * Update last activity timestamp
 */
export const updateLastActivity = async (attemptId, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  attempt.lastActivity = new Date();
  return await attempt.save();
};

/**
 * Check for inactivity timeout
 */
export const checkInactivity = async (attemptId, timeoutMinutes = 5, actorUserId = null) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  assertAttemptOwnership(attempt, actorUserId);

  const lastActivity = attempt.lastActivity || attempt.startTime;
  const now = new Date();
  const minutesSinceActivity = (now - lastActivity) / (1000 * 60);

  if (minutesSinceActivity > timeoutMinutes) {
    appendSuspiciousFlag(attempt, 'INACTIVITY_TIMEOUT', {
      minutesSinceActivity: Math.floor(minutesSinceActivity),
      timeoutMinutes,
    });
    await attempt.save();

    return {
      isInactive: true,
      minutesSinceActivity: Math.floor(minutesSinceActivity),
    };
  }

  return {
    isInactive: false,
    minutesSinceActivity: Math.floor(minutesSinceActivity),
  };
};
