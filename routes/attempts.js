import express from 'express';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import ExamSession from '../models/ExamSession.js';
import Exam from '../models/Exam.js';
import Question from '../models/Question.js';
import Section from '../models/Section.js';
import SystemConfig from '../models/SystemConfig.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import {
  canCandidateAccessSession,
  requireExamPermission,
  hasExamPermission,
  hasActiveExaminerAssignment,
} from '../middleware/examPermissions.js';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import { checkCandidateAttemptLimit } from '../middleware/planLimits.js';
import { body, validationResult } from 'express-validator';
import { validateObjectId, sanitizePagination, validateObjectIds } from '../middleware/validation.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { evaluateAnswer } from '../services/aiService.js';
import { classifySubmissionEvaluations } from '../services/evaluationOrchestratorService.js';
import { autoDistributeOnAttemptCompletion } from '../services/responseDistributionService.js';
import { assignQuestionPaperToStudent } from '../services/sessionAssignment.js';
import {
  MIN_CERTIFICATION_PERCENTAGE,
  loadCertificateTemplate,
  applyCertificateTemplate,
} from '../utils/certificateTemplate.js';
import { ensureScoreSummary } from '../utils/attemptScores.js';
import {
  reconcileOfflineAttempt,
  validateTimestamps,
  detectAnomalies,
} from '../services/attemptReconciliationService.js';
import { syncExamCandidateCount } from '../utils/planUsage.js';
import { getAttemptSectionProgress, startSectionTimer } from '../services/sectionService.js';
import { ensureQuestionsImageAvailability } from '../services/questionImportImageService.js';
import {
  normalizeQuestionCorrectAnswer,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';
import {
  evaluateCodingQuestionSubmission,
  normalizeCodingAnswerForStorage,
  parseCodingAnswerPayload,
  resolveCodingAnswerDraft,
  saveCodingSubmissionRecord,
} from '../services/codingSubmissionService.js';
import { normalizeCodingLanguage } from '../utils/codingQuestions.js';
import { hasRole } from '../utils/userRoles.js';
import {
  FOCUS_VIOLATION_SUBMISSION_SOURCE,
  TAB_SWITCH_DISQUALIFY_STATUS,
} from '../services/proctoringService.js';
import {
  isExamResultsReleased,
  canCandidateViewScore,
  buildAttemptStatusOnlyPayload,
} from '../utils/resultVisibility.js';
import {
  FREE_PLAN_MESSAGES,
  getSubscriptionPlanDefinition,
  isFreePlan,
  isPlanFeatureEnabled,
} from '../config/planLimits.js';
import { resolveExamPlanContext } from '../middleware/planRestrictions.js';
import { enforceExamAccessControl } from '../utils/examSecurity.js';
import {
  AI_GRADING_LIMIT_EXCEEDED_MESSAGE,
  getTenantAiGradingUsageSnapshot,
  incrementTenantAiGradingUsage,
  toAiUsageResponsePayload,
} from '../services/aiGradingUsageService.js';
import { assertExamProductAccess, WizKidsAccessError } from '../services/wizKidsAccessService.js';
import { completeWizKidsObjectiveAttempt, WizKidsCompletionError } from '../services/wizKidsCompletionService.js';

const parseArrayAnswer = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
      .filter(Boolean);
  }

  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
          .filter(Boolean);
      }
    } catch (error) {
      // Ignore parse error and fall back to delimiter splitting
    }

    return trimmed
      .split(/[,;|\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [String(value)];
};

const arrayEqualsIgnoreOrder = (a, b) => {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a.map((item) => item.toLowerCase()));
  const setB = new Set(b.map((item) => item.toLowerCase()));
  if (setA.size !== setB.size) {
    return false;
  }
  for (const value of setA) {
    if (!setB.has(value)) {
      return false;
    }
  }
  return true;
};

const WRITING_QUESTION_TYPES = new Set(['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY']);
const SEMANTIC_EVALUATION_QUESTION_TYPES = new Set([
  'SHORT_ANSWER',
  'PARAGRAPH',
  'ESSAY',
  'ESSAY_LETTER',
  'ESSAY_STORY',
  'FILL_IN_THE_BLANK',
  'NUMBER',
]);

const sendWritingPlanRestriction = (res) =>
  res.status(403).json({
    success: false,
    message: FREE_PLAN_MESSAGES.WRITING_AI_LOCKED,
  });

const hasWritingQuestionsInPaper = async (questionPaperId) => {
  if (!questionPaperId) return false;
  const exists = await Question.exists({
    questionPaperId,
    questionType: { $in: Array.from(WRITING_QUESTION_TYPES) },
  });
  return Boolean(exists);
};

const resolveAiGradingProfile = (planType) => {
  const normalized = String(planType || '').trim().toLowerCase();
  if (normalized === 'legend') return 'advanced';
  if (normalized === 'ultimate') return 'enhanced';
  return 'basic';
};

const normalizeAiGradingTypeKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

const resolveAiGradingTypeForQuestion = (questionType) => {
  const normalized = normalizeAiGradingTypeKey(questionType);
  if (normalized === 'short_answer') return 'short';
  if (normalized === 'paragraph') return 'paragraph';
  if (normalized === 'essay') return 'essay';
  if (normalized === 'essay_letter' || normalized === 'letter_writing') {
    return 'essay_letter';
  }
  if (normalized === 'essay_story' || normalized === 'story_writing') {
    return 'essay_story';
  }
  if (normalized === 'fill_in_the_blank') return 'fill_in_the_blank';
  if (normalized === 'number' || normalized === 'numerical') return 'numerical';
  return '';
};

const computeMultiSelectScoring = ({
  question,
  studentAnswer,
  examMarkingRules = {},
}) => {
  const questionPoints = Number(question?.points) || 0;
  const normalizedOptions = sanitizeQuestionOptions(question?.options);
  const expected = normalizeQuestionCorrectAnswer({
    questionType: 'MULTIPLE_OPTIONS',
    correctAnswer: question?.correctAnswer,
    options: normalizedOptions,
  });
  const received = normalizeQuestionCorrectAnswer({
    questionType: 'MULTIPLE_OPTIONS',
    correctAnswer: studentAnswer,
    options: normalizedOptions,
  });

  const expectedSet = new Set(expected.map((item) => String(item).toLowerCase()));
  const receivedSet = new Set(received.map((item) => String(item).toLowerCase()));
  const correctSelectionCount = Array.from(receivedSet).filter((item) => expectedSet.has(item)).length;
  const wrongSelectionCount = Array.from(receivedSet).filter((item) => !expectedSet.has(item)).length;
  const allCorrect =
    expected.length > 0 &&
    wrongSelectionCount === 0 &&
    correctSelectionCount === expectedSet.size &&
    receivedSet.size === expectedSet.size;

  // New question configuration is persisted in evaluationConfig. Retain the
  // former top-level shape as a read-only compatibility fallback for records
  // created before that contract was introduced.
  const questionScoring =
    question?.evaluationConfig?.multiSelectScoring &&
    typeof question.evaluationConfig.multiSelectScoring === 'object' &&
    !Array.isArray(question.evaluationConfig.multiSelectScoring)
      ? question.evaluationConfig.multiSelectScoring
      : question?.multiSelectScoring &&
          typeof question.multiSelectScoring === 'object' &&
          !Array.isArray(question.multiSelectScoring)
        ? question.multiSelectScoring
        : {};
  const scoringMode = String(
    questionScoring.scoringMode ||
      (questionScoring.partialMarking || questionScoring.enablePartialMarking
        ? 'PROPORTIONAL_PARTIAL'
        : 'ALL_OR_NOTHING')
  ).toUpperCase();
  const partialMarkingEnabled =
    questionScoring.partialMarking === true ||
    questionScoring.enablePartialMarking === true ||
    examMarkingRules?.multiSelectPartialMarking === true;
  const deductWrongSelections =
    questionScoring.deductWrongSelections === true ||
    examMarkingRules?.multiSelectDeductWrongSelections === true;
  const configuredPenaltyRaw =
    questionScoring.wrongSelectionPenalty ??
    examMarkingRules?.multiSelectWrongSelectionPenalty ??
    (examMarkingRules?.negativeMarking ? examMarkingRules?.negativeMarks : 0);
  const wrongSelectionPenalty = Number.isFinite(Number(configuredPenaltyRaw))
    ? Math.max(0, Number(configuredPenaltyRaw))
    : 0;
  const defaultCorrectOptionMarks = expectedSet.size > 0 ? questionPoints / expectedSet.size : 0;

  let pointsEarned = allCorrect ? questionPoints : 0;
  if (!allCorrect && expectedSet.size > 0) {
    if (scoringMode === 'PROPORTIONAL_PARTIAL' || partialMarkingEnabled) {
      pointsEarned = (questionPoints * correctSelectionCount) / expectedSet.size;
      // A proportional policy must not award full marks for selecting every
      // option. If no explicit penalty is configured, one correct-option
      // share is deducted for each incorrect selection.
      const penalty = deductWrongSelections || wrongSelectionCount > 0
        ? wrongSelectionPenalty || defaultCorrectOptionMarks
        : 0;
      pointsEarned -= wrongSelectionCount * penalty;
    } else if (scoringMode === 'POSITIVE_MINUS_INCORRECT') {
      const correctOptionMarks = Number.isFinite(Number(questionScoring.correctOptionMarks))
        ? Math.max(0, Number(questionScoring.correctOptionMarks))
        : defaultCorrectOptionMarks;
      const penalty = wrongSelectionPenalty || correctOptionMarks;
      pointsEarned = correctSelectionCount * correctOptionMarks - wrongSelectionCount * penalty;
    } else if (scoringMode === 'PER_OPTION_WEIGHT') {
      const optionWeights =
        questionScoring.optionWeights && typeof questionScoring.optionWeights === 'object'
          ? questionScoring.optionWeights
          : {};
      pointsEarned = Array.from(receivedSet).reduce((score, option) => {
        const configuredWeight = optionWeights[option] ?? optionWeights[String(option).toLowerCase()];
        if (Number.isFinite(Number(configuredWeight))) {
          return score + Number(configuredWeight);
        }
        return score + (expectedSet.has(option) ? defaultCorrectOptionMarks : -wrongSelectionPenalty);
      }, 0);
    }

    pointsEarned = Number(Math.min(questionPoints, Math.max(pointsEarned, 0)).toFixed(2));
  }

  return {
    isCorrect: allCorrect,
    pointsEarned,
    normalizedAnswerText: received.length ? JSON.stringify(received) : '',
  };
};

const normalizeAnswerForStorage = (questionType, value) => {
  if (questionType === 'MULTIPLE_OPTIONS') {
    const answers = parseArrayAnswer(value);
    return answers.length ? JSON.stringify(answers) : '';
  }
  if (questionType === 'CODING') {
    return normalizeCodingAnswerForStorage(value);
  }
  if (questionType === 'MATCHING') {
    return value && typeof value === 'object' ? JSON.stringify(value) : '';
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
};

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeStatusValue = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase();
};

const isOfflineSubmissionSource = (value) => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('offline');
};

const normalizeIpAddress = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const firstHop = raw.split(',')[0].trim();
  if (!firstHop) return '';

  const withoutIpv6Wrapper = firstHop.replace(/^\[|\]$/g, '');
  let normalized = withoutIpv6Wrapper;

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }

  // Remove port when IPv4 is represented as 1.2.3.4:5678
  if (normalized.includes('.') && normalized.includes(':')) {
    const [host] = normalized.split(':');
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      normalized = host;
    }
  }

  return normalized.toLowerCase();
};

const getRequestIpAddress = (req) => {
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedIp = String(forwardedValue || '')
    .split(',')[0]
    .trim();

  return (
    forwardedIp ||
    req?.ip ||
    req?.connection?.remoteAddress ||
    req?.socket?.remoteAddress ||
    ''
  );
};

const normalizeTrimmedString = (value) => String(value || '').trim();

const getRequestBrowserSessionId = (req) =>
  normalizeTrimmedString(
    req?.body?.browserSessionId ||
    req?.body?.attemptSessionId ||
    req?.headers?.['x-browser-session-id'] ||
    req?.headers?.['x-attempt-session-id'] ||
    ''
  );

const getRequestDeviceId = (req) =>
  normalizeTrimmedString(req?.body?.deviceId || req?.headers?.['x-device-id'] || '');

const buildRequestDeviceInfo = (req) => ({
  ipAddress: getRequestIpAddress(req),
  userAgent: req?.get?.('user-agent') || '',
  deviceId: getRequestDeviceId(req),
  browserSessionId: getRequestBrowserSessionId(req),
});

const enforceAttemptDeviceLock = async ({ attempt, req }) => {
  if (!attempt || attempt.isCompleted) {
    return { allowed: true };
  }

  const current = buildRequestDeviceInfo(req);
  const stored = attempt.deviceInfo || {};
  const currentBrowserSessionId = normalizeTrimmedString(current.browserSessionId);
  const storedBrowserSessionId = normalizeTrimmedString(stored.browserSessionId);
  const currentDeviceId = normalizeTrimmedString(current.deviceId);
  const storedDeviceId = normalizeTrimmedString(stored.deviceId);
  const currentIp = normalizeIpAddress(current.ipAddress);
  const storedIp = normalizeIpAddress(stored.ipAddress);
  const currentUserAgent = normalizeTrimmedString(current.userAgent);
  const storedUserAgent = normalizeTrimmedString(stored.userAgent);

  if (!storedBrowserSessionId && !storedDeviceId && !storedIp && !storedUserAgent) {
    attempt.deviceInfo = {
      ...(attempt.deviceInfo || {}),
      ...current,
    };
    await attempt.save();
    return { allowed: true };
  }

  if (storedBrowserSessionId && currentBrowserSessionId && storedBrowserSessionId !== currentBrowserSessionId) {
    return {
      allowed: false,
      error: 'This attempt is already active in another browser session.',
    };
  }

  if (storedDeviceId && currentDeviceId && storedDeviceId !== currentDeviceId) {
    return {
      allowed: false,
      error: 'This attempt is already active on another device.',
    };
  }

  if (storedIp && currentIp && storedIp !== currentIp) {
    return {
      allowed: false,
      error: 'This attempt is locked to the original network/IP.',
    };
  }

  if (storedUserAgent && currentUserAgent && storedUserAgent !== currentUserAgent) {
    return {
      allowed: false,
      error: 'This attempt is already active in another browser.',
    };
  }

  const updates = {};
  if (!stored.browserSessionId && current.browserSessionId) updates.browserSessionId = current.browserSessionId;
  if (!stored.deviceId && current.deviceId) updates.deviceId = current.deviceId;
  if (!stored.ipAddress && current.ipAddress) updates.ipAddress = current.ipAddress;
  if (!stored.userAgent && current.userAgent) updates.userAgent = current.userAgent;

  if (Object.keys(updates).length > 0) {
    attempt.deviceInfo = {
      ...(attempt.deviceInfo || {}),
      ...updates,
    };
    await attempt.save();
  }

  return { allowed: true };
};

const appendIpLockFlag = (attempt, details = {}) => {
  if (!attempt) return;
  if (!attempt.suspiciousActivityFlags) {
    attempt.suspiciousActivityFlags = [];
  }

  const now = Date.now();
  const recentDuplicate = attempt.suspiciousActivityFlags.some((entry) => {
    const type = normalizeStatusValue(entry?.type || entry?.violationType);
    if (type !== 'IP_LOCK_VIOLATION') return false;
    const timestamp = new Date(entry?.timestamp || 0).getTime();
    return Number.isFinite(timestamp) && Math.abs(now - timestamp) < 10000;
  });

  if (recentDuplicate) return;

  attempt.suspiciousActivityFlags.push({
    type: 'IP_LOCK_VIOLATION',
    timestamp: new Date(),
    details,
  });
  attempt.suspiciousActivity = true;
};

const enforceAttemptIpLock = async ({ attempt, req, planType }) => {
  if (!attempt || !planType || !isPlanFeatureEnabled(planType, 'ipLock')) {
    return { allowed: true };
  }

  const currentIpRaw = getRequestIpAddress(req);
  const currentIp = normalizeIpAddress(currentIpRaw);
  if (!currentIp) {
    return { allowed: true };
  }

  const lockedIpRaw = attempt?.deviceInfo?.ipAddress || '';
  const lockedIp = normalizeIpAddress(lockedIpRaw);

  if (!lockedIp) {
    attempt.deviceInfo = {
      ...(attempt.deviceInfo || {}),
      ipAddress: currentIpRaw || currentIp,
    };
    await attempt.save();
    return { allowed: true };
  }

  if (lockedIp !== currentIp) {
    const details = {
      lockedIp: lockedIpRaw || lockedIp,
      currentIp: currentIpRaw || currentIp,
      reason: 'IP lock mismatch detected.',
    };
    appendAttemptViolationLog(attempt, 'IP_LOCK_VIOLATION', details);
    appendIpLockFlag(attempt, details);
    await attempt.save();
    return {
      allowed: false,
      error: 'IP lock violation detected. Continue this attempt from the original network/IP.',
    };
  }

  return { allowed: true };
};

