/**
 * Enhanced Proctoring Service
 * Handles copy/paste blocking, multiple login detection, IP/device logging,
 * and suspicious activity flagging
 */

import ExamAttempt from '../models/ExamAttempt.js';
import User from '../models/User.js';

/**
 * Log device and IP information for an attempt
 */
export const logDeviceInfo = async (attemptId, deviceInfo) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
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
  // Find active attempts for this user and exam
  const activeAttempts = await ExamAttempt.find({
    userId,
    examId,
    isCompleted: false,
    isDisqualified: false,
  });
  
  if (activeAttempts.length === 0) {
    return { hasMultipleLogins: false, attempts: [] };
  }
  
  // Check if any attempt has different device info
  const differentDevices = activeAttempts.filter(attempt => {
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
    attempts: differentDevices.map(a => ({
      attemptId: a._id,
      deviceInfo: a.deviceInfo,
      startTime: a.startTime,
    })),
  };
};

/**
 * Flag suspicious activity
 */
export const flagSuspiciousActivity = async (attemptId, activityType, details = {}) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  if (!attempt.suspiciousActivityFlags) {
    attempt.suspiciousActivityFlags = [];
  }
  
  const flag = {
    type: activityType,
    timestamp: new Date(),
    details,
  };
  
  attempt.suspiciousActivityFlags.push(flag);
  attempt.suspiciousActivity = true;
  
  return await attempt.save();
};

/**
 * Record tab switch
 */
export const recordTabSwitch = async (attemptId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  attempt.tabSwitchCount = (attempt.tabSwitchCount || 0) + 1;
  
  // Flag if too many tab switches
  if (attempt.tabSwitchCount > 3) {
    await flagSuspiciousActivity(attemptId, 'EXCESSIVE_TAB_SWITCHES', {
      count: attempt.tabSwitchCount,
    });
  }
  
  return await attempt.save();
};

/**
 * Record window blur
 */
export const recordWindowBlur = async (attemptId) => {
  if (!attemptId) {
    throw new Error('Attempt ID is required');
  }
  
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  await flagSuspiciousActivity(attemptId, 'WINDOW_BLUR', {
    timestamp: new Date(),
  });
  
  return await attempt.save();
};

/**
 * Record copy/paste attempt
 */
export const recordCopyPasteAttempt = async (attemptId, action) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  await flagSuspiciousActivity(attemptId, 'COPY_PASTE_ATTEMPT', {
    action, // 'copy' or 'paste'
    timestamp: new Date(),
  });
  
  return await attempt.save();
};

/**
 * Record right-click attempt
 */
export const recordRightClickAttempt = async (attemptId) => {
  if (!attemptId) {
    throw new Error('Attempt ID is required');
  }
  
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  await flagSuspiciousActivity(attemptId, 'RIGHT_CLICK_ATTEMPT', {
    timestamp: new Date(),
  });
  
  return await attempt.save();
};

/**
 * Record keyboard shortcut attempt
 */
export const recordKeyboardShortcut = async (attemptId, shortcut) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  await flagSuspiciousActivity(attemptId, 'KEYBOARD_SHORTCUT_ATTEMPT', {
    shortcut,
    timestamp: new Date(),
  });
  
  return await attempt.save();
};

/**
 * Get suspicious activity summary for an attempt
 */
export const getSuspiciousActivitySummary = async (attemptId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  const flags = attempt.suspiciousActivityFlags || [];
  
  // Process flags to ensure they have proper structure
  const processedFlags = flags.map(flag => {
    if (typeof flag === 'string') {
      // Legacy format - convert to object
      return {
        type: flag,
        timestamp: attempt.startTime || new Date(),
        details: {},
      };
    }
    return flag;
  });
  
  // Group flags by type with timestamps
  const flagsByType = {};
  processedFlags.forEach(flag => {
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
  
  // Determine status
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
  
  return attempts.map(attempt => ({
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
export const updateLastActivity = async (attemptId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  attempt.lastActivity = new Date();
  return await attempt.save();
};

/**
 * Check for inactivity timeout
 */
export const checkInactivity = async (attemptId, timeoutMinutes = 5) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  const lastActivity = attempt.lastActivity || attempt.startTime;
  const now = new Date();
  const minutesSinceActivity = (now - lastActivity) / (1000 * 60);
  
  if (minutesSinceActivity > timeoutMinutes) {
    await flagSuspiciousActivity(attemptId, 'INACTIVITY_TIMEOUT', {
      minutesSinceActivity: Math.floor(minutesSinceActivity),
      timeoutMinutes,
    });
    
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
