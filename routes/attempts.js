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
import { requireExamPermission, hasExamPermission, ensureExamParticipant } from '../middleware/examPermissions.js';
import { checkCandidateAttemptLimit } from '../middleware/planLimits.js';
import { body, validationResult } from 'express-validator';
import { validateObjectId, sanitizePagination, validateObjectIds } from '../middleware/validation.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import { evaluateAnswer } from '../services/aiService.js';
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

const normalizeAnswerForStorage = (questionType, value) => {
  if (questionType === 'MULTIPLE_OPTIONS') {
    const answers = parseArrayAnswer(value);
    return answers.length ? JSON.stringify(answers) : '';
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
};

const parseStoredAnswerValue = (questionType, value) => {
  if (questionType === 'MULTIPLE_OPTIONS') {
    return parseArrayAnswer(value);
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

const ADMIN_VIEWER_ROLES = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'EXAM_CREATOR']);

const isExamResultsReleased = (exam) => {
  if (!exam) return false;
  if (Boolean(exam.showResultsImmediately)) return true;
  if (!exam.resultsReleasedAt) return false;
  const releasedAt = new Date(exam.resultsReleasedAt);
  return !Number.isNaN(releasedAt.getTime()) && releasedAt <= new Date();
};

const isCertificatesReleased = (exam) => {
  if (!exam?.certificatesSentAt) return false;
  const sentAt = new Date(exam.certificatesSentAt);
  return !Number.isNaN(sentAt.getTime()) && sentAt <= new Date();
};

const canBypassReleaseWindow = ({ userRole, canReviewAnswers = false }) =>
  ADMIN_VIEWER_ROLES.has(userRole) || Boolean(canReviewAnswers);

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

      // UNIVERSAL: Ensure ExamParticipant exists with CANDIDATE role FIRST
      // This must happen before permission check, so the participant exists when we check permissions
      await ensureExamParticipant(
        req.user._id,
        examId,
        'CANDIDATE',
        req.user._id
      );

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

      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
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

      // Check if there's an active attempt
      const activeAttempt = await ExamAttempt.findOne({
        userId: req.user._id,
        sessionId,
        isCompleted: false,
      }).populate('questionPaperId', 'setName');

      if (activeAttempt) {
        await activeAttempt.populate('examId', 'title duration');
        await activeAttempt.populate('sessionId', 'startTime endTime');
        return res.json({
          attempt: activeAttempt,
          assignment: {
            questionPaperId:
              activeAttempt.questionPaperId?._id || activeAttempt.questionPaperId,
            setName: activeAttempt.questionPaperId?.setName,
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
          ipAddress: req.ip || req.connection?.remoteAddress || '',
          userAgent: req.get('user-agent') || '',
          deviceId: req.body.deviceId || req.headers['x-device-id'] || '',
        },
      });

      await attempt.save();
      if (req.planLimitContext?.shouldIncrementCandidateCount) {
        await syncExamCandidateCount(examId);
      }
      
      // Check for multiple logins
      const proctoringService = await import('../services/proctoringService.js');
      await proctoringService.logDeviceInfo(attempt._id, attempt.deviceInfo);
      const multipleLogins = await proctoringService.checkMultipleLogins(req.user._id, examId, attempt.deviceInfo);
      if (multipleLogins.hasMultipleLogins) {
        await proctoringService.flagSuspiciousActivity(attempt._id, 'MULTIPLE_LOGINS', {
          attempts: multipleLogins.attempts,
        });
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
      .populate('examId', '_id duration gracePeriod')
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

    const assignedQuestionPaperId =
      attempt.questionPaperId?._id ||
      attempt.questionPaperId ||
      attempt.sessionId?.questionPaperId;

    if (!assignedQuestionPaperId) {
      return res.status(400).json({ error: 'No question paper assigned for this attempt.' });
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

router.put(
  '/:attemptId/progress',
  requireAuth,
  validateObjectId('attemptId'),
  [
    body('answers').optional().isObject().withMessage('Answers must be an object'),
    body('lastActivity').optional().isISO8601().withMessage('lastActivity must be an ISO 8601 date'),
    body('currentSectionId').optional().isMongoId().withMessage('currentSectionId must be a valid section id'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId)
        .populate('examId', '_id duration gracePeriod')
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
      });
    } catch (error) {
      next(error);
    }
  }
);

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
    body('timerMeta').optional().isObject().withMessage('timerMeta must be an object'),
    body('submissionSource').optional().isString().withMessage('submissionSource must be a string'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const attempt = await ExamAttempt.findById(req.params.attemptId)
        .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
        .populate('sessionId');

      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      // Verify ownership: users can only submit their own attempts (unless they have REVIEW_ANSWERS permission)
      const canReview = await hasExamPermission(
        req.user._id,
        attempt.examId?._id || attempt.examId,
        'REVIEW_ANSWERS'
      );
      if (!canReview && attempt.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Forbidden - You can only submit your own attempts' });
      }

      if (attempt.isCompleted) {
        await attempt.populate('questionPaperId', 'setName');
        const canReviewAnswers = await hasExamPermission(
          req.user._id,
          attempt.examId?._id || attempt.examId,
          'REVIEW_ANSWERS'
        );
        const scoringVisible =
          canBypassReleaseWindow({
            userRole: req.user.role,
            canReviewAnswers,
          }) || isExamResultsReleased(attempt.examId);
        const summary = {
          totalScore: Number(attempt.scoreSummary?.totalScore) || 0,
          maxScore: Number(attempt.scoreSummary?.maxScore) || 0,
          percentage: Number(attempt.scoreSummary?.percentage) || 0,
        };
        return res.json({
          success: true,
          alreadySubmitted: true,
          attempt,
          attemptStatus: 'COMPLETED',
          submittedAt: attempt.submittedAt || attempt.submitTime || null,
          score: scoringVisible ? summary : null,
          resultsAvailable: scoringVisible,
        });
      }

      const { isDisqualified, disqualifyReason } = req.body;
      const timerMeta =
        req.body?.timerMeta && typeof req.body.timerMeta === 'object'
          ? req.body.timerMeta
          : null;
      const submittedAnswers = req.body?.answers && typeof req.body.answers === 'object'
        ? req.body.answers
        : {};

      // Sync section state before finalizing to avoid stale section timers.
      try {
        await getAttemptSectionProgress(attempt._id);
      } catch (sectionError) {
        // Continue submission even if section sync fails; submission lock still applies.
      }

      const assignedQuestionPaperId =
        attempt.questionPaperId?._id ||
        attempt.questionPaperId ||
        attempt.sessionId?.questionPaperId;

      if (!assignedQuestionPaperId) {
        return res.status(400).json({ error: 'No question paper assigned for this attempt.' });
      }

      // Get all questions for this session's question paper
      const questions = await Question.find({
        questionPaperId: assignedQuestionPaperId,
      }).sort({ order: 1 });

      const existingAnswers = await Answer.find({ attemptId: attempt._id }).select('questionId answerText');
      const existingAnswerMap = new Map(
        existingAnswers.map((answerDoc) => [answerDoc.questionId.toString(), answerDoc.answerText])
      );

      const answerWriteOperations = [];
      let totalScore = 0;
      let maxScore = 0;

      // Process each question
      for (const question of questions) {
        maxScore += question.points;
        const questionId = question._id.toString();
        const hasSubmittedAnswer = Object.prototype.hasOwnProperty.call(submittedAnswers, questionId);
        const rawAnswer = hasSubmittedAnswer
          ? submittedAnswers[questionId]
          : existingAnswerMap.get(questionId);
        const studentAnswer = rawAnswer === undefined || rawAnswer === null ? '' : rawAnswer;

        let normalizedAnswerText = normalizeAnswerForStorage(
          question.questionType,
          studentAnswer
        );

        let isCorrect = false;
        let pointsEarned = 0;
        let aiEvaluation = null;

        // Auto-grade objective questions
        if (
          ['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'NUMBER'].includes(
            question.questionType
          )
        ) {
          if (question.questionType === 'MULTIPLE_OPTIONS') {
            const expected = parseArrayAnswer(question.correctAnswer);
            const received = parseArrayAnswer(studentAnswer);
            isCorrect = expected.length > 0 && arrayEqualsIgnoreOrder(expected, received);
            normalizedAnswerText = received.length ? JSON.stringify(received) : '';
            pointsEarned = isCorrect ? question.points : 0;
          } else if (question.questionType === 'NUMBER') {
            isCorrect = String(studentAnswer).trim() === String(question.correctAnswer ?? '').trim();
            pointsEarned = isCorrect ? question.points : 0;
          } else {
            isCorrect = String(studentAnswer).trim() === String(question.correctAnswer ?? '').trim();
            pointsEarned = isCorrect ? question.points : 0;
          }
        } else if (['SHORT_ANSWER', 'PARAGRAPH'].includes(question.questionType)) {
          const hasSubjectiveAnswer = String(studentAnswer).trim().length > 0;

          if (hasSubjectiveAnswer) {
            // AI evaluation for subjective questions (skip empty answers)
            try {
              aiEvaluation = await evaluateAnswer({
                question: question.questionText,
                correctAnswer: question.correctAnswer,
                studentAnswer,
                questionType: question.questionType,
                points: question.points,
              });

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

      const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
      const submitTime = new Date();

      // Update attempt
      attempt.isCompleted = true;
      attempt.submitTime = submitTime;
      attempt.submittedAt = submitTime;
      attempt.isDisqualified = isDisqualified || false;
      attempt.disqualifyReason = disqualifyReason || '';
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
      attempt.submitMeta = {
        submissionSource:
          typeof req.body?.submissionSource === 'string'
            ? req.body.submissionSource.slice(0, 64)
            : null,
        submittedAtClient:
          submittedAtClient && !Number.isNaN(submittedAtClient.getTime())
            ? submittedAtClient
            : null,
        totalRemainingSeconds:
          timerMeta?.totalRemainingSeconds !== undefined
            ? toNonNegativeInt(timerMeta.totalRemainingSeconds, 0)
            : null,
        currentSectionId:
          typeof timerMeta?.currentSectionId === 'string' &&
          /^[a-fA-F0-9]{24}$/.test(timerMeta.currentSectionId)
            ? timerMeta.currentSectionId
            : null,
      };

      await attempt.save();

      await attempt.populate('examId', 'title duration showResultsImmediately resultsReleasedAt');
      await attempt.populate('questionPaperId', 'setName');
      const savedAnswers = await Answer.find({ attemptId: attempt._id });
      const canReviewAnswers = await hasExamPermission(
        req.user._id,
        attempt.examId?._id || attempt.examId,
        'REVIEW_ANSWERS'
      );
      const scoringVisible =
        canBypassReleaseWindow({
          userRole: req.user.role,
          canReviewAnswers,
        }) || isExamResultsReleased(attempt.examId);

      res.json({
        success: true,
        attempt,
        attemptStatus: 'COMPLETED',
        submittedAt: submitTime.toISOString(),
        score: scoringVisible
          ? {
              totalScore,
              maxScore,
              percentage,
            }
          : null,
        answers: scoringVisible ? savedAnswers : [],
        resultsAvailable: scoringVisible,
        message: scoringVisible
          ? 'Attempt submitted successfully.'
          : 'Attempt submitted successfully. Results are not yet released for candidates.',
      });
    } catch (error) {
      next(error);
    }
  }
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

    // For candidate-owned attempts, enforce release window.
    if (
      isOwnAttempt &&
      !canViewAnyAttempt &&
      attempt.examId &&
      !isExamResultsReleased(attempt.examId)
    ) {
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
        userRole: req.user.role,
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
        userRole: req.user.role,
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
        userRole: req.user.role,
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

      // Recalculate score summary
      const { ensureScoreSummary } = await import('../utils/attemptScores.js');
      const scoreResult = await ensureScoreSummary(attempt, { includeAnswers: false });

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
        userRole: req.user.role,
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

// Recalculate attempt result (admin only, requires confirmation)
router.post(
  '/:attemptId/recalculate',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'),
  validateObjectId('attemptId'),
  [
    body('confirm').equals('true').withMessage('Confirmation required'),
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
        normalizedScore: attempt.normalizedScore,
        percentile: attempt.percentile,
      };

      // Recalculate score summary
      const { ensureScoreSummary } = await import('../utils/attemptScores.js');
      const scoreResult = await ensureScoreSummary(attempt, { includeAnswers: false });

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
        console.log('Normalization not available:', err.message);
      }

      await attempt.save();

      // Log audit
      const { logAuditEvent, AUDIT_ACTIONS } = await import('../utils/auditLogger.js');
      await logAuditEvent(AUDIT_ACTIONS.ATTEMPT_RECALCULATED || 'ATTEMPT_RECALCULATED', {
        userId: req.user._id,
        userEmail: req.user.email,
        userRole: req.user.role,
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
            normalizedScore: attempt.normalizedScore,
            percentile: attempt.percentile,
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
          normalizedScore: attempt.normalizedScore,
          percentile: attempt.percentile,
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
            totalQuestions = await Question.countDocuments({ questionPaperId });
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

      // Prepare attempt data for reconciliation
      const attemptData = {
        attemptId,
        packageVersion,
        packageHash,
        deviceFingerprint,
        answers,
        sectionTimings: sectionTimings || [],
        violationEvents: violationEvents || [],
        timestampDrift: timestampDrift || 0,
        offlineStartTime,
        offlineSubmitTime,
        startTime: attempt.startTime,
        submitTime: new Date(),
      };

      // Reconcile offline attempt
      const reconciliationResult = await reconcileOfflineAttempt(attemptData);

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

      res.json({
        attempt: updatedAttempt,
        score: scoringVisible ? scoreSummary : null,
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