const appendAttemptViolationLog = (attempt, violationType, details = {}) => {
  const normalizedType = normalizeStatusValue(violationType) || 'OTHER';
  if (!attempt.proctoringViolations) {
    attempt.proctoringViolations = [];
  }

  const recentDuplicate = attempt.proctoringViolations.some((entry) => {
    const entryType = normalizeStatusValue(entry?.violationType);
    if (entryType !== normalizedType) {
      return false;
    }
    const timestamp = new Date(entry?.timestamp || 0).getTime();
    return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < 10000;
  });

  if (recentDuplicate) {
    return;
  }

  attempt.proctoringViolations.push({
    userId: attempt.userId || null,
    examId: attempt.examId?._id || attempt.examId || null,
    timestamp: new Date(),
    violationType: normalizedType,
    ...details,
  });
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
  const normalizedRequested = normalizeStatusValue(requestedStatus);
  if (normalizedRequested === 'FAIR' || normalizedRequested === 'SUSPICIOUS' || normalizedRequested === 'CHEATING') {
    return normalizedRequested;
  }
  if (violationCount <= 0) return 'FAIR';
  if (violationCount <= 2) return 'SUSPICIOUS';
  return 'CHEATING';
};

const normalizeViolationLogsPayload = (rawLogs, { attempt, defaultReason = '' } = {}) => {
  if (!Array.isArray(rawLogs)) return [];

  return rawLogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const eventTimestampRaw = entry.timestamp || entry.time || entry.createdAt;
      const parsedTimestamp = eventTimestampRaw ? new Date(eventTimestampRaw) : new Date();
      const timestamp = Number.isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp;
      const violationType = normalizeViolationType(
        entry.violationType || entry.type || entry.eventType || 'OTHER'
      );
      const examId =
        entry.examId ||
        attempt?.examId?._id ||
        attempt?.examId ||
        null;
      const userId = entry.userId || attempt?.userId || null;
      const detailsRaw = entry.details;
      const details =
        typeof detailsRaw === 'string'
          ? detailsRaw
          : typeof detailsRaw === 'object' && detailsRaw !== null
            ? JSON.stringify(detailsRaw)
            : (entry.message || defaultReason || '').toString();
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

const mergeViolationLogs = (existingLogs, incomingLogs) => {
  const merged = Array.isArray(existingLogs)
    ? existingLogs.map((entry) => ({ ...entry }))
    : [];

  if (!Array.isArray(incomingLogs)) {
    return merged;
  }

  for (const entry of incomingLogs) {
    if (!entry || typeof entry !== 'object') continue;
    const violationType = normalizeViolationType(entry.violationType || entry.type || entry.eventType);
    const timestampMs = new Date(entry.timestamp || Date.now()).getTime();
    const duplicate = merged.some((stored) => {
      const storedType = normalizeViolationType(
        stored?.violationType || stored?.type || stored?.eventType
      );
      if (storedType !== violationType) {
        return false;
      }
      const storedTs = new Date(stored?.timestamp || 0).getTime();
      return Number.isFinite(storedTs) && Number.isFinite(timestampMs) && Math.abs(storedTs - timestampMs) < 1000;
    });
    if (!duplicate) {
      merged.push(entry);
    }
  }

  return merged;
};

const buildAttemptIntegritySummary = (attempt) => {
  const logs = Array.isArray(attempt?.violationLogs)
    ? attempt.violationLogs
    : [];
  const countFromField = toNonNegativeInt(attempt?.violationCount, logs.length);
  const violationCount = Math.max(countFromField, logs.length);
  const examStatus = resolveExamStatusFromViolationCount(
    violationCount,
    attempt?.examStatus || '',
  );

  return {
    totalViolations: violationCount,
    violationDetails: logs,
    examStatus,
  };
};

const countAttemptedQuestionsForAttempt = async (attemptId) =>
  Answer.countDocuments({
    attemptId,
    answerText: { $exists: true, $nin: ['', null] },
  });

const parseStoredAnswerValue = (questionType, value) => {
  if (questionType === 'MULTIPLE_OPTIONS') {
    return parseArrayAnswer(value);
  }
  if (questionType === 'CODING') {
    return parseCodingAnswerPayload(value);
  }
  if (questionType === 'MATCHING') {
    try {
      const parsed = JSON.parse(String(value || ''));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (value === undefined || value === null) {
    return '';
  }
  return value;
};

const toQuestionPaperIdString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return value._id.toString();
  return String(value);
};

const toStrictPositiveInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const resolveSectionBasedDurationMinutes = async ({ questionPaperId, fallbackMinutes = 0 }) => {
  const normalizedQuestionPaperId = toQuestionPaperIdString(questionPaperId);
  if (!normalizedQuestionPaperId) {
    return Math.max(toStrictPositiveInt(fallbackMinutes, 0), 0);
  }

  const sections = await Section.find({
    questionPaperId: normalizedQuestionPaperId,
    isActive: true,
  })
    .select('duration')
    .lean();

  if (!sections.length) {
    return Math.max(toStrictPositiveInt(fallbackMinutes, 0), 0);
  }

  const totalDuration = sections.reduce(
    (sum, section) => sum + toStrictPositiveInt(section?.duration, 0),
    0
  );

  if (totalDuration <= 0) {
    return Math.max(toStrictPositiveInt(fallbackMinutes, 0), 0);
  }

  return totalDuration;
};

const buildTotalTimerSnapshot = async (attempt, examRef, questionPaperId = null) => {
  const fallbackExamDurationMinutes = Number(examRef?.duration) || 0;
  let examDurationMinutes = fallbackExamDurationMinutes;
  try {
    examDurationMinutes = await resolveSectionBasedDurationMinutes({
      questionPaperId,
      fallbackMinutes: fallbackExamDurationMinutes,
    });
  } catch {
    examDurationMinutes = fallbackExamDurationMinutes;
  }

  const graceMinutes = Number(examRef?.gracePeriod) || 0;
  const totalDurationSeconds = Math.max(
    Math.floor((examDurationMinutes + graceMinutes) * 60),
    0
  );
  const examStartTime = attempt?.startTime ? new Date(attempt.startTime) : null;
  const now = new Date();

  let totalRemainingSeconds = totalDurationSeconds;
  if (examStartTime && !Number.isNaN(examStartTime.getTime())) {
    const elapsedSeconds = Math.max(
      Math.floor((now.getTime() - examStartTime.getTime()) / 1000),
      0
    );
    totalRemainingSeconds = Math.max(totalDurationSeconds - elapsedSeconds, 0);
  }

  return {
    examStartTime: examStartTime ? examStartTime.toISOString() : null,
    totalDurationSeconds,
    totalRemainingSeconds,
    serverTime: now.toISOString(),
  };
};

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
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

const normalizeCodingSubmissionPayload = (payload = {}) => {
  const source = Array.isArray(payload?.codingSubmissions)
    ? payload.codingSubmissions
    : Array.isArray(payload?.codingAnswers)
      ? payload.codingAnswers
      : [];

  const submissionsByQuestionId = new Map();

  source.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;

    const questionId = normalizeString(entry.questionId);
    if (!/^[a-fA-F0-9]{24}$/.test(questionId)) return;

    const language = normalizeCodingLanguage(entry.language) || '';
    const code = normalizeString(entry.code);
    const input = normalizeString(entry.input);
    const output = normalizeString(entry.output);
    const scoreRaw = Number(entry.score);
    const score = Number.isFinite(scoreRaw)
      ? Math.min(Math.max(Math.round(scoreRaw), 0), 100)
      : 0;
    const total = toNonNegativeInt(entry.total, 0);
    const passed = toNonNegativeInt(entry.passed, 0);
    const failed =
      total > 0 ? Math.max(total - passed, 0) : toNonNegativeInt(entry.failed, 0);
    const plagiarism =
      entry.plagiarism && typeof entry.plagiarism === 'object'
        ? {
          flagged: Boolean(entry.plagiarism.flagged),
          similarity: Math.min(
            Math.max(Number(entry.plagiarism.similarity) || 0, 0),
            100
          ),
        }
        : null;

    submissionsByQuestionId.set(questionId, {
      questionId,
      language,
      code,
      input,
      output,
      score,
      total,
      passed,
      failed,
      plagiarism,
    });
  });

  return submissionsByQuestionId;
};

const scheduleDeferredCodingEvaluation = ({
  pendingEvaluations = [],
  attemptId,
  userId,
  examId,
  attemptStartedAt,
  planType = null,
} = {}) => {
  if (!pendingEvaluations.length || !attemptId || !userId || !examId) return;

  setImmediate(async () => {
    try {
      const answerUpdates = [];

      for (const evaluationRequest of pendingEvaluations) {
        try {
          const evaluation = await evaluateCodingQuestionSubmission({
            question: evaluationRequest.question,
            code: evaluationRequest.code,
            language: evaluationRequest.language,
            input: evaluationRequest.input,
            planType,
          });

          const submissionRecord = await saveCodingSubmissionRecord({
            attemptId,
            userId,
            examId,
            questionId: evaluationRequest.question._id,
            code: evaluationRequest.code,
            language: evaluationRequest.language,
            evaluation,
            attemptStartedAt,
          });

          answerUpdates.push({
            updateOne: {
              filter: {
                attemptId,
                questionId: evaluationRequest.question._id,
              },
              update: {
                $set: {
                  isCorrect: evaluation.failed === 0 && evaluation.total > 0,
                  pointsEarned: evaluation.pointsEarned,
                  aiEvaluation: {
                    type: 'CODING',
                    score: evaluation.score,
                    passed: evaluation.passed,
                    failed: evaluation.failed,
                    submissionId: submissionRecord._id,
                    plagiarism: submissionRecord?.plagiarism || {
                      flagged: false,
                      similarity: 0,
                    },
                  },
                  codingResult: evaluation.result,
                  submissionId: submissionRecord._id,
                  needsReview: false,
                },
              },
            },
          });
        } catch (evaluationError) {
          console.error(
            `[CODING_EVAL] Deferred coding evaluation failed for attempt ${attemptId} question ${evaluationRequest?.question?._id}:`,
            evaluationError
          );
          answerUpdates.push({
            updateOne: {
              filter: {
                attemptId,
                questionId: evaluationRequest.question?._id,
              },
              update: {
                $set: {
                  needsReview: true,
                  aiEvaluation: {
                    type: 'CODING',
                    error: 'Deferred evaluation failed',
                    needsReview: true,
                  },
                },
              },
            },
          });
        }
      }

      if (answerUpdates.length > 0) {
        await Answer.bulkWrite(answerUpdates, { ordered: false });
      }

      const gradedAnswers = await Answer.find({ attemptId })
        .populate('questionId', 'points')
        .select('pointsEarned questionId');
      let totalScore = 0;
      let maxScore = 0;

      gradedAnswers.forEach((answerDoc) => {
        totalScore += Number(answerDoc.pointsEarned) || 0;
        maxScore += Number(answerDoc.questionId?.points) || 0;
      });

      const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

      await ExamAttempt.findByIdAndUpdate(attemptId, {
        $set: {
          scoreSummary: {
            totalScore,
            maxScore,
            percentage,
            computedAt: new Date(),
          },
        },
      });
    } catch (error) {
      console.error(`[CODING_EVAL] Deferred coding evaluation pipeline failed for attempt ${attemptId}:`, error);
    }
  });
};

const ADMIN_VIEWER_ROLES = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'EXAM_CREATOR']);

// isExamResultsReleased is imported from ../utils/resultVisibility.js — the
// single source of truth shared with routes/candidates.js and
// routes/results.js (previously three drifted implementations).

const isCertificatesReleased = (exam) => {
  if (!exam?.certificatesSentAt) return false;
  const sentAt = new Date(exam.certificatesSentAt);
  return !Number.isNaN(sentAt.getTime()) && sentAt <= new Date();
};

const canBypassReleaseWindow = ({ userRole, canReviewAnswers = false }) =>
  ADMIN_VIEWER_ROLES.has(userRole) || Boolean(canReviewAnswers);

const ensureQuestionPaperImagesReady = async ({ questionPaperId, examId }) => {
  if (!questionPaperId || !examId) return;

  const questions = await Question.find({ questionPaperId }).sort({ order: 1 });
  if (!questions.length) return;

  await ensureQuestionsImageAvailability({
    questions,
    examId,
    persist: true,
  });
};

const router = express.Router();

// Get all attempts (universal: based on exam permissions)
router.get('/', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId, sessionId, userId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Start with tenant filter to ensure data isolation
    const filter = { ...req.tenantFilter };

    if (examId) filter.examId = examId;
    if (sessionId) filter.sessionId = sessionId;

    // SUPER_ADMIN and EXAM_CREATOR can see all attempts in their scope
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'EXAM_CREATOR') {
      if (userId) {
        filter.userId = userId;
      }
    } else {
      // Regular users: check exam permissions
      if (examId) {
        // Only reviewers/admins can inspect attempts of other users.
        const canReviewAnswers = await hasExamPermission(req.user._id, examId, 'REVIEW_ANSWERS');
        if (!canReviewAnswers) {
          // User can only see their own attempts for this exam
          filter.userId = req.user._id;
        } else if (userId) {
          // Reviewer/admin can filter by any candidate userId
          filter.userId = userId;
        }
      } else {
        // No examId: users can only see their own attempts
        filter.userId = req.user._id;
      }
    }

    const attempts = await ExamAttempt.find(filter)
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
      .populate('sessionId', 'qrCode startTime endTime')
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await ExamAttempt.countDocuments(filter);

    const privilegedViewer = ADMIN_VIEWER_ROLES.has(req.user.role);
    const sanitizedAttempts = attempts.map((attemptDoc) => {
      const attemptObj = attemptDoc.toObject();
      const released = isExamResultsReleased(attemptObj.examId);
      if (!privilegedViewer && !released) {
        delete attemptObj.scoreSummary;
        delete attemptObj.normalizedScore;
        delete attemptObj.percentile;
        delete attemptObj.sessionPercentile;
      }

      // Backward compatibility for clients expecting `status` and `score`.
      attemptObj.status = attemptObj.isCompleted ? 'COMPLETED' : 'IN_PROGRESS';
      attemptObj.submittedAt = attemptObj.submittedAt || attemptObj.submitTime || null;
      attemptObj.score = attemptObj.scoreSummary
        ? {
          totalScore: Number(attemptObj.scoreSummary.totalScore) || 0,
          maxScore: Number(attemptObj.scoreSummary.maxScore) || 0,
          percentage: Number(attemptObj.scoreSummary.percentage) || 0,
        }
        : null;

      return attemptObj;
    });

    res.json({
      attempts: sanitizedAttempts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Start attempt - Only CANDIDATE can start exam attempts
 * 
 * Simple flow:
 * 1. User must be CANDIDATE role
 * 2. Session must be active and within time window
 * 3. User must not have exceeded max attempts
 * 4. ExamParticipant record is auto-created with CANDIDATE role if not exists
 * 5. Attempt inherits tenantId from exam
 */
router.post(
  '/',
  requireAuth,
  requireRole('CANDIDATE'), // Only CANDIDATE can attempt exams
  [
    body('sessionId').notEmpty().withMessage('Session ID is required'),
    body('examId').notEmpty().withMessage('Exam ID is required'),
  ],
  checkCandidateAttemptLimit,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { sessionId, examId } = req.body;
      const effectivePlanType = req.planLimitContext?.planType || null;
      const planFeatures = getSubscriptionPlanDefinition(effectivePlanType)?.features || {};

      // Check exam permission: user must have ATTEMPT_EXAM permission
      const canAttempt = await hasExamPermission(req.user._id, examId, 'ATTEMPT_EXAM');
      if (!canAttempt) {
        return res.status(403).json({ error: 'You do not have permission to attempt this exam' });
      }

      // Check if user is blocked (universal: changed from blocked_student_ to blocked_user_)
      // Check both old and new key format for backward compatibility
      const blockedConfig = await SystemConfig.findOne({
        $or: [
          { key: `blocked_user_${req.user._id}` }, // New universal format
          { key: `blocked_student_${req.user._id}` }, // Legacy format
        ],
      });

      if (blockedConfig && blockedConfig.value === 'true') {
        return res.status(403).json({ error: 'Your account has been blocked' });
      }

      // Verify session and exam exist
      const session = await ExamSession.findById(sessionId).populate('examId');
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!(await canCandidateAccessSession(req.user._id, session))) {
        return res.status(403).json({ error: 'You are not assigned to this session' });
      }

      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }
      try {
        await assertExamProductAccess({ tenantId: req.user.tenantId, exam });
      } catch (accessError) {
        if (accessError instanceof WizKidsAccessError) {
          return res.status(accessError.status).json({ error: accessError.message });
        }
        throw accessError;
      }

      // Verify session belongs to exam
      if (session.examId._id.toString() !== examId) {
        return res.status(400).json({ error: 'Session does not belong to this exam' });
      }

      // Verify tenant match: session and exam must belong to same tenant
      const sessionTenantId = session.tenantId;
      const examTenantId = exam.tenantId;

      if (sessionTenantId && examTenantId) {
        if (sessionTenantId.toString() !== examTenantId.toString()) {
          return res.status(400).json({ error: 'Session and exam belong to different tenants' });
        }
      }

      // Verify user has access to this tenant (already checked via exam permission, but double-check)
      const userTenantId = req.user.tenantId;
      if (userTenantId && examTenantId && req.user.role !== 'SUPER_ADMIN') {
        if (userTenantId.toString() !== examTenantId.toString()) {
          return res.status(403).json({ error: 'You do not have access to this exam' });
        }
      }

      const examAccessControlCheck = enforceExamAccessControl({
        exam,
        req,
        planType: effectivePlanType,
      });
      if (!examAccessControlCheck.allowed) {
        return res.status(403).json({ error: examAccessControlCheck.error });
      }

      if (!session.isActive) {
        return res.status(403).json({ error: 'Session is not active' });
      }

      const now = new Date();
      if (now < session.startTime || now > session.endTime) {
        return res.status(403).json({ error: 'Session is not available at this time' });
      }

      // Check max attempts (exam already loaded above)
      // First check if user has a re-attempt allowed flag on any completed attempt
      const hasReAttemptAllowed = await ExamAttempt.findOne({
        userId: req.user._id,
        examId,
        reAttemptAllowed: true,
        isCompleted: true,
      }).sort({ createdAt: -1 });

      if (!hasReAttemptAllowed) {
        // Only check max attempts if no re-attempt is allowed
        const existingAttempts = await ExamAttempt.countDocuments({
          userId: req.user._id,
          examId,
          isCompleted: true,
        });

        if (existingAttempts >= exam.maxAttempts) {
          return res.status(403).json({
            error: `Maximum attempts (${exam.maxAttempts}) reached for this exam. Please contact the exam administrator to request additional attempts.`,
          });
        }
      } else {
        // User has re-attempt allowed, log it for audit
        console.log(`User ${req.user._id} attempting exam ${examId} with re-attempt flag from attempt ${hasReAttemptAllowed._id}`);
      }

      // Enforce one active attempt per candidate per exam.
      const activeAttempt = await ExamAttempt.findOne({
        userId: req.user._id,
        examId,
        isCompleted: false,
        isDisqualified: false,
      })
        .populate('questionPaperId', 'setName')
        .populate('sessionId', 'startTime endTime');

      if (activeAttempt) {
        if (activeAttempt.sessionId?._id?.toString() !== sessionId.toString()) {
          return res.status(409).json({
            error: 'You already have an active attempt for this exam. Please finish or submit it before starting another session.',
            attemptId: activeAttempt._id,
          });
        }

        const deviceLockCheck = await enforceAttemptDeviceLock({ attempt: activeAttempt, req });
        if (!deviceLockCheck.allowed) {
          return res.status(409).json({ error: deviceLockCheck.error });
        }

        if (
          isFreePlan(effectivePlanType) &&
          await hasWritingQuestionsInPaper(
            activeAttempt.questionPaperId?._id || activeAttempt.questionPaperId
          )
        ) {
          return sendWritingPlanRestriction(res);
        }

        const ipLockCheck = await enforceAttemptIpLock({
          attempt: activeAttempt,
          req,
          planType: effectivePlanType,
        });
        if (!ipLockCheck.allowed) {
          return res.status(403).json({ error: ipLockCheck.error });
        }

        await activeAttempt.populate('examId', 'title duration');
        await ensureQuestionPaperImagesReady({
          questionPaperId:
            activeAttempt.questionPaperId?._id || activeAttempt.questionPaperId,
          examId,
        });
        return res.json({
          attempt: activeAttempt,
          assignment: {
            questionPaperId:
              activeAttempt.questionPaperId?._id || activeAttempt.questionPaperId,
            setName: activeAttempt.questionPaperId?.setName,
          },
          planContext: {
            planType: effectivePlanType,
            features: planFeatures,
            security: {
              secureBrowser:
                exam?.accessControl?.secureBrowser && typeof exam.accessControl.secureBrowser === 'object'
                  ? exam.accessControl.secureBrowser
                  : { enabled: true },
            },
          },
        });
      }

      // Note: ExamParticipant is already created above before permission check

      await session.populate('questionPaperIds', 'setName');
      const assignment = await assignQuestionPaperToStudent({
        session,
        userId: req.user._id,
      });
      const assignedQuestionPaperId =
        assignment.questionPaperId?._id || assignment.questionPaperId;

      if (
        isFreePlan(effectivePlanType) &&
        await hasWritingQuestionsInPaper(assignedQuestionPaperId)
      ) {
        return sendWritingPlanRestriction(res);
      }

      await ensureQuestionPaperImagesReady({
        questionPaperId: assignedQuestionPaperId,
        examId,
      });

      // Inherit tenant ID from exam
      const examForTenant = await Exam.findById(examId).select('tenantId');

      // Create new attempt
      const attempt = new ExamAttempt({
        examId,
        sessionId,
        userId: req.user._id,
        questionPaperId: assignedQuestionPaperId,
        startTime: now,
        isCompleted: false,
        examSnapshot: {
          title: exam?.title || '',
          description: exam?.description || '',
        },
        // Inherit tenant ID from exam
        tenantId: examForTenant?.tenantId || null,
        // Log device info
        deviceInfo: {
          ...buildRequestDeviceInfo(req),
        },
      });

      await attempt.save();
      if (hasReAttemptAllowed?._id) {
        await ExamAttempt.updateOne(
          { _id: hasReAttemptAllowed._id },
          {
            $set: {
              reAttemptAllowed: false,
              reAttemptReason: hasReAttemptAllowed.reAttemptReason || 'Re-attempt allowance consumed',
            },
          }
        );
        // An ExaminerAssignment scoped to a static list of attempt IDs
        // (scopeType: 'ATTEMPTS') would otherwise never see this reattempt,
        // since its scopeData.attemptIds only names the original attempt.
        // Extend any such assignment so the evaluator's queue still covers
        // the candidate's new attempt for this exam.
        try {
          await ExaminerAssignment.updateMany(
            { examId, scopeType: 'ATTEMPTS', 'scopeData.attemptIds': hasReAttemptAllowed._id },
            { $addToSet: { 'scopeData.attemptIds': attempt._id } }
          );
        } catch (assignmentScopeError) {
          console.error('[EXAMINER_ASSIGNMENT] Failed to extend ATTEMPTS scope for reattempt:', assignmentScopeError?.message || assignmentScopeError);
        }
      }
      if (req.planLimitContext?.shouldIncrementCandidateCount) {
        await syncExamCandidateCount(examId);
      }

      try {
        const { createRoleNotification, createUserNotification } = await import('../services/notificationService.js');
        const tenantId = exam?.tenantId || examForTenant?.tenantId || null;
        const examTitle = exam?.title || attempt.examSnapshot?.title || 'Exam';
        const candidateName = req.user.name || req.user.email || 'Candidate';

        await createUserNotification({
          title: 'Exam Started',
          message: `You started "${examTitle}".`,
          type: 'exam_started',
          roles: ['CANDIDATE'],
          userId: req.user._id,
          tenantId,
          examId: examId,
          sessionId,
          attemptId: attempt._id,
          createdBy: req.user._id,
          metadata: { examId, examTitle },
        });

        if (tenantId) {
          await createRoleNotification({
            title: 'Exam Started',
            message: `${candidateName} started "${examTitle}".`,
            type: 'session_started',
            roles: ['TENANT_ADMIN', 'EXAM_CREATOR'],
            tenantId,
            examId: examId,
            sessionId,
            attemptId: attempt._id,
            createdBy: req.user._id,
            metadata: { examId, examTitle, candidateName },
          });
        }
      } catch (notifyError) {
        console.error('[NOTIFICATIONS] Failed to log exam start:', notifyError?.message || notifyError);
      }

      if (isPlanFeatureEnabled(req.planLimitContext?.planType, 'proctoring')) {
        // Check for multiple logins
        const proctoringService = await import('../services/proctoringService.js');
        await proctoringService.logDeviceInfo(attempt._id, attempt.deviceInfo);
        const multipleLogins = await proctoringService.checkMultipleLogins(req.user._id, examId, attempt.deviceInfo);
        if (multipleLogins.hasMultipleLogins) {
          await proctoringService.flagSuspiciousActivity(attempt._id, 'MULTIPLE_LOGINS', {
            attempts: multipleLogins.attempts,
          });
        }
      }
      await attempt.populate('examId', 'title duration');
      await attempt.populate('sessionId', 'startTime endTime');
      await attempt.populate('questionPaperId', '_id');

      // Store attempt ID for audit log
      res.locals.attemptId = attempt._id.toString();

      res.status(201).json({
        attempt,
        assignment: {
          questionPaperId: assignedQuestionPaperId,
          setName: assignment.questionPaperId?.setName,
        },
        planContext: {
          planType: effectivePlanType,
          features: planFeatures,
          security: {
            secureBrowser:
              exam?.accessControl?.secureBrowser && typeof exam.accessControl.secureBrowser === 'object'
                ? exam.accessControl.secureBrowser
                : { enabled: true },
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Save/restore attempt progress (autosave support)
router.get('/:attemptId/progress', requireAuth, validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate('examId', '_id duration gracePeriod accessControl')
      .populate('sessionId', '_id questionPaperId')
      .populate('questionPaperId', '_id');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    const canReview = await hasExamPermission(
      req.user._id,
      attempt.examId?._id || attempt.examId,
      'REVIEW_ANSWERS'
    );
    if (!canReview && attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden - You can only view your own attempt progress' });
    }

    if (!canReview) {
      if (!(await canCandidateAccessSession(req.user._id, attempt.sessionId))) {
        return res.status(403).json({ error: 'You are not assigned to this session' });
      }
      const planContext = await resolveExamPlanContext(attempt.examId?._id || attempt.examId);
      const accessControlCheck = enforceExamAccessControl({
        exam: attempt.examId,
        req,
        planType: planContext?.planType || null,
      });
      if (!accessControlCheck.allowed) {
        return res.status(403).json({ error: accessControlCheck.error });
      }
      const ipLockCheck = await enforceAttemptIpLock({
        attempt,
        req,
        planType: planContext?.planType || null,
      });
      if (!ipLockCheck.allowed) {
        return res.status(403).json({ error: ipLockCheck.error });
      }
      const deviceLockCheck = await enforceAttemptDeviceLock({ attempt, req });
      if (!deviceLockCheck.allowed) {
        return res.status(409).json({ error: deviceLockCheck.error });
      }
      if (attempt.isDisqualified && !attempt.isCompleted) {
        return res.status(403).json({ error: 'Attempt is disqualified and cannot be resumed.' });
      }
    }

    const assignedQuestionPaperId =
      attempt.questionPaperId?._id ||
      attempt.questionPaperId ||
      attempt.sessionId?.questionPaperId;

    if (!assignedQuestionPaperId) {
      return res.status(400).json({ error: 'No question paper assigned for this attempt.' });
    }

    const getProgressPlanContext = await resolveExamPlanContext(attempt.examId?._id || attempt.examId);
    if (
      !canReview &&
      getProgressPlanContext?.planType &&
      isFreePlan(getProgressPlanContext.planType) &&
      await hasWritingQuestionsInPaper(assignedQuestionPaperId)
    ) {
      return sendWritingPlanRestriction(res);
    }

    const questions = await Question.find({
      questionPaperId: assignedQuestionPaperId,
    }).select('_id questionType');

    const questionTypeMap = new Map(
      questions.map((question) => [question._id.toString(), question.questionType])
    );
    const answers = await Answer.find({ attemptId: attempt._id }).select('questionId answerText');

    const totalTimerSnapshot = await buildTotalTimerSnapshot(
      attempt,
      attempt.examId,
      assignedQuestionPaperId
    );

    const progressAnswers = {};
    answers.forEach((answerDoc) => {
      const questionId = answerDoc.questionId?.toString();
      if (!questionId || !questionTypeMap.has(questionId)) return;

      progressAnswers[questionId] = parseStoredAnswerValue(
        questionTypeMap.get(questionId),
        answerDoc.answerText
      );
    });

    res.json({
      attempt: {
        _id: attempt._id,
        status: attempt.isCompleted ? 'COMPLETED' : 'IN_PROGRESS',
        isCompleted: attempt.isCompleted,
        submitTime: attempt.submitTime || null,
        submittedAt: attempt.submittedAt || attempt.submitTime || null,
        lastActivity: attempt.lastActivity,
      },
      answers: progressAnswers,
      sectionProgress: await getAttemptSectionProgress(attempt._id),
      timer: totalTimerSnapshot,
    });
  } catch (error) {
    next(error);
  }
});

const progressValidationRules = [
  body('answers').optional().isObject().withMessage('Answers must be an object'),
  body('lastActivity').optional().isISO8601().withMessage('lastActivity must be an ISO 8601 date'),
  body('currentSectionId').optional().isMongoId().withMessage('currentSectionId must be a valid section id'),
];

const updateAttemptProgressHandler = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate('examId', '_id duration gracePeriod accessControl')
      .populate('sessionId', '_id questionPaperId')
      .populate('questionPaperId', '_id');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    const canReview = await hasExamPermission(
      req.user._id,
      attempt.examId?._id || attempt.examId,
      'REVIEW_ANSWERS'
    );
    if (!canReview && attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden - You can only update your own attempt progress' });
    }

    if (!canReview) {
      if (!(await canCandidateAccessSession(req.user._id, attempt.sessionId))) {
        return res.status(403).json({ error: 'You are not assigned to this session' });
      }
      const planContext = await resolveExamPlanContext(attempt.examId?._id || attempt.examId);
      const accessControlCheck = enforceExamAccessControl({
        exam: attempt.examId,
        req,
        planType: planContext?.planType || null,
      });
      if (!accessControlCheck.allowed) {
        return res.status(403).json({ error: accessControlCheck.error });
      }
      const ipLockCheck = await enforceAttemptIpLock({
        attempt,
        req,
        planType: planContext?.planType || null,
      });
      if (!ipLockCheck.allowed) {
        return res.status(403).json({ error: ipLockCheck.error });
      }
      const deviceLockCheck = await enforceAttemptDeviceLock({ attempt, req });
      if (!deviceLockCheck.allowed) {
        return res.status(409).json({ error: deviceLockCheck.error });
      }
      if (attempt.isDisqualified && !attempt.isCompleted) {
        return res.status(403).json({ error: 'Attempt is disqualified and cannot be continued.' });
      }
    }

    if (attempt.isCompleted) {
      return res.status(400).json({ error: 'Attempt already submitted' });
    }

    const assignedQuestionPaperId =
      attempt.questionPaperId?._id ||
      attempt.questionPaperId ||
      attempt.sessionId?.questionPaperId;

    if (!assignedQuestionPaperId) {
      return res.status(400).json({ error: 'No question paper assigned for this attempt.' });
    }

    const putProgressPlanContext = await resolveExamPlanContext(attempt.examId?._id || attempt.examId);
    if (
      !canReview &&
      putProgressPlanContext?.planType &&
      isFreePlan(putProgressPlanContext.planType) &&
      await hasWritingQuestionsInPaper(assignedQuestionPaperId)
    ) {
      return sendWritingPlanRestriction(res);
    }

    let sectionProgress = null;
    if (req.body.currentSectionId) {
      try {
        const timerSync = await startSectionTimer(
          req.params.attemptId,
          req.body.currentSectionId
        );
        sectionProgress = timerSync?.sectionState || null;
      } catch (timerError) {
        // For heartbeat requests, return latest state even if section became locked meanwhile.
        sectionProgress = await getAttemptSectionProgress(req.params.attemptId);
      }
    }

    const incomingAnswers =
      req.body.answers && typeof req.body.answers === 'object'
        ? req.body.answers
        : {};
    const validQuestionIds = Object.keys(incomingAnswers).filter((id) =>
      /^[a-fA-F0-9]{24}$/.test(id)
    );

    let savedCount = 0;
    if (validQuestionIds.length > 0) {
      const questions = await Question.find({
        _id: { $in: validQuestionIds },
        questionPaperId: assignedQuestionPaperId,
        isIncludedInExam: { $ne: false },
      }).select('_id questionType');

      const questionMap = new Map(
        questions.map((question) => [question._id.toString(), question.questionType])
      );

      const operations = [];
      for (const [questionId, rawValue] of Object.entries(incomingAnswers)) {
        const questionType = questionMap.get(questionId);
        if (!questionType) continue;

        operations.push({
          updateOne: {
            filter: { attemptId: attempt._id, questionId },
            update: {
              $set: {
                answerText: normalizeAnswerForStorage(questionType, rawValue),
                pointsEarned: 0,
                aiEvaluation: null,
                needsReview: false,
                updatedAt: new Date(),
              },
              $unset: {
                isCorrect: '',
              },
              $setOnInsert: {
                attemptId: attempt._id,
                questionId,
              },
            },
            upsert: true,
          },
        });
      }

      if (operations.length > 0) {
        await Answer.bulkWrite(operations, { ordered: false });
        savedCount = operations.length;
      }
    }

    const nextLastActivity = req.body.lastActivity
      ? new Date(req.body.lastActivity)
      : new Date();
    attempt.lastActivity = nextLastActivity;
    await ExamAttempt.updateOne(
      { _id: attempt._id },
      { $set: { lastActivity: nextLastActivity } }
    );

    if (!sectionProgress) {
      sectionProgress = await getAttemptSectionProgress(req.params.attemptId);
    }

    const totalTimerSnapshot = await buildTotalTimerSnapshot(
      attempt,
      attempt.examId,
      assignedQuestionPaperId
    );

    res.json({
      success: true,
      attemptStatus: attempt.isCompleted ? 'COMPLETED' : 'IN_PROGRESS',
      savedCount,
      lastActivity: attempt.lastActivity,
      sectionProgress,
      timer: totalTimerSnapshot,
      compatibilityRoute: req.path.endsWith('/answers'),
    });
  } catch (error) {
    next(error);
  }
};

router.put(
  '/:attemptId/progress',
  requireAuth,
  validateObjectId('attemptId'),
  progressValidationRules,
  updateAttemptProgressHandler
);

// Backward-compatible answer save endpoint.
// This keeps older clients working by mapping answer payloads to canonical progress writes.
router.post(
  '/:attemptId/answers',
  requireAuth,
  validateObjectId('attemptId'),
  [
    body('questionId').optional().isMongoId().withMessage('questionId must be a valid question id'),
    body('answers').optional().isObject().withMessage('Answers must be an object'),
    body('lastActivity').optional().isISO8601().withMessage('lastActivity must be an ISO 8601 date'),
    body('currentSectionId').optional().isMongoId().withMessage('currentSectionId must be a valid section id'),
  ],
  async (req, res, next) => {
    const normalizedAnswers =
      req.body.answers && typeof req.body.answers === 'object'
        ? { ...req.body.answers }
        : {};

    if (
      typeof req.body.questionId === 'string' &&
      /^[a-fA-F0-9]{24}$/.test(req.body.questionId) &&
      Object.prototype.hasOwnProperty.call(req.body, 'answer')
    ) {
      normalizedAnswers[req.body.questionId] = req.body.answer;
    }

    req.body = {
      ...req.body,
      answers: normalizedAnswers,
    };

    return updateAttemptProgressHandler(req, res, next);
  }
);

// Section-timer heartbeats (PUT /progress) load and save their own ExamAttempt
// copy concurrently with a long-running submit request, so the in-memory
// `attempt` here can go stale by the time we reach the final save. Retry once
// against a freshly-loaded document instead of failing the whole submission.
const saveAttemptWithVersionRetry = async (attempt) => {
  try {
    await attempt.save();
    return attempt;
  } catch (error) {
    if (error?.name !== 'VersionError') {
      throw error;
    }
    const fresh = await ExamAttempt.findById(attempt._id);
    if (!fresh) {
      throw error;
    }
    const pendingChanges = attempt.toObject({ getters: false, virtuals: false, depopulate: true });
    delete pendingChanges._id;
    delete pendingChanges.__v;
    fresh.set(pendingChanges);
    await fresh.save();
    return fresh;
  }
};

export const submitAttemptHandler = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate(
        'examId',
        'title duration showResultsImmediately resultsReleasedAt accessControl markingRules evaluationMode productModule'
      )
      .populate('sessionId');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Defense in depth: a user who reaches the legacy generic exam player
    // with a WizKids session must still never trigger semantic/AI grading for
    // deterministic arithmetic. The WizKids completion service validates
    // tenant, ownership, mode, feature tree, and objective-only question set.
    if (attempt.examId?.productModule === 'WIZKIDS') {
      try {
        const completion = await completeWizKidsObjectiveAttempt({
          tenantId: attempt.tenantId || req.user?.tenantId,
          userId: req.user?._id,
          attemptId: attempt._id,
          expectedMode: ['TEST', 'WORKSHEET', 'COMPETITION', 'OLYMPIAD', 'PRACTICE', 'SPEED'],
          answers: req.body?.answers,
        });
        return res.json({
          success: true,
          alreadySubmitted: completion.alreadyCompleted,
          attempt: completion.attempt,
          attemptStatus: 'COMPLETED',
          submittedAt: completion.attempt?.submittedAt || completion.attempt?.submitTime || null,
          score: completion.score || completion.attempt?.scoreSummary || null,
          resultsAvailable: true,
          message: 'WizKids attempt submitted successfully',
        });
      } catch (error) {
        if (error instanceof WizKidsCompletionError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }
    }

    const examId = attempt.examId?._id || attempt.examId;
    const planContext = await resolveExamPlanContext(examId);
    const isFreePlanContext = planContext?.planType
      ? isFreePlan(planContext.planType)
      : false;
    const aiGradingProfile = resolveAiGradingProfile(planContext?.planType);
    const effectivePlanDefinition = getSubscriptionPlanDefinition(
      planContext?.planType || 'free'
    );
    const planAiTypesAllowedRaw =
      effectivePlanDefinition?.features?.aiTypesAllowed ??
      effectivePlanDefinition?.features?.ai_types_allowed;
    const planAiTypeList = Array.isArray(planAiTypesAllowedRaw)
      ? planAiTypesAllowedRaw
      : typeof planAiTypesAllowedRaw === 'string'
        ? planAiTypesAllowedRaw.split(/[,\n;|]/)
        : [];
    const planAiTypesAllowed = new Set(
      planAiTypeList
        .map((entry) => normalizeAiGradingTypeKey(entry))
        .filter(Boolean)
    );
    const aiTypeRestrictionEnabled =
      planAiTypesAllowedRaw !== undefined && planAiTypesAllowedRaw !== null;
    const subjectiveAutoGradingEnabled = planContext?.planType
      ? (
        !isFreePlanContext &&
        isPlanFeatureEnabled(planContext.planType, 'aiGrading') &&
        isPlanFeatureEnabled(planContext.planType, 'aiSubjectiveAutoGrading')
      )
      : true;
    const rubricScoringEnabled = planContext?.planType
      ? (
        !isFreePlanContext &&
        isPlanFeatureEnabled(planContext.planType, 'aiGrading') &&
        isPlanFeatureEnabled(planContext.planType, 'aiRubricScoring')
      )
      : false;
    const codingEnabled = planContext?.planType
      ? isPlanFeatureEnabled(planContext.planType, 'codingCompiler')
      : true;
    const aiUsageTenantId = attempt?.tenantId || req.user?.tenantId || null;
    let aiGradingUsageSnapshot = null;
    let aiGradingUsageLoaded = false;
    let aiGradingLimitReached = false;
    const loadAiGradingUsageSnapshot = async () => {
      if (!aiUsageTenantId) return null;
      if (aiGradingUsageLoaded) return aiGradingUsageSnapshot;
      aiGradingUsageLoaded = true;
      aiGradingUsageSnapshot = await getTenantAiGradingUsageSnapshot({
        tenantId: aiUsageTenantId,
      });
      return aiGradingUsageSnapshot;
    };

    // Verify ownership: users can only submit their own attempts (unless they have REVIEW_ANSWERS permission)
    const canReview = await hasExamPermission(
      req.user._id,
      examId,
      'REVIEW_ANSWERS'
    );
    if (!canReview && attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden - You can only submit your own attempts' });
    }

    if (!canReview && !attempt.isCompleted) {
      if (!(await canCandidateAccessSession(req.user._id, attempt.sessionId))) {
        return res.status(403).json({ error: 'You are not assigned to this session' });
      }
      const accessControlCheck = enforceExamAccessControl({
        exam: attempt.examId,
        req,
        planType: planContext?.planType || null,
      });
      if (!accessControlCheck.allowed) {
        return res.status(403).json({ error: accessControlCheck.error });
      }

      const ipLockCheck = await enforceAttemptIpLock({
        attempt,
        req,
        planType: planContext?.planType || null,
      });
      if (!ipLockCheck.allowed) {
        return res.status(403).json({ error: ipLockCheck.error });
      }
      const deviceLockCheck = await enforceAttemptDeviceLock({ attempt, req });
      if (!deviceLockCheck.allowed) {
        return res.status(409).json({ error: deviceLockCheck.error });
      }
      if (attempt.isDisqualified && !attempt.isCompleted) {
        return res.status(403).json({ error: 'Attempt is disqualified and cannot be submitted manually.' });
      }
    }

    const requestedDisqualifyStatus =
      typeof req.body?.disqualifyStatus === 'string'
        ? req.body.disqualifyStatus.trim().slice(0, 64)
        : '';
    const requestedViolationType =
      typeof req.body?.violationType === 'string'
        ? req.body.violationType.trim().slice(0, 64)
        : '';
    const requestedExamStatus =
      typeof req.body?.examStatus === 'string'
        ? req.body.examStatus.trim().slice(0, 24)
        : '';
    const shouldFinalizeStrictViolationSubmission =
      Boolean(attempt.isCompleted) &&
      attempt.submitMeta?.submissionSource === FOCUS_VIOLATION_SUBMISSION_SOURCE &&
      attempt.submitMeta?.finalizedAfterViolation !== true;

    if (attempt.isCompleted && !shouldFinalizeStrictViolationSubmission) {
      await attempt.populate('questionPaperId', 'setName');
      const canReviewAnswers = await hasExamPermission(
        req.user._id,
        examId,
        'REVIEW_ANSWERS'
      );
      // Disqualification is never a shortcut to see score/answers early —
      // visibility follows the exam's own release policy regardless of why
      // (or whether) the attempt was disqualified.
      const scoringVisible = canCandidateViewScore({
        exam: attempt.examId,
        isPrivileged: ADMIN_VIEWER_ROLES.has(req.user.role),
        canReviewAnswers,
      });
      const summary = {
        totalScore: Number(attempt.scoreSummary?.totalScore) || 0,
        maxScore: Number(attempt.scoreSummary?.maxScore) || 0,
        percentage: Number(attempt.scoreSummary?.percentage) || 0,
      };
      const integrity = buildAttemptIntegritySummary(attempt);
      const existingSubmissionSource = attempt.submitMeta?.submissionSource || null;
      const isOfflineSubmission =
        Boolean(attempt.offlineMode) ||
        isOfflineSubmissionSource(existingSubmissionSource || '');
      const attemptPayload = attempt.toObject();
      if (!scoringVisible) {
        attemptPayload.scoreSummary = null;
      }
      return res.json({
        success: true,
        alreadySubmitted: true,
        attempt: attemptPayload,
        attemptStatus: 'COMPLETED',
        submittedAt: attempt.submittedAt || attempt.submitTime || null,
        clientSubmissionId: attempt.submitMeta?.clientSubmissionId || null,
        submissionMode: isOfflineSubmission
          ? 'submitted_offline'
          : 'submitted_online',
        offlineSubmission: isOfflineSubmission,
        score: scoringVisible ? summary : null,
        violationCount: integrity.totalViolations,
        violationLogs: integrity.violationDetails,
        examStatus: integrity.examStatus,
        integrity,
        resultsAvailable: scoringVisible,
        idempotentRequest:
          typeof req.body?.clientSubmissionId === 'string' &&
          req.body.clientSubmissionId.trim().length > 0 &&
          attempt.submitMeta?.clientSubmissionId === req.body.clientSubmissionId.trim(),
        message: 'Exam submitted successfully',
      });
    }

    const { isDisqualified, disqualifyReason } = req.body;
    const submittedViolationPayload = Array.isArray(req.body?.violationLogs)
      ? req.body.violationLogs
      : Array.isArray(req.body?.violationEvents)
        ? req.body.violationEvents
        : [];
    const submittedViolationLogs = normalizeViolationLogsPayload(
      submittedViolationPayload,
      {
        attempt,
        defaultReason: disqualifyReason || '',
      }
    );
    const clientSubmissionId =
      typeof req.body?.clientSubmissionId === 'string'
        ? req.body.clientSubmissionId.trim().slice(0, 128)
        : '';
    const timerMeta =
      req.body?.timerMeta && typeof req.body.timerMeta === 'object'
        ? req.body.timerMeta
        : null;
    const codingSubmissionsMap = normalizeCodingSubmissionPayload(req.body);
    const submittedAnswers =
      req.body?.answers && typeof req.body.answers === 'object'
        ? { ...req.body.answers }
        : {};

    // If coding answers are only provided via codingSubmissions/codingAnswers, backfill answers.
    for (const [questionId, codingPayload] of codingSubmissionsMap.entries()) {
      if (Object.prototype.hasOwnProperty.call(submittedAnswers, questionId)) {
        continue;
      }

      submittedAnswers[questionId] = {
        language: codingPayload.language,
        code: codingPayload.code,
        input: codingPayload.input,
        lastSubmission: {
          score: codingPayload.score,
          passed: codingPayload.passed,
          failed: codingPayload.failed,
          total: codingPayload.total,
          output: codingPayload.output,
          plagiarism: codingPayload.plagiarism || {
            flagged: false,
            similarity: 0,
          },
        },
      };
    }

    const resolvedDisqualifyStatus =
      requestedDisqualifyStatus ||
      (normalizeStatusValue(requestedViolationType) === 'TAB_SWITCH'
        ? TAB_SWITCH_DISQUALIFY_STATUS
        : attempt.disqualifyStatus || '');

    // Sync section state before finalizing to avoid stale section timers.
    try {
      await getAttemptSectionProgress(attempt._id);
    } catch {
      // Continue submission even if section sync fails; submission lock still applies.
    }

    const assignedQuestionPaperId =
      attempt.questionPaperId?._id ||
      attempt.questionPaperId ||
      attempt.sessionId?.questionPaperId;

    if (!assignedQuestionPaperId) {
      return res.status(400).json({ error: 'No question paper assigned for this attempt.' });
    }

    // Get all questions for this session's question paper. Pool questions
    // (generated but never assigned to a section, isIncludedInExam: false)
    // must never reach the candidate paper or contribute to scoring.
    const questions = await Question.find({
      questionPaperId: assignedQuestionPaperId,
      isIncludedInExam: { $ne: false },
    }).sort({ order: 1 });

    if (
      isFreePlanContext &&
      questions.some((question) => WRITING_QUESTION_TYPES.has(String(question?.questionType || '').toUpperCase()))
    ) {
      return sendWritingPlanRestriction(res);
    }

    const existingAnswers = await Answer.find({ attemptId: attempt._id }).select(
      'questionId answerText isCorrect pointsEarned aiEvaluation codingResult submissionId'
    );
    const existingAnswerMap = new Map(
      existingAnswers.map((answerDoc) => [answerDoc.questionId.toString(), answerDoc])
    );

    const answerWriteOperations = [];
    const deferredCodingEvaluations = [];
    let totalScore = 0;
    let maxScore = 0;

    // Process each question
    for (const question of questions) {
      maxScore += question.points;
      const questionId = question._id.toString();
      const hasSubmittedAnswer = Object.prototype.hasOwnProperty.call(submittedAnswers, questionId);
      const existingAnswerDoc = existingAnswerMap.get(questionId);
      const rawAnswer = hasSubmittedAnswer
        ? submittedAnswers[questionId]
        : existingAnswerDoc?.answerText;
      const studentAnswer = rawAnswer === undefined || rawAnswer === null ? '' : rawAnswer;

      let normalizedAnswerText = normalizeAnswerForStorage(
        question.questionType,
        studentAnswer
      );

      let isCorrect = false;
      let pointsEarned = 0;
      let aiEvaluation = null;
      let codingResult = null;
      let submissionId = existingAnswerDoc?.submissionId;

      // Auto-grade objective questions
      if (
        ['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'IMAGE_BASED', 'MATCHING'].includes(
          question.questionType
        )
      ) {
        const normalizedOptions = sanitizeQuestionOptions(question.options);
        if (question.questionType === 'MULTIPLE_OPTIONS') {
          const multiSelectResult = computeMultiSelectScoring({
            question,
            studentAnswer,
            examMarkingRules: attempt.examId?.markingRules || {},
          });
          isCorrect = multiSelectResult.isCorrect;
          normalizedAnswerText = multiSelectResult.normalizedAnswerText;
          pointsEarned = multiSelectResult.pointsEarned;
        } else if (question.questionType === 'MATCHING') {
          const pairs = Array.isArray(question.matchingPairs) ? question.matchingPairs : [];
          const expected = pairs.reduce((result, pair) => {
            const left = normalizeString(pair?.left || pair?.term || pair?.prompt);
            const right = normalizeString(pair?.right || pair?.match || pair?.answer);
            if (left && right) result[left] = right;
            return result;
          }, {});
          const received = studentAnswer && typeof studentAnswer === 'object' ? studentAnswer : {};
          const expectedEntries = Object.entries(expected);
          const correctPairCount = expectedEntries.filter(
            ([left, right]) => normalizeString(received[left]).toLowerCase() === right.toLowerCase()
          ).length;
          isCorrect = expectedEntries.length > 0 && correctPairCount === expectedEntries.length;
          normalizedAnswerText = JSON.stringify(received);
          const matchingPartialEnabled =
            question.evaluationConfig?.partialMarking?.enabled === true ||
            question.evaluationConfig?.partialMarking?.matching === true;
          pointsEarned = isCorrect
            ? question.points
            : matchingPartialEnabled && expectedEntries.length
              ? Number(((Number(question.points) * correctPairCount) / expectedEntries.length).toFixed(2))
              : 0;
          aiEvaluation = {
            provider: 'deterministic',
            evaluationMethod: matchingPartialEnabled ? 'matching_partial' : 'matching_exact',
            correctConcepts: correctPairCount ? [`${correctPairCount} matching pair(s) correct.`] : [],
            missingConcepts: isCorrect ? [] : [`${expectedEntries.length - correctPairCount} matching pair(s) incorrect or missing.`],
            incorrectStatements: [],
            confidence: 1,
            needsReview: false,
          };
        } else {
          const expected = normalizeQuestionCorrectAnswer({
            questionType: question.questionType,
            correctAnswer: question.correctAnswer,
            options: normalizedOptions,
          });
          const received = normalizeQuestionCorrectAnswer({
            questionType: question.questionType,
            correctAnswer: studentAnswer,
            options: normalizedOptions,
          });
          normalizedAnswerText = String(received ?? '').trim();
          isCorrect = String(received).trim() === String(expected).trim();
          pointsEarned = isCorrect ? question.points : 0;
        }
      } else if (
        SEMANTIC_EVALUATION_QUESTION_TYPES.has(question.questionType)
      ) {
        const hasSubjectiveAnswer = String(studentAnswer).trim().length > 0;

        const existingSubjectiveEvaluation =
          existingAnswerDoc?.aiEvaluation &&
            String(existingAnswerDoc.aiEvaluation.provider || '').toLowerCase() === 'openai' &&
            Number.isFinite(Number(existingAnswerDoc?.pointsEarned))
            ? existingAnswerDoc.aiEvaluation
            : null;
        const hasSubjectiveAnswerChanged =
          normalizeString(existingAnswerDoc?.answerText) !== normalizeString(normalizedAnswerText);

        if (hasSubjectiveAnswer && existingSubjectiveEvaluation && !hasSubjectiveAnswerChanged) {
          // Answer is unchanged since it was last AI-graded (e.g. re-submission after a
          // heartbeat race, a retried request, or violation finalization) — reuse the
          // cached evaluation instead of re-billing the AI grading call.
          isCorrect = Boolean(existingAnswerDoc.isCorrect);
          pointsEarned = Number(existingAnswerDoc.pointsEarned) || 0;
          aiEvaluation = existingSubjectiveEvaluation;
        } else if (hasSubjectiveAnswer) {
          if (!subjectiveAutoGradingEnabled) {
            pointsEarned = 0;
            isCorrect = false;
            aiEvaluation = {
              needsReview: true,
              reason:
                isFreePlanContext || WRITING_QUESTION_TYPES.has(question.questionType)
                  ? FREE_PLAN_MESSAGES.WRITING_AI_LOCKED
                  : 'Subjective answers require manual evaluation in the current plan.',
            };
          } else {
            const aiTypeKey = resolveAiGradingTypeForQuestion(question.questionType);
            const aiTypeAllowed =
              !aiTypeRestrictionEnabled || (aiTypeKey && planAiTypesAllowed.has(aiTypeKey));

            if (!aiTypeAllowed) {
              pointsEarned = 0;
              isCorrect = false;
              aiEvaluation = {
                needsReview: true,
                reason:
                  'AI grading is not enabled for this answer type in your current plan settings.',
              };
            } else {
              const usageSnapshot = await loadAiGradingUsageSnapshot();
              const aiLimitReached =
                usageSnapshot &&
                usageSnapshot.unlimited !== true &&
                Number(usageSnapshot.remaining) <= 0;
              if (usageSnapshot && !usageSnapshot.allowed) {
                if (aiLimitReached) {
                  aiGradingLimitReached = true;
                }
                pointsEarned = 0;
                isCorrect = false;
                aiEvaluation = {
                  needsReview: true,
                  reason: usageSnapshot.message || AI_GRADING_LIMIT_EXCEEDED_MESSAGE,
                };
              } else {
                // AI evaluation for subjective questions (skip empty answers)
                try {
                  aiEvaluation = await evaluateAnswer({
                    question: question.questionText,
                    correctAnswer: question.correctAnswer,
                    studentAnswer,
                    questionType: question.questionType,
                    points: question.points,
                    evaluationConfig: {
                      ...(question.evaluationConfig && typeof question.evaluationConfig === 'object'
                        ? question.evaluationConfig
                        : {}),
                      rubric: rubricScoringEnabled
                        ? (Array.isArray(question.evaluationConfig?.rubric) ? question.evaluationConfig.rubric : [])
                        : [],
                      difficulty: question.difficulty,
                      supportingContext:
                        question.passage ||
                        question.instructions ||
                        question.evaluationConfig?.supportingContext ||
                        '',
                    },
                    tenantId: attempt?.tenantId || req.user?.tenantId || null,
                    userId: req.user?._id || null,
                    metadata: {
                      tenantId: attempt?.tenantId || req.user?.tenantId || null,
                      userId: req.user?._id || null,
                    },
                    gradingProfile: aiGradingProfile,
                    rubricScoringEnabled,
                    rubric: rubricScoringEnabled
                      ? (
                        question.questionType === 'SHORT_ANSWER'
                          ? [
                            { criterion: 'Accuracy', weight: 50, description: 'Correctness of the core answer.' },
                            { criterion: 'Key Points', weight: 30, description: 'Coverage of expected key points.' },
                            { criterion: 'Clarity', weight: 20, description: 'Clarity and directness of response.' },
                          ]
                          : WRITING_QUESTION_TYPES.has(question.questionType)
                            ? [
                              {
                                criterion: 'Structure',
                                weight: 25,
                                description:
                                  question.questionType === 'ESSAY_LETTER'
                                    ? 'Letter format/organization and proper sections.'
                                    : 'Clear opening, development, and closure.',
                              },
                              {
                                criterion: 'Content Depth',
                                weight: 30,
                                description:
                                  question.questionType === 'ESSAY_STORY'
                                    ? 'Depth of narrative detail and originality.'
                                    : 'Coverage and development of relevant ideas.',
                              },
                              {
                                criterion: 'Coherence',
                                weight: 25,
                                description:
                                  question.questionType === 'ESSAY_STORY'
                                    ? 'Narrative flow, continuity, and readability.'
                                    : 'Logical flow, connected arguments, and clarity.',
                              },
                              {
                                criterion: 'Language Quality',
                                weight: 20,
                                description:
                                  question.questionType === 'ESSAY_LETTER'
                                    ? 'Appropriate tone, grammar, and readability for letter writing.'
                                    : 'Grammar, readability, and expression quality.',
                              },
                            ]
                            : [
                            { criterion: 'Accuracy', weight: 40, description: 'Conceptual correctness and factual accuracy.' },
                            { criterion: 'Completeness', weight: 30, description: 'Coverage of required concepts and details.' },
                            { criterion: 'Reasoning', weight: 20, description: 'Logical explanation and supporting reasoning.' },
                            { criterion: 'Clarity', weight: 10, description: 'Structure, language quality, and readability.' },
                            ]
                      )
                      : [],
                  });

                  if (
                    aiUsageTenantId &&
                    String(aiEvaluation?.provider || '').toLowerCase() === 'openai'
                  ) {
                    const usageIncrement = await incrementTenantAiGradingUsage({
                      tenantId: aiUsageTenantId,
                    });
                    if (usageIncrement?.usage) {
                      aiGradingUsageSnapshot = usageIncrement.usage;
                      aiGradingUsageLoaded = true;
                      if (
                        usageIncrement.usage.unlimited !== true &&
                        Number(usageIncrement.usage.remaining) <= 0
                      ) {
                        aiGradingLimitReached = true;
                      }
                    }
                  }

                  isCorrect = aiEvaluation.isCorrect;
                  pointsEarned = aiEvaluation.pointsEarned;
                } catch (error) {
                  console.error('AI evaluation error:', error);
                  // Fallback: no points if AI fails
                  pointsEarned = 0;
                  aiEvaluation = {
                    error: 'Evaluation failed',
                    needsReview: true,
                  };
                }
              }
            }
          }
        }
      } else if (question.questionType === 'CODING') {
        if (!codingEnabled) {
          pointsEarned = 0;
          isCorrect = false;
          aiEvaluation = {
            needsReview: true,
            reason: FREE_PLAN_MESSAGES.CODING_LOCKED,
          };
          codingResult = null;
        } else {
        const parsedAnswerPayload = parseCodingAnswerPayload(studentAnswer);
        const codingDraft = resolveCodingAnswerDraft(studentAnswer, question);
        const codingPayload = codingSubmissionsMap.get(questionId);

        const language =
          normalizeCodingLanguage(codingPayload?.language) ||
          normalizeCodingLanguage(codingDraft.language) ||
          codingDraft.language;
        const code = normalizeString(codingPayload?.code) || normalizeString(codingDraft.code);
        const input = normalizeString(codingPayload?.input) || normalizeString(codingDraft.input);

        normalizedAnswerText = normalizeCodingAnswerForStorage({
          ...parsedAnswerPayload,
          language,
          code,
          input,
          drafts:
            parsedAnswerPayload?.drafts &&
              typeof parsedAnswerPayload.drafts === 'object' &&
              !Array.isArray(parsedAnswerPayload.drafts)
              ? parsedAnswerPayload.drafts
              : codingDraft.drafts,
          lastSubmission:
            codingPayload && (code || codingPayload.total > 0 || codingPayload.score > 0)
              ? {
                score: codingPayload.score,
                passed: codingPayload.passed,
                failed: codingPayload.failed,
                total: codingPayload.total,
                output: codingPayload.output,
                plagiarism: codingPayload.plagiarism || {
                  flagged: false,
                  similarity: 0,
                },
              }
              : parsedAnswerPayload?.lastSubmission,
        });

        const existingCodingEvaluation =
          existingAnswerDoc?.aiEvaluation?.type === 'CODING' &&
            Number.isFinite(Number(existingAnswerDoc?.pointsEarned))
            ? existingAnswerDoc.aiEvaluation
            : null;
        const existingCodingDraft = existingAnswerDoc
          ? resolveCodingAnswerDraft(existingAnswerDoc.answerText, question)
          : null;
        const hasCodeChanges =
          Boolean(existingCodingDraft) &&
          (
            normalizeString(existingCodingDraft.code) !== code ||
            normalizeString(existingCodingDraft.input) !== input ||
            normalizeCodingLanguage(existingCodingDraft.language) !== normalizeCodingLanguage(language)
          );

        if (existingCodingEvaluation && !hasCodeChanges) {
          isCorrect = Boolean(existingAnswerDoc.isCorrect);
          pointsEarned = Number(existingAnswerDoc.pointsEarned) || 0;
          aiEvaluation = existingCodingEvaluation;
          codingResult = existingAnswerDoc.codingResult || null;
        } else {
          const provisionalScoreRaw = Number(
            codingPayload?.score ?? existingCodingEvaluation?.score
          );
          const provisionalScore = Number.isFinite(provisionalScoreRaw)
            ? Math.min(Math.max(Math.round(provisionalScoreRaw), 0), 100)
            : 0;
          const total = toNonNegativeInt(
            codingPayload?.total ?? existingCodingEvaluation?.total,
            0
          );
          const passed = toNonNegativeInt(
            codingPayload?.passed ?? existingCodingEvaluation?.passed,
            0
          );
          const failed =
            total > 0
              ? Math.max(total - passed, 0)
              : toNonNegativeInt(
                codingPayload?.failed ?? existingCodingEvaluation?.failed,
                0
              );

          pointsEarned = Number(
            (((Number(question.points) || 0) * provisionalScore) / 100).toFixed(2)
          );
          isCorrect = total > 0 ? failed === 0 : false;
          aiEvaluation = {
            type: 'CODING',
            score: provisionalScore,
            passed,
            failed,
            output: codingPayload?.output || '',
            pendingEvaluation: Boolean(code),
            source: existingCodingEvaluation ? 'STALE_REEVALUATION' : 'CLIENT_PAYLOAD',
            plagiarism: codingPayload?.plagiarism || existingCodingEvaluation?.plagiarism || {
              flagged: false,
              similarity: 0,
            },
          };
          codingResult = {
            total,
            passed,
            failed,
            score: provisionalScore,
            output: codingPayload?.output || '',
          };
        }

        if (code && (!existingCodingEvaluation || hasCodeChanges)) {
          deferredCodingEvaluations.push({
            question,
            language,
            code,
            input,
          });
        }
        }
      }

      totalScore += pointsEarned;

      answerWriteOperations.push({
        updateOne: {
          filter: {
            attemptId: attempt._id,
            questionId: question._id,
          },
          update: {
            $set: {
              answerText: normalizedAnswerText,
              isCorrect,
              pointsEarned,
              aiEvaluation,
              codingResult,
              submissionId: aiEvaluation?.submissionId || submissionId || undefined,
              needsReview: aiEvaluation?.needsReview || false,
            },
            $setOnInsert: {
              attemptId: attempt._id,
              questionId: question._id,
            },
          },
          upsert: true,
        },
      });
    }

    if (answerWriteOperations.length > 0) {
      await Answer.bulkWrite(answerWriteOperations, { ordered: false });
    }

    try {
      await classifySubmissionEvaluations(attempt._id, attempt.examId);
    } catch (classifyError) {
      // Never block submission on this bookkeeping step; evaluationMode
      // defaults to AUTOMATIC anyway, so this only affects opted-in exams.
      console.error('[EVALUATION] Failed to classify submission evaluations:', classifyError?.message || classifyError);
    }

    try {
      // No-op for every exam that hasn't opted into evaluatorDistributionStrategy
      // (i.e. every exam that existed before this feature). autoDistributeOnAttemptCompletion
      // never throws — it swallows and logs its own errors.
      await autoDistributeOnAttemptCompletion({
        attemptId: attempt._id,
        examId: attempt.examId?._id || attempt.examId,
      });
    } catch (distributionError) {
      console.error('[RESPONSE_DISTRIBUTION] Unexpected error invoking auto-distribution:', distributionError?.message || distributionError);
    }

    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
    const existingSubmitMeta =
      attempt.submitMeta && typeof attempt.submitMeta.toObject === 'function'
        ? attempt.submitMeta.toObject()
        : { ...(attempt.submitMeta || {}) };
    const submitTime = shouldFinalizeStrictViolationSubmission
      ? new Date(attempt.submitTime || attempt.submittedAt || new Date())
      : new Date();

    // Update attempt
    attempt.isCompleted = true;
    attempt.submitTime = submitTime;
    attempt.submittedAt = attempt.submittedAt || submitTime;
    attempt.isDisqualified = Boolean(attempt.isDisqualified || isDisqualified);
    attempt.disqualifyReason = disqualifyReason || attempt.disqualifyReason || '';
    attempt.disqualifyStatus = resolvedDisqualifyStatus || attempt.disqualifyStatus || '';
    attempt.lastActivity = submitTime;
    attempt.scoreSummary = {
      totalScore,
      maxScore,
      percentage,
      computedAt: new Date(),
    };

    lockAllSectionTimersOnSubmit(attempt, submitTime);

    const submittedAtClient =
      typeof timerMeta?.submittedAtClient === 'string'
        ? new Date(timerMeta.submittedAtClient)
        : null;
    const submissionSource = shouldFinalizeStrictViolationSubmission
      ? existingSubmitMeta?.submissionSource || FOCUS_VIOLATION_SUBMISSION_SOURCE
      : typeof req.body?.submissionSource === 'string'
        ? req.body.submissionSource.slice(0, 64)
        : null;
    const isOfflineSubmission =
      Boolean(req.body?.offlineMode) || isOfflineSubmissionSource(submissionSource || '');
    attempt.submitMeta = {
      submissionSource,
      violationType:
        requestedViolationType ||
        existingSubmitMeta?.violationType ||
        null,
      submittedAtClient:
        submittedAtClient && !Number.isNaN(submittedAtClient.getTime())
          ? submittedAtClient
          : existingSubmitMeta?.submittedAtClient || null,
      totalRemainingSeconds:
        timerMeta?.totalRemainingSeconds !== undefined
          ? toNonNegativeInt(timerMeta.totalRemainingSeconds, 0)
          : existingSubmitMeta?.totalRemainingSeconds ?? null,
      currentSectionId:
        typeof timerMeta?.currentSectionId === 'string' &&
          /^[a-fA-F0-9]{24}$/.test(timerMeta.currentSectionId)
          ? timerMeta.currentSectionId
          : existingSubmitMeta?.currentSectionId || null,
      clientSubmissionId:
        clientSubmissionId || existingSubmitMeta?.clientSubmissionId || null,
      finalizedAfterViolation:
        shouldFinalizeStrictViolationSubmission
          ? true
          : Boolean(existingSubmitMeta?.finalizedAfterViolation),
    };

    if (isOfflineSubmission) {
      attempt.offlineMode = true;
      attempt.offlineSubmitTime = submitTime;
    }

    if (attempt.isDisqualified && requestedViolationType) {
      appendAttemptViolationLog(attempt, requestedViolationType, {
        reason: attempt.disqualifyReason || null,
        disqualifyStatus: attempt.disqualifyStatus || null,
        submissionSource: attempt.submitMeta?.submissionSource || null,
      });
      const disqualifyViolationLog = normalizeViolationLogsPayload(
        [
          {
            violationType: requestedViolationType,
            details: attempt.disqualifyReason || disqualifyReason || '',
            timestamp: new Date(),
          },
        ],
        { attempt },
      );
      submittedViolationLogs.push(...disqualifyViolationLog);
    }

    const mergedViolationLogs = mergeViolationLogs(
      Array.isArray(attempt.violationLogs) ? attempt.violationLogs : [],
      submittedViolationLogs,
    );
    const resolvedViolationCount = toNonNegativeInt(
      req.body?.violationCount,
      mergedViolationLogs.length,
    );
    const finalViolationCount = Math.max(
      resolvedViolationCount,
      mergedViolationLogs.length,
    );
    const resolvedExamStatus = resolveExamStatusFromViolationCount(
      finalViolationCount,
      requestedExamStatus,
    );

    attempt.violationLogs = mergedViolationLogs;
    attempt.violationCount = finalViolationCount;
    attempt.examStatus = resolvedExamStatus;
    attempt.violationEvents = mergedViolationLogs.map((entry) => ({
      type: toLegacyViolationEventType(entry?.violationType || entry?.type),
      timestamp: new Date(entry?.timestamp || Date.now()),
      details: (entry?.details || '').toString().slice(0, 500),
    }));
    attempt.proctoringViolations = mergeViolationLogs(
      Array.isArray(attempt.proctoringViolations)
        ? attempt.proctoringViolations
        : [],
      submittedViolationLogs,
    );

    attempt = await saveAttemptWithVersionRetry(attempt);

    try {
      const { createRoleNotification, createUserNotification } = await import('../services/notificationService.js');
      const tenantId = attempt.tenantId || null;
      const examTitle = attempt.examId?.title || attempt.examSnapshot?.title || 'Exam';
      const candidateName = req.user.name || req.user.email || 'Candidate';

      await createUserNotification({
        title: 'Exam Submitted',
        message: `You submitted "${examTitle}".`,
        type: 'exam_submitted',
        roles: ['CANDIDATE'],
        userId: attempt.userId,
        tenantId,
        examId: examId,
        attemptId: attempt._id,
        createdBy: req.user._id,
        metadata: { examId, examTitle },
      });

      if (tenantId) {
        await createRoleNotification({
          title: 'Exam Submitted',
          message: `${candidateName} submitted "${examTitle}".`,
          type: 'attempt_submitted',
          roles: ['TENANT_ADMIN', 'EXAM_CREATOR'],
          tenantId,
          examId: examId,
          attemptId: attempt._id,
          createdBy: req.user._id,
          metadata: { examId, examTitle, candidateName },
        });
      }
    } catch (notifyError) {
      console.error('[NOTIFICATIONS] Failed to log exam submission:', notifyError?.message || notifyError);
    }

    await attempt.populate('examId', 'title duration showResultsImmediately resultsReleasedAt');
    await attempt.populate('questionPaperId', 'setName');
    const canReviewAnswers = await hasExamPermission(
      req.user._id,
      examId,
      'REVIEW_ANSWERS'
    );
    // Disqualification is never a shortcut to see score/answers early — see
    // resultVisibility.js.
    const scoringVisible = canCandidateViewScore({
      exam: attempt.examId,
      isPrivileged: ADMIN_VIEWER_ROLES.has(req.user.role),
      canReviewAnswers,
    });
    const savedAnswers = scoringVisible ? await Answer.find({ attemptId: attempt._id }) : [];
    const responseScore = scoringVisible
      ? {
        totalScore,
        maxScore,
        percentage,
      }
      : null;
    const integrity = buildAttemptIntegritySummary(attempt);
    const hasDeferredCodingEvaluation = deferredCodingEvaluations.length > 0;
    const aiUsagePayload = aiGradingUsageSnapshot
      ? toAiUsageResponsePayload(aiGradingUsageSnapshot)
      : null;

    console.log(
      `[ATTEMPT_SUBMIT] attempt=${attempt._id} source=${submissionSource || 'unknown'} mode=${isOfflineSubmission ? 'offline' : 'online'} user=${req.user?._id || 'unknown'}`
    );

    const attemptPayload = attempt.toObject();
    if (!scoringVisible) {
      attemptPayload.scoreSummary = null;
    }

    res.json({
      success: true,
      attempt: attemptPayload,
      attemptStatus: 'COMPLETED',
      submittedAt: submitTime.toISOString(),
      clientSubmissionId: attempt.submitMeta?.clientSubmissionId || null,
      submissionMode: isOfflineSubmission ? 'submitted_offline' : 'submitted_online',
      offlineSubmission: isOfflineSubmission,
      score: responseScore,
      violationCount: integrity.totalViolations,
      violationLogs: integrity.violationDetails,
      examStatus: integrity.examStatus,
      integrity,
      answers: savedAnswers,
      resultsAvailable: scoringVisible,
      message: 'Exam submitted successfully',
      detailMessage: scoringVisible
        ? 'Attempt submitted successfully.'
        : 'Attempt submitted successfully. Results are not yet released for candidates.',
      codingEvaluationPending: hasDeferredCodingEvaluation,
      ai_usage: aiUsagePayload,
      ai_usage_message: aiGradingLimitReached
        ? AI_GRADING_LIMIT_EXCEEDED_MESSAGE
        : null,
    });

    // Evaluate coding questions in the background to avoid blocking final exam submission.
    if (hasDeferredCodingEvaluation) {
      scheduleDeferredCodingEvaluation({
        pendingEvaluations: deferredCodingEvaluations,
        attemptId: attempt._id,
        userId: req.user._id,
        examId,
        attemptStartedAt: attempt.startTime,
        planType: planContext?.planType || null,
      });
    }
  } catch (error) {
    console.error('Exam submission error:', error);
    next(error);
  }
};

// Submit attempt
router.post(
  '/:attemptId/submit',
  requireAuth,
  validateObjectId('attemptId'),
  auditLog(AUDIT_ACTIONS.ATTEMPT_SUBMITTED, (req) => ({
    attemptId: req.params.attemptId,
    isDisqualified: req.body.isDisqualified || false,
  })),
  [
    body('answers').optional().isObject().withMessage('Answers must be an object'),
    body('codingSubmissions').optional().isArray().withMessage('codingSubmissions must be an array'),
    body('codingAnswers').optional().isArray().withMessage('codingAnswers must be an array'),
    body('timerMeta').optional().isObject().withMessage('timerMeta must be an object'),
    body('clientSubmissionId')
      .optional()
      .isString()
      .isLength({ max: 128 })
      .withMessage('clientSubmissionId must be a string up to 128 characters'),
    body('submissionSource').optional().isString().withMessage('submissionSource must be a string'),
    body('disqualifyStatus').optional().isString().withMessage('disqualifyStatus must be a string'),
    body('violationType').optional().isString().withMessage('violationType must be a string'),
    body('violationCount')
      .optional()
      .isInt({ min: 0 })
      .withMessage('violationCount must be a non-negative integer'),
    body('violationLogs')
      .optional()
      .isArray()
      .withMessage('violationLogs must be an array'),
    body('examStatus')
      .optional()
      .isIn(['FAIR', 'SUSPICIOUS', 'CHEATING'])
      .withMessage('examStatus must be FAIR, SUSPICIOUS, or CHEATING'),
  ],
  submitAttemptHandler
);

// Get attempt results
router.get('/:attemptId/results', requireAuth, validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate(
        'examId',
        'title duration showResultsImmediately resultsReleasedAt certificatesSentAt allowCertification passingPercentage'
      )
      .populate('sessionId', 'startTime endTime')
      .populate('questionPaperId', '_id')
      .populate('userId', 'name email');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Verify ownership and review privilege.
    const canReviewAnswers = await hasExamPermission(req.user._id, attempt.examId._id, 'REVIEW_ANSWERS');
    const isOwnAttempt = attempt.userId._id.toString() === req.user._id.toString();

    const canViewAnyAttempt = canBypassReleaseWindow({
      userRole: req.user.role,
      canReviewAnswers,
    });

    if (!isOwnAttempt && !canViewAnyAttempt) {
      return res.status(403).json({ error: 'Forbidden - You can only view your own results' });
    }

    const questionPaperId = attempt.questionPaperId?._id || attempt.questionPaperId;
    const totalQuestions = questionPaperId
      ? await Question.countDocuments({ questionPaperId, isIncludedInExam: { $ne: false } })
      : 0;
    const attemptedQuestions = await countAttemptedQuestionsForAttempt(attempt._id);
    const integrity = buildAttemptIntegritySummary(attempt);

    // For candidate-owned attempts, score/answers follow the exam's release
    // policy regardless of disqualification reason (or lack thereof). A
    // disqualified candidate may still see their disqualification status —
    // just not the score, answers, or correct answers — before release.
    const scoringVisible = canViewAnyAttempt || (isOwnAttempt && isExamResultsReleased(attempt.examId));

    if (isOwnAttempt && !canViewAnyAttempt && attempt.examId && !scoringVisible) {
      if (attempt.isDisqualified) {
        return res.json({
          attempt: buildAttemptStatusOnlyPayload(attempt),
          resultsAvailable: false,
          attemptedQuestions,
          totalQuestions,
          progressPercentage:
            totalQuestions > 0 ? Math.round((attemptedQuestions / totalQuestions) * 100) : 0,
          message: 'Your results will be available once released by the exam administrator.',
        });
      }
      return res.status(403).json({ error: 'Results are not yet available for this exam.' });
    }

    const { summary, answers } = await ensureScoreSummary(attempt, {
      includeAnswers: true,
      includeQuestionDetails: true,
    });

    res.json({
      attempt,
      answers,
      score: summary,
      attemptedQuestions,
      totalQuestions,
      progressPercentage:
        totalQuestions > 0
          ? Math.round((attemptedQuestions / totalQuestions) * 100)
          : 0,
      violationCount: integrity.totalViolations,
      violationLogs: integrity.violationDetails,
      examStatus: integrity.examStatus,
      integrity,
    });
  } catch (error) {
    next(error);
  }
});

// Update attempt (for proctoring violations)
router.patch('/:attemptId', requireAuth, validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findById(req.params.attemptId);

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Verify ownership
    if (attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { tabSwitchCount, isDisqualified, disqualifyReason, lastActivity } = req.body;

    if (tabSwitchCount !== undefined) attempt.tabSwitchCount = tabSwitchCount;
    if (isDisqualified !== undefined) attempt.isDisqualified = isDisqualified;
    if (disqualifyReason !== undefined) attempt.disqualifyReason = disqualifyReason;
    if (lastActivity !== undefined) attempt.lastActivity = new Date(lastActivity);

    await attempt.save();

    res.json({ attempt });
  } catch (error) {
    next(error);
  }
});

// Certificate info
router.get('/:attemptId/certificate', requireAuth, validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findById(req.params.attemptId)
      .populate('examId', 'title resultsReleasedAt showResultsImmediately certificatesSentAt certificateTemplate allowCertification passingPercentage')
      .populate('userId', 'name')
      .populate('questionPaperId', '_id');

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Users can only see their own certificates unless they are reviewers/admins.
    const canReviewAnswers = await hasExamPermission(req.user._id, attempt.examId._id, 'REVIEW_ANSWERS');
    const isOwnAttempt = attempt.userId._id.toString() === req.user._id.toString();

    const canViewAnyAttempt = canBypassReleaseWindow({
      userRole: req.user.role,
      canReviewAnswers,
    });

    if (!isOwnAttempt && !canViewAnyAttempt) {
      return res.status(403).json({ error: 'Forbidden - You can only view your own certificates' });
    }

    if (!attempt.examId?.allowCertification) {
      return res.status(403).json({ error: 'Certification is disabled for this exam.' });
    }

    // Block certificate until results are released OR certificates are sent (for own attempts)
    // Allow viewing if:
    // 1. Results are shown immediately, OR
    // 2. Results have been released, OR
    // 3. Certificates have been sent separately
    if (
      isOwnAttempt &&
      !canViewAnyAttempt &&
      attempt.examId &&
      !isExamResultsReleased(attempt.examId) &&
      !isCertificatesReleased(attempt.examId)
    ) {
      return res.status(403).json({ error: 'Results are not yet available for this exam.' });
    }

    if (!attempt.isCompleted) {
      return res.status(400).json({ error: 'Certificate is available only after the attempt is submitted.' });
    }

    if (attempt.isDisqualified) {
      return res.status(403).json({ error: 'Disqualified attempts are not eligible for certificates.' });
    }

    const { summary } = await ensureScoreSummary(attempt);

    // Use exam-specific passing percentage if available, otherwise use default
    const minPercentage = attempt.examId?.passingPercentage !== undefined
      ? attempt.examId.passingPercentage
      : MIN_CERTIFICATION_PERCENTAGE;

    if ((summary?.percentage ?? 0) < minPercentage) {
      return res.status(403).json({
        error: `Certificate is issued only for scores ${minPercentage}% or above.`,
        minPercentage,
        achievedPercentage: summary?.percentage ?? 0,
      });
    }

    // Use exam-specific template if available, otherwise fall back to global template
    const examTemplate = attempt.examId?.certificateTemplate || null;
    const template = await loadCertificateTemplate(examTemplate);
    const examTitle =
      attempt.examId?.title || attempt.examSnapshot?.title || 'Exam';
    const attemptDate = attempt.submitTime
      ? new Date(attempt.submitTime)
      : null;
    const issuedTimestamp = attemptDate ? attemptDate : new Date();
    const context = {
      studentName: attempt.userId?.name || req.user.name || 'Candidate', // Universal: Changed from 'Student' to 'Candidate'
      examTitle,
      attemptDate: attemptDate ? attemptDate.toLocaleDateString() : '',
      issuedOn: issuedTimestamp.toLocaleDateString(),
      percentage: summary?.percentage ?? 0,
      score: summary?.totalScore ?? 0,
      maxScore: summary?.maxScore ?? 0,
      attemptId: attempt._id.toString(),
    };

    const renderedTemplate = applyCertificateTemplate(template, context);

    const responsePayload = {
      attempt: {
        _id: attempt._id,
        submitTime: attempt.submitTime,
        examSnapshot: attempt.examSnapshot,
        isCompleted: attempt.isCompleted,
        questionPaper: attempt.questionPaperId
          ? {
            _id: attempt.questionPaperId._id,
          }
          : null,
        examId: attempt.examId
          ? {
            _id: attempt.examId._id,
            title: attempt.examId.title,
            showResultsImmediately: attempt.examId.showResultsImmediately,
            resultsReleasedAt: attempt.examId.resultsReleasedAt,
            certificatesSentAt: attempt.examId.certificatesSentAt,
          }
          : null,
      },
      user: {
        name: attempt.userId?.name || req.user.name,
      },
      score: summary,
      eligibility: {
        eligible: true,
        minPercentage: MIN_CERTIFICATION_PERCENTAGE,
      },
      template,
      rendered: renderedTemplate,
      placeholders: { ...context },
    };

    // Hide set details for candidates (already removed), but keep for evaluators/creators if needed
    // Only show if user has REVIEW_ANSWERS permission
    const canReview = await hasExamPermission(req.user._id, attempt.examId._id, 'REVIEW_ANSWERS');
    if (canReview && attempt.questionPaperId) {
      responsePayload.attempt.questionPaper = {
        _id: attempt.questionPaperId._id,
        setName: attempt.questionPaperId.setName,
      };
    }

    res.json(responsePayload);
  } catch (error) {
    next(error);
  }
});

// Allow re-attempt for a candidate (admin only)
router.post(
  '/:attemptId/allow-reattempt',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  [
    body('reason').trim().notEmpty().withMessage('Reason is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      const beforeState = {
        reAttemptAllowed: attempt.reAttemptAllowed,
      };

      attempt.reAttemptAllowed = true;
      attempt.reAttemptReason = req.body.reason;
      attempt.reAttemptAllowedBy = req.user._id;
      attempt.reAttemptAllowedAt = new Date();

      await attempt.save();

      // Log audit
      const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
      await logAuditEvent(AUDIT_ACTIONS.ATTEMPT_RE_ENABLED || 'ATTEMPT_RE_ENABLED', {
        userId: req.user._id,
        userEmail: req.user.email,
        userName: req.user.name,
        userRole: req.user.role,
        tenantId: attempt.tenantId || null,
        resourceType: 'ExamAttempt',
        resourceId: attempt._id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        method: req.method,
        path: req.path,
        details: {
          before: beforeState,
          after: { reAttemptAllowed: true },
          reason: req.body.reason,
        },
      });

      res.json({ attempt, message: 'Re-attempt allowed successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Flag attempt (admin investigation tool)
router.post(
  '/:attemptId/flag',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  [
    body('status').isIn(['VALID', 'SUSPICIOUS', 'INVALID']).withMessage('Status must be VALID, SUSPICIOUS, or INVALID'),
    body('reason').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      const beforeStatus = attempt.adminFlags?.status || null;

      attempt.adminFlags = {
        status: req.body.status,
        flaggedBy: req.user._id,
        flaggedAt: new Date(),
        reason: req.body.reason || null,
      };

      await attempt.save();

      // Log audit
      const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
      await logAuditEvent(AUDIT_ACTIONS.ATTEMPT_FLAGGED || 'ATTEMPT_FLAGGED', {
        userId: req.user._id,
        userEmail: req.user.email,
        userName: req.user.name,
        userRole: req.user.role,
        tenantId: attempt.tenantId || null,
        resourceType: 'ExamAttempt',
        resourceId: attempt._id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        method: req.method,
        path: req.path,
        details: {
          before: beforeStatus,
          after: req.body.status,
          reason: req.body.reason,
        },
      });

      res.json({ attempt, message: 'Attempt flagged successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Add admin note to attempt
router.post(
  '/:attemptId/notes',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  [
    body('note').trim().notEmpty().withMessage('Note is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      if (!attempt.adminNotes) {
        attempt.adminNotes = [];
      }

      attempt.adminNotes.push({
        note: req.body.note,
        addedBy: req.user._id,
        addedAt: new Date(),
      });

      await attempt.save();

      // Log audit
      const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
      await logAuditEvent(AUDIT_ACTIONS.ATTEMPT_NOTE_ADDED || 'ATTEMPT_NOTE_ADDED', {
        userId: req.user._id,
        userEmail: req.user.email,
        userName: req.user.name,
        userRole: req.user.role,
        tenantId: attempt.tenantId || null,
        resourceType: 'ExamAttempt',
        resourceId: attempt._id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        method: req.method,
        path: req.path,
        details: {
          noteLength: req.body.note.length,
        },
      });

      res.json({ attempt, message: 'Note added successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Fetch an attempt + its answers for examiner review. Requires an active
// ExaminerAssignment covering this attempt (privileged roles bypass, same as
// the grading routes below). Student identity is omitted unless the
// assignment grants canViewStudentIdentity.
router.get(
  '/:attemptId/for-review',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      const attempt = await ExamAttempt.findById(req.params.attemptId)
        .populate('examId', 'title duration evaluationMode')
        .populate('userId', 'name email');
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
      if (!attempt.isCompleted) return res.status(400).json({ error: 'This attempt has not been submitted yet' });

      const isPrivilegedRole = ['EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
      // An active ExaminerAssignment alone is not sufficient authorization —
      // the caller must also hold the EVALUATOR role. Assignments can only
      // be created for users with evaluatorAccess.enabled today, but the
      // role check is the actual authorization boundary going forward.
      if (!isPrivilegedRole && !hasRole(req.user, 'EVALUATOR')) {
        return res.status(403).json({ error: 'Evaluator role required to review this attempt.' });
      }
      const allAnswers = await Answer.find({ attemptId: attempt._id })
        .populate({
          path: 'questionId',
          select: 'questionText questionType options correctAnswer points sectionId order evaluationConfig',
          populate: { path: 'sectionId', select: 'name order' },
        });
      // Answer.questionId.order is only known after population, so sort
      // in-memory rather than at the query level (for a stable answer-book
      // question order in the review UI).
      allAnswers.sort((a, b) => (Number(a.questionId?.order) || 0) - (Number(b.questionId?.order) || 0));

      let examinerAssignment = null;
      let answers = allAnswers;
      let matchingAssignments = [];

      if (!isPrivilegedRole) {
        // A section/question assignment grants visibility only to the matching
        // answers, never the entire attempt. This prevents a scoped evaluator
        // from learning unrelated candidate responses through the review API.
        const scopedAnswers = await Promise.all(
          allAnswers.map(async (answer) => {
            const assignment = await hasActiveExaminerAssignment(
              req.user._id,
              attempt.examId?._id || attempt.examId,
              {
                attemptId: attempt._id,
                questionId: answer.questionId?._id || answer.questionId,
                sectionId: answer.questionId?.sectionId,
              }
            );
            return assignment ? { answer, assignment } : null;
          })
        );

        const permitted = scopedAnswers.filter(Boolean);
        if (!permitted.length) {
          return res.status(403).json({ error: 'You do not have an active examiner assignment covering this evaluation scope.' });
        }

        answers = permitted.map(({ answer }) => answer);
        matchingAssignments = permitted.map(({ assignment }) => assignment);
        examinerAssignment = matchingAssignments[0];
      }

      const canViewStudentIdentity =
        isPrivilegedRole || matchingAssignments.every((assignment) => assignment.canViewStudentIdentity);

      res.json({
        attempt: {
          _id: attempt._id,
          examId: attempt.examId,
          submitTime: attempt.submitTime,
          scoreSummary: attempt.scoreSummary,
          candidate: canViewStudentIdentity ? attempt.userId : null,
        },
        answers,
        assignment: examinerAssignment
          ? {
            canApproveAiScore: examinerAssignment.canApproveAiScore,
            canOverrideScore: examinerAssignment.canOverrideScore,
            canAddFeedback: examinerAssignment.canAddFeedback,
            requiresOverrideReason: examinerAssignment.requiresOverrideReason,
          }
          : null,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Manually grade an answer. Allowed for EXAM_CREATOR/TENANT_ADMIN/SUPER_ADMIN
// (as before), OR for an examiner holding an active ExaminerAssignment that
// covers this attempt and permits score overrides.
router.put(
  '/:attemptId/answers/:answerId/manual-grade',
  requireAuth,
  validateObjectId('attemptId'),
  validateObjectId('answerId'),
  [
    body('pointsEarned').isFloat({ min: 0 }).withMessage('pointsEarned must be a non-negative number'),
    body('feedback').optional({ nullable: true }).isString().isLength({ max: 4000 }),
    body('overrideReason').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const attempt = await ExamAttempt.findById(req.params.attemptId).select('tenantId isCompleted examId');
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
      if (!attempt.isCompleted) return res.status(400).json({ error: 'Only completed attempts can be manually graded' });

      const isPrivilegedRole = ['EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
      // An active ExaminerAssignment alone is not sufficient authorization —
      // the caller must also hold the EVALUATOR role. Assignments can only
      // be created for users with evaluatorAccess.enabled today, but the
      // role check is the actual authorization boundary going forward.
      if (!isPrivilegedRole && !hasRole(req.user, 'EVALUATOR')) {
        return res.status(403).json({ error: 'Evaluator role required to review this attempt.' });
      }
      let examinerAssignment = null;

      if (isPrivilegedRole) {
        if (
          req.user.role !== 'SUPER_ADMIN' &&
          req.user.tenantId &&
          attempt.tenantId &&
          String(req.user.tenantId) !== String(attempt.tenantId)
        ) {
          return res.status(403).json({ error: 'You cannot grade an attempt outside your organisation' });
        }
      }

      const answer = await Answer.findOne({ _id: req.params.answerId, attemptId: attempt._id })
        .populate('questionId', 'points sectionId');
      if (!answer) return res.status(404).json({ error: 'Answer not found for this attempt' });

      if (!isPrivilegedRole) {
        examinerAssignment = await hasActiveExaminerAssignment(req.user._id, attempt.examId, {
          attemptId: attempt._id,
          questionId: answer.questionId?._id || answer.questionId,
          sectionId: answer.questionId?.sectionId,
        });
        if (!examinerAssignment || !examinerAssignment.canOverrideScore) {
          return res.status(403).json({
            error: 'You do not have an active examiner assignment permitting score overrides for this answer.',
          });
        }
        if (examinerAssignment.requiresOverrideReason && !String(req.body.overrideReason || '').trim()) {
          return res.status(400).json({ error: 'A reason is required to override this score.' });
        }
      }

      const maximumMarks = Math.max(Number(answer.questionId?.points) || 0, 0);
      const requestedMarks = Number(req.body.pointsEarned);
      if (requestedMarks > maximumMarks) {
        return res.status(400).json({ error: `Marks cannot exceed the question maximum of ${maximumMarks}` });
      }

      const previousMarks = Number(answer.pointsEarned) || 0;
      const marksChanged = Math.abs(requestedMarks - previousMarks) > 0.001;
      if (marksChanged && !normalizeString(req.body.feedback)) {
        return res.status(400).json({
          error: 'Please add feedback explaining the marks change.',
          field: 'feedback',
          answerId: answer._id,
        });
      }
      const priorEvaluation = answer.aiEvaluation && typeof answer.aiEvaluation === 'object'
        ? answer.aiEvaluation
        : {};
      answer.pointsEarned = Number(requestedMarks.toFixed(2));
      answer.isCorrect = maximumMarks > 0 && answer.pointsEarned >= maximumMarks;
      answer.needsReview = false;
      answer.aiEvaluation = {
        ...priorEvaluation,
        manualOverride: {
          applied: true,
          previousMarks,
          marks: answer.pointsEarned,
          feedback: normalizeString(req.body.feedback),
          overriddenBy: req.user._id,
          overriddenAt: new Date(),
        },
      };

      if (examinerAssignment) {
        answer.examinerScore = answer.pointsEarned;
        answer.examinerFeedback = normalizeString(req.body.feedback) || answer.examinerFeedback;
        answer.examinerId = req.user._id;
        answer.examinerReviewedAt = new Date();
        answer.finalScoreSource = 'EXAMINER';
        answer.evaluationStatus = 'REVIEWED';
      } else {
        answer.finalScoreSource = 'ADMIN_OVERRIDE';
        answer.evaluationStatus = 'FINALIZED';
      }

      await answer.save();

      const updatedAttempt = await ExamAttempt.findById(attempt._id);
      await ensureScoreSummary(updatedAttempt, { includeAnswers: false, force: true });
      await updatedAttempt.save();

      await logAuditEvent(AUDIT_ACTIONS.ANSWER_SCORE_OVERRIDDEN, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: attempt.tenantId || null,
        resourceType: 'Answer',
        resourceId: answer._id,
        details: {
          attemptId: attempt._id,
          previousMarks,
          newMarks: answer.pointsEarned,
          reason: req.body.overrideReason || null,
          viaExaminerAssignment: Boolean(examinerAssignment),
        },
      });

      res.json({
        answer,
        scoreSummary: updatedAttempt.scoreSummary,
        message: 'Manual marks and feedback saved.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// Examiner review action: approve the current AI/rule score as-is, override
// it, or flag it for moderation. Requires an active ExaminerAssignment
// covering this attempt (privileged roles bypass this the same way the
// manual-grade route does, so exam creators/admins can always act too).
router.put(
  '/:attemptId/answers/:answerId/examiner-review',
  requireAuth,
  validateObjectId('attemptId'),
  validateObjectId('answerId'),
  [
    body('action').isIn(['approve', 'override', 'flag']).withMessage('action must be approve, override, or flag'),
    body('pointsEarned').optional({ nullable: true }).isFloat({ min: 0 }),
    body('feedback').optional({ nullable: true }).isString().isLength({ max: 4000 }),
    body('overrideReason').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const attempt = await ExamAttempt.findById(req.params.attemptId).select('tenantId isCompleted examId');
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
      if (!attempt.isCompleted) return res.status(400).json({ error: 'Only completed attempts can be reviewed' });

      const isPrivilegedRole = ['EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
      // An active ExaminerAssignment alone is not sufficient authorization —
      // the caller must also hold the EVALUATOR role. Assignments can only
      // be created for users with evaluatorAccess.enabled today, but the
      // role check is the actual authorization boundary going forward.
      if (!isPrivilegedRole && !hasRole(req.user, 'EVALUATOR')) {
        return res.status(403).json({ error: 'Evaluator role required to review this attempt.' });
      }
      let examinerAssignment = null;

      if (isPrivilegedRole && (
        req.user.role !== 'SUPER_ADMIN' &&
        req.user.tenantId &&
        attempt.tenantId &&
        String(req.user.tenantId) !== String(attempt.tenantId)
      )) {
        return res.status(403).json({ error: 'You cannot review an attempt outside your organisation' });
      }

      const answer = await Answer.findOne({ _id: req.params.answerId, attemptId: attempt._id })
        .populate('questionId', 'points sectionId');
      if (!answer) return res.status(404).json({ error: 'Answer not found for this attempt' });

      if (!isPrivilegedRole) {
        examinerAssignment = await hasActiveExaminerAssignment(req.user._id, attempt.examId, {
          attemptId: attempt._id,
          questionId: answer.questionId?._id || answer.questionId,
          sectionId: answer.questionId?.sectionId,
        });
        if (!examinerAssignment) {
          return res.status(403).json({
            error: 'You do not have an active examiner assignment covering this answer.',
          });
        }
      }

      const action = req.body.action;
      const maximumMarks = Math.max(Number(answer.questionId?.points) || 0, 0);
      const feedback = normalizeString(req.body.feedback);
      let auditAction = AUDIT_ACTIONS.ANSWER_EXAMINER_REVIEWED;
      let scoreChanged = false;

      if (action === 'approve') {
        if (examinerAssignment && !examinerAssignment.canApproveAiScore) {
          return res.status(403).json({ error: 'This assignment does not permit approving AI scores.' });
        }
        answer.examinerScore = answer.pointsEarned;
        answer.examinerFeedback = feedback || answer.examinerFeedback;
        answer.examinerId = req.user._id;
        answer.examinerReviewedAt = new Date();
        answer.finalScoreSource = 'EXAMINER';
        answer.evaluationStatus = 'REVIEWED';
        answer.needsReview = false;
      } else if (action === 'override') {
        if (examinerAssignment && !examinerAssignment.canOverrideScore) {
          return res.status(403).json({ error: 'This assignment does not permit overriding scores.' });
        }
        if (
          examinerAssignment?.requiresOverrideReason &&
          !String(req.body.overrideReason || '').trim()
        ) {
          return res.status(400).json({ error: 'A reason is required to override this score.' });
        }
        if (req.body.pointsEarned === undefined || req.body.pointsEarned === null) {
          return res.status(400).json({ error: 'pointsEarned is required to override a score.' });
        }
        const requestedMarks = Number(req.body.pointsEarned);
        if (requestedMarks > maximumMarks) {
          return res.status(400).json({ error: `Marks cannot exceed the question maximum of ${maximumMarks}` });
        }
        const previousMarks = Number(answer.pointsEarned) || 0;
        const marksChanged = Math.abs(requestedMarks - previousMarks) > 0.001;
        if (marksChanged && !feedback) {
          return res.status(400).json({
            error: 'Please add feedback explaining the marks change.',
            field: 'feedback',
            answerId: answer._id,
          });
        }
        answer.pointsEarned = Number(requestedMarks.toFixed(2));
        answer.isCorrect = maximumMarks > 0 && answer.pointsEarned >= maximumMarks;
        answer.examinerScore = answer.pointsEarned;
        answer.examinerFeedback = feedback || answer.examinerFeedback;
        answer.examinerId = req.user._id;
        answer.examinerReviewedAt = new Date();
        answer.finalScoreSource = 'EXAMINER';
        answer.evaluationStatus = 'REVIEWED';
        answer.needsReview = false;
        auditAction = AUDIT_ACTIONS.ANSWER_SCORE_OVERRIDDEN;
        scoreChanged = true;
        req.body.__previousMarks = previousMarks;
      } else if (action === 'flag') {
        answer.examinerFeedback = feedback || answer.examinerFeedback;
        answer.examinerId = req.user._id;
        answer.examinerReviewedAt = new Date();
        answer.evaluationStatus = 'FLAGGED';
        auditAction = AUDIT_ACTIONS.ANSWER_FLAGGED_FOR_MODERATION;
      }

      await answer.save();

      let scoreSummary = null;
      if (scoreChanged) {
        const updatedAttempt = await ExamAttempt.findById(attempt._id);
        await ensureScoreSummary(updatedAttempt, { includeAnswers: false, force: true });
        await updatedAttempt.save();
        scoreSummary = updatedAttempt.scoreSummary;
      }

      await logAuditEvent(auditAction, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: attempt.tenantId || null,
        resourceType: 'Answer',
        resourceId: answer._id,
        details: {
          attemptId: attempt._id,
          action,
          previousMarks: req.body.__previousMarks ?? null,
          newMarks: scoreChanged ? answer.pointsEarned : null,
          reason: req.body.overrideReason || null,
        },
      });

      if (action === 'flag' && attempt.tenantId) {
        try {
          const { createRoleNotification } = await import('../services/notificationService.js');
          await createRoleNotification({
            title: 'Answer Flagged for Moderation',
            message: 'An examiner has flagged an answer for moderation review.',
            type: 'answer_flagged_for_moderation',
            tenantId: attempt.tenantId,
            createdBy: req.user._id,
            roles: ['TENANT_ADMIN', 'EXAM_CREATOR'],
            metadata: { attemptId: attempt._id, answerId: answer._id },
          });
        } catch (notifyError) {
          console.error('[NOTIFICATIONS] Failed to notify moderation flag:', notifyError?.message || notifyError);
        }
      }

      res.json({
        answer,
        scoreSummary,
        message: `Answer ${action === 'approve' ? 'approved' : action === 'override' ? 'overridden' : 'flagged for moderation'}.`,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Recalculate attempt result (admin only, requires confirmation)
router.post(
  '/:attemptId/recalculate',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  [
    body('confirmed').equals('true').withMessage('Recalculation must be confirmed'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      if (!attempt.isCompleted) {
        return res.status(400).json({ error: 'Cannot recalculate score for incomplete attempt' });
      }

      // Store before state for audit
      const beforeState = {
        totalScore: attempt.scoreSummary?.totalScore || 0,
        maxScore: attempt.scoreSummary?.maxScore || 0,
        percentage: attempt.scoreSummary?.percentage || 0,
        normalizedScore: attempt.normalizedScore || null,
        percentile: attempt.percentile || null,
      };

      // Recalculate score summary (force: bypass the cache so an updated
      // Answer.pointsEarned actually changes the attempt total)
      const { ensureScoreSummary } = await import('../utils/attemptScores.js');
      const scoreResult = await ensureScoreSummary(attempt, { includeAnswers: false, force: true });

      // Recalculate normalization if applicable
      let normalizationResult = null;
      try {
        const { calculateNormalizedScore } = await import('../services/normalizationService.js');
        normalizationResult = await calculateNormalizedScore(attempt._id);

        attempt.normalizedScore = normalizationResult.normalizedScore;
        attempt.percentile = normalizationResult.percentile;
        attempt.sessionPercentile = normalizationResult.sessionPercentile;
      } catch (err) {
        // Normalization might not be configured - that's okay
        console.warn('Normalization calculation failed:', err.message);
      }

      await attempt.save();

      // Log audit
      const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
      await logAuditEvent(AUDIT_ACTIONS.ATTEMPT_RECALCULATED || 'ATTEMPT_RECALCULATED', {
        userId: req.user._id,
        userEmail: req.user.email,
        userName: req.user.name,
        userRole: req.user.role,
        tenantId: attempt.tenantId || null,
        resourceType: 'ExamAttempt',
        resourceId: attempt._id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        method: req.method,
        path: req.path,
        details: {
          before: beforeState,
          after: {
            totalScore: attempt.scoreSummary?.totalScore || 0,
            maxScore: attempt.scoreSummary?.maxScore || 0,
            percentage: attempt.scoreSummary?.percentage || 0,
            normalizedScore: attempt.normalizedScore || null,
            percentile: attempt.percentile || null,
          },
        },
      });

      res.json({
        attempt,
        message: 'Result recalculated successfully',
        before: beforeState,
        after: {
          totalScore: attempt.scoreSummary?.totalScore || 0,
          maxScore: attempt.scoreSummary?.maxScore || 0,
          percentage: attempt.scoreSummary?.percentage || 0,
          normalizedScore: attempt.normalizedScore || null,
          percentile: attempt.percentile || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Resume attempt (for inactivity/disconnection cases)
router.post(
  '/:attemptId/resume',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  [
    body('reason').trim().notEmpty().withMessage('Reason is required'),
  ],
  auditLog(AUDIT_ACTIONS.ATTEMPT_RESUMED, (req) => ({
    resourceType: 'ExamAttempt',
    resourceId: req.params.attemptId,
    reason: req.body.reason,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      if (attempt.isCompleted) {
        return res.status(400).json({ error: 'Cannot resume a completed attempt' });
      }

      attempt.isResumed = true;
      attempt.resumeReason = req.body.reason;
      attempt.resumeAllowedBy = req.user._id;
      attempt.resumeAllowedAt = new Date();
      attempt.lastActivity = new Date();

      await attempt.save();
      res.json({ attempt, message: 'Attempt resumed successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Get candidate attempt view (admin view of any candidate's attempt)
router.get(
  '/candidate/:userId/attempt/:attemptId',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  validateObjectId('userId'),
  async (req, res, next) => {
    try {
      const attempt = await ExamAttempt.findById(req.params.attemptId)
        .populate('examId', 'title duration')
        .populate('sessionId', 'startTime endTime')
        .populate('userId', 'name email')
        .populate('questionPaperId', 'setName');

      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      if (attempt.userId._id.toString() !== req.params.userId) {
        return res.status(403).json({ error: 'Attempt does not belong to this user' });
      }

      // Get all answers with question details
      const answers = await Answer.find({ attemptId: attempt._id })
        .populate('questionId', 'questionText questionType options points sectionId order');

      // Get section-wise breakdown
      const sectionBreakdown = {};
      answers.forEach(answer => {
        if (answer.questionId?.sectionId) {
          const sectionId = answer.questionId.sectionId.toString();
          if (!sectionBreakdown[sectionId]) {
            sectionBreakdown[sectionId] = {
              answers: [],
              totalScore: 0,
              maxScore: 0,
            };
          }
          sectionBreakdown[sectionId].answers.push({
            question: answer.questionId,
            answer: answer.answerText,
            isCorrect: answer.isCorrect,
            pointsEarned: answer.pointsEarned,
            timeSpent: answer.timeSpent,
          });
          sectionBreakdown[sectionId].totalScore += answer.pointsEarned || 0;
          sectionBreakdown[sectionId].maxScore += answer.questionId.points || 0;
        }
      });

      // Calculate section percentages
      Object.keys(sectionBreakdown).forEach(sectionId => {
        const section = sectionBreakdown[sectionId];
        section.percentage = section.maxScore > 0
          ? Math.round((section.totalScore / section.maxScore) * 100)
          : 0;
      });

      res.json({
        attempt,
        answers,
        sectionBreakdown,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Allow individual candidate to re-attempt exam
 * Only EXAM_CREATOR, TENANT_ADMIN, or SUPER_ADMIN can allow re-attempts
 */
router.post(
  '/allow-reattempt/:attemptId',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenant,
  validateObjectId('attemptId'),
  [
    body('reason').optional().trim().isLength({ max: 500 }).withMessage('Reason must be less than 500 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId)
        .populate('examId', 'title tenantId')
        .populate('userId', 'name email');

      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      // Verify tenant access
      if (req.user.role !== 'SUPER_ADMIN') {
        const userTenantId = req.user.tenantId;
        const examTenantId = attempt.examId.tenantId;
        if (userTenantId && examTenantId && userTenantId.toString() !== examTenantId.toString()) {
          return res.status(403).json({ error: 'Access denied - Exam does not belong to your tenant' });
        }
      }

      // Mark this attempt as allowing re-attempt
      attempt.reAttemptAllowed = true;
      attempt.reAttemptReason = req.body.reason || 'Re-attempt allowed by administrator';
      attempt.reAttemptAllowedBy = req.user._id;
      attempt.reAttemptAllowedAt = new Date();

      await attempt.save();

      res.json({
        message: 'Re-attempt allowed successfully',
        attempt: {
          _id: attempt._id,
          userId: attempt.userId,
          examId: attempt.examId,
          reAttemptAllowed: attempt.reAttemptAllowed,
          reAttemptReason: attempt.reAttemptReason,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Get all attempts for a specific candidate in an exam
 * Used for managing individual candidate attempts
 */
router.get(
  '/exam/:examId/candidate/:userId',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  requireTenant,
  validateObjectId('examId'),
  validateObjectId('userId'),
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Verify tenant access
      if (req.user.role !== 'SUPER_ADMIN') {
        const userTenantId = req.user.tenantId;
        const examTenantId = exam.tenantId;
        if (userTenantId && examTenantId && userTenantId.toString() !== examTenantId.toString()) {
          return res.status(403).json({ error: 'Access denied - Exam does not belong to your tenant' });
        }
      }

      const attempts = await ExamAttempt.find({
        examId: req.params.examId,
        userId: req.params.userId,
      })
        .populate('sessionId', 'startTime endTime qrCode')
        .populate('questionPaperId', 'setName')
        .sort({ createdAt: -1 });

      // Count completed attempts
      const completedAttempts = attempts.filter(a => a.isCompleted).length;

      // Get attempted questions count for each attempt
      const attemptsWithStats = await Promise.all(
        attempts.map(async (attempt) => {
          const attemptObj = attempt.toObject();

          // Get total questions for this attempt's question paper
          let totalQuestions = 0;
          if (attempt.questionPaperId) {
            const questionPaperId = attempt.questionPaperId._id || attempt.questionPaperId;
            totalQuestions = await Question.countDocuments({ questionPaperId, isIncludedInExam: { $ne: false } });
          }

          // Count attempted questions (questions with answers)
          const attemptedCount = await Answer.countDocuments({
            attemptId: attempt._id,
            $or: [
              { answerText: { $exists: true, $ne: '' } },
              { answerText: { $exists: true, $ne: null } }
            ]
          });

          attemptObj.attemptedQuestions = attemptedCount;
          attemptObj.totalQuestions = totalQuestions;
          attemptObj.progressPercentage = totalQuestions > 0
            ? Math.round((attemptedCount / totalQuestions) * 100)
            : 0;

          return attemptObj;
        })
      );

      res.json({
        attempts: attemptsWithStats,
        completedAttempts,
        maxAttempts: exam.maxAttempts,
        canAttempt: completedAttempts < exam.maxAttempts || attempts.some(a => a.reAttemptAllowed),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Submit offline attempt
 * POST /attempts/offline-submit
 * Requires: CANDIDATE role
 */
router.post(
  '/offline-submit',
  requireAuth,
  requireRole('CANDIDATE'),
  [
    body('attemptId').notEmpty().withMessage('Attempt ID is required'),
    body('packageVersion').optional().isInt({ min: 1 }).withMessage('Package version must be a positive integer'),
    body('packageHash').optional().isString().withMessage('Package hash must be a string'),
    body('deviceFingerprint').optional().isString().withMessage('Device fingerprint must be a string'),
    body('answers').isObject().withMessage('Answers must be an object'),
    body('sectionTimings').optional().isArray().withMessage('Section timings must be an array'),
    body('violationEvents').optional().isArray().withMessage('Violation events must be an array'),
    body('violationLogs').optional().isArray().withMessage('Violation logs must be an array'),
    body('violationCount').optional().isInt({ min: 0 }).withMessage('Violation count must be a non-negative integer'),
    body('examStatus').optional().isIn(['FAIR', 'SUSPICIOUS', 'CHEATING']).withMessage('Exam status must be FAIR, SUSPICIOUS, or CHEATING'),
    body('timestampDrift').optional().isNumeric().withMessage('Timestamp drift must be a number'),
    body('offlineStartTime').optional().isISO8601().withMessage('Offline start time must be a valid ISO 8601 date'),
    body('offlineSubmitTime').optional().isISO8601().withMessage('Offline submit time must be a valid ISO 8601 date'),
  ],
  auditLog(AUDIT_ACTIONS.ATTEMPT_SUBMITTED, (req) => ({
    attemptId: req.body.attemptId,
    offlineMode: true,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

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
      } = req.body;

      // Verify attempt exists and belongs to user
      const attempt = await ExamAttempt.findById(attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      // Verify ownership
      if (attempt.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Forbidden - You can only submit your own attempts' });
      }

      if (attempt.isCompleted) {
        return res.status(400).json({ error: 'Attempt already submitted' });
      }

      const planContext = await resolveExamPlanContext(attempt.examId);
      if (
        planContext?.planType &&
        isFreePlan(planContext.planType) &&
        await hasWritingQuestionsInPaper(attempt.questionPaperId)
      ) {
        return sendWritingPlanRestriction(res);
      }

      // Prepare attempt data for reconciliation
      const attemptData = {
        attemptId,
        packageVersion,
        packageHash,
        deviceFingerprint,
        answers,
        sectionTimings: sectionTimings || [],
        violationEvents: violationEvents || [],
        violationLogs: violationLogs || [],
        violationCount,
        examStatus,
        timestampDrift: timestampDrift || 0,
        offlineStartTime,
        offlineSubmitTime,
        startTime: attempt.startTime,
        submitTime: new Date(),
      };

      // Reconcile offline attempt
      const reconciliationResult = await reconcileOfflineAttempt(attemptData);

      const offlineSubmitAtClient =
        typeof offlineSubmitTime === 'string' ? new Date(offlineSubmitTime) : null;
      const normalizedOfflineSubmitAtClient =
        offlineSubmitAtClient && !Number.isNaN(offlineSubmitAtClient.getTime())
          ? offlineSubmitAtClient
          : null;
      const offlineSubmissionUpdate = {
        offlineMode: true,
        offlineSubmitTime: normalizedOfflineSubmitAtClient || new Date(),
        'submitMeta.submissionSource': 'offline_submit',
      };
      if (normalizedOfflineSubmitAtClient) {
        offlineSubmissionUpdate['submitMeta.submittedAtClient'] =
          normalizedOfflineSubmitAtClient;
      }

      await ExamAttempt.updateOne(
        { _id: attemptId },
        {
          $set: offlineSubmissionUpdate,
        }
      );

      // Get updated attempt
      const updatedAttempt = await ExamAttempt.findById(attemptId)
        .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
        .populate('sessionId', 'startTime endTime')
        .populate('questionPaperId', '_id setName');

      // Calculate score summary
      const scoreSummary = await ensureScoreSummary(updatedAttempt);
      const canReviewAnswers = await hasExamPermission(
        req.user._id,
        updatedAttempt.examId?._id || updatedAttempt.examId,
        'REVIEW_ANSWERS'
      );
      const scoringVisible =
        canBypassReleaseWindow({
          userRole: req.user.role,
          canReviewAnswers,
        }) || isExamResultsReleased(updatedAttempt.examId);

      try {
        const { createRoleNotification, createUserNotification } = await import('../services/notificationService.js');
        const tenantId = attempt.tenantId || null;
        const examTitle = updatedAttempt.examId?.title || attempt.examSnapshot?.title || 'Exam';
        const candidateName = req.user.name || req.user.email || 'Candidate';

        await createUserNotification({
          title: 'Exam Submitted',
          message: `You submitted "${examTitle}".`,
          type: 'exam_submitted',
          roles: ['CANDIDATE'],
          userId: attempt.userId,
          tenantId,
          examId: updatedAttempt.examId?._id || updatedAttempt.examId,
          attemptId: attempt._id,
          createdBy: req.user._id,
          metadata: { examTitle },
        });

        if (tenantId) {
          await createRoleNotification({
            title: 'Exam Submitted',
            message: `${candidateName} submitted "${examTitle}".`,
            type: 'attempt_submitted',
            roles: ['TENANT_ADMIN', 'EXAM_CREATOR'],
            tenantId,
            examId: updatedAttempt.examId?._id || updatedAttempt.examId,
            attemptId: attempt._id,
            createdBy: req.user._id,
            metadata: { examTitle, candidateName },
          });
        }
      } catch (notifyError) {
        console.error('[NOTIFICATIONS] Failed to log offline submission:', notifyError?.message || notifyError);
      }

      console.log(
        `[ATTEMPT_OFFLINE_SUBMIT] attempt=${attemptId} user=${req.user?._id || 'unknown'} packageVersion=${packageVersion || 'n/a'}`
      );
      const integrity = buildAttemptIntegritySummary(updatedAttempt);

      res.json({
        attempt: updatedAttempt,
        attemptStatus: 'COMPLETED',
        submissionMode: 'submitted_offline',
        offlineSubmission: true,
        score: scoringVisible ? scoreSummary : null,
        violationCount: integrity.totalViolations,
        violationLogs: integrity.violationDetails,
        examStatus: integrity.examStatus,
        integrity,
        resultsAvailable: scoringVisible,
        reconciliation: {
          warnings: reconciliationResult.warnings || [],
          anomalies: reconciliationResult.anomalies || [],
          flags: reconciliationResult.flags || [],
        },
        message: 'Offline attempt submitted successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
