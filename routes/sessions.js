import express from 'express';
import mongoose from 'mongoose';
import ExamSession from '../models/ExamSession.js';
import Exam from '../models/Exam.js';
import ExamParticipant from '../models/ExamParticipant.js';
import User from '../models/User.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import SessionAssignment from '../models/SessionAssignment.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import {
  canCandidateAccessSession,
  hasExamPermission,
} from '../middleware/examPermissions.js';
import { body, validationResult } from 'express-validator';
import { generateSessionQRCode } from '../services/qrService.js';
import { assignQuestionPaperToStudent } from '../services/sessionAssignment.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';
import { resolveAttemptExhaustedExamIds } from '../utils/attemptAvailability.js';

const router = express.Router();

const generateManualToken = async () => {
  let token;
  let exists = true;

  while (exists) {
    token = Math.floor(10000 + Math.random() * 90000).toString();
    exists = await ExamSession.exists({ manualToken: token });
  }

  return token;
};

const parseCandidateIds = (value) => {
  if (value === undefined) {
    return { provided: false, ids: [], invalidIds: [], duplicateIds: [] };
  }

  if (!Array.isArray(value)) {
    return {
      provided: true,
      ids: [],
      invalidIds: ['Candidate assignments must be an array.'],
      duplicateIds: [],
    };
  }

  const rawIds = value;
  const normalizedIds = rawIds.map((id) => String(id || '').trim());
  const invalidIds = normalizedIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));
  const duplicateIds = normalizedIds.filter((id, index) => normalizedIds.indexOf(id) !== index);

  return {
    provided: true,
    ids: [...new Set(normalizedIds)],
    invalidIds: [...new Set(invalidIds)],
    duplicateIds: [...new Set(duplicateIds)],
  };
};

const validateCandidateUsers = async (candidateIds, tenantId, { requireActive = true } = {}) => {
  if (!candidateIds.length) {
    return [];
  }

  const candidateFilter = {
    _id: { $in: candidateIds },
    role: 'CANDIDATE',
    tenantId,
  };
  if (requireActive) {
    candidateFilter.status = 'ACTIVE';
  }

  const candidates = await User.find(candidateFilter)
    .select('_id')
    .lean();

  if (candidates.length !== candidateIds.length) {
    const validIds = new Set(candidates.map((candidate) => String(candidate._id)));
    const rejectedIds = candidateIds.filter((id) => !validIds.has(id));
    const error = new Error(
      'Candidates must exist, be active, have the CANDIDATE role, and belong to the session tenant.'
    );
    error.statusCode = 400;
    error.rejectedIds = rejectedIds;
    throw error;
  }

  return candidates;
};

const updateSessionCandidateAssignments = async ({
  session,
  candidateIds,
  mode = 'replace',
  assignedBy,
}) => {
  const existingAssignments = await SessionAssignment.find({
    sessionId: session._id,
    grantsAccess: true,
  })
    .select('userId')
    .lean();
  const existingIds = new Set(existingAssignments.map((assignment) => String(assignment.userId)));
  const requestedIds = new Set(candidateIds);
  let nextIds;

  if (mode === 'add') {
    nextIds = new Set([...existingIds, ...requestedIds]);
  } else if (mode === 'remove') {
    nextIds = new Set([...existingIds].filter((id) => !requestedIds.has(id)));
  } else {
    nextIds = requestedIds;
  }

  const addedIds = [...nextIds].filter((id) => !existingIds.has(id));
  const removedIds = [...existingIds].filter((id) => !nextIds.has(id));
  const operations = [];

  if (removedIds.length) {
    operations.push({
      updateMany: {
        filter: { sessionId: session._id, userId: { $in: removedIds } },
        update: { $set: { grantsAccess: false } },
      },
    });
  }

  for (const userId of addedIds) {
    operations.push({
      updateOne: {
        filter: { sessionId: session._id, userId },
        update: {
          $set: {
            grantsAccess: true,
            assignedAt: new Date(),
            assignedBy,
          },
          $setOnInsert: {
            sessionId: session._id,
            userId,
          },
        },
        upsert: true,
      },
    });
  }

  if (operations.length) {
    await SessionAssignment.bulkWrite(operations);
  }

  session.assignAllCandidates = nextIds.size === 0;
  await session.save();

  return { addedIds, removedIds, candidateIds: [...nextIds] };
};

const validateSessionAvailability = async (session, user) => {
  if (!session) {
    return { valid: false, message: 'Session not found' };
  }

  if (!session.isActive) {
    return { valid: false, message: 'Session is not active' };
  }

  const now = new Date();
  if (now < session.startTime) {
    return { valid: false, message: 'Session has not started yet' };
  }

  if (now > session.endTime) {
    return { valid: false, message: 'Session has ended' };
  }

  // Universal: Check if user is blocked
  const SystemConfig = (await import('../models/SystemConfig.js')).default;
  const blockedConfig = await SystemConfig.findOne({
    key: `blocked_user_${user._id}`,
  });

  if (blockedConfig && blockedConfig.value === 'true') {
    return { valid: false, message: 'Your account has been blocked' };
  }

  return { valid: true };
};

const resolveCandidateAccessibleExamIds = async ({ tenantId, userId }) => {
  const [assignedExamIds, restrictedExamIds] = await Promise.all([
    ExamParticipant.distinct('examId', {
      tenantId,
      userId,
      examRole: 'CANDIDATE',
    }),
    ExamParticipant.distinct('examId', {
      tenantId,
      examRole: 'CANDIDATE',
    }),
  ]);

  const assignedIds = assignedExamIds.map((id) => String(id));
  const restrictedIds = restrictedExamIds.map((id) => String(id));

  if (restrictedIds.length === 0) {
    return null;
  }

  const examFilter = {
    tenantId,
    $or: [{ _id: { $in: assignedIds } }, { _id: { $nin: restrictedIds } }],
  };

  const accessibleExams = await Exam.find(examFilter).select('_id').lean();
  return accessibleExams.map((exam) => exam._id);
};

// Get all sessions (role filtered and tenant filtered)
router.get('/', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, examId, isActive } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { ...req.tenantFilter };

    if (examId) {
      filter.examId = examId;
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    // Filter based on exam permissions
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'EXAM_CREATOR') {
      // Admins see all sessions in their scope
      if (isActive !== undefined) {
        filter.isActive = isActive === 'true';
      }
    } else {
      const accessibleExamIds = await resolveCandidateAccessibleExamIds({
        tenantId: req.user.tenantId,
        userId: req.user._id,
      });

      if (!accessibleExamIds) {
        if (isActive !== undefined) {
          filter.isActive = isActive === 'true';
        } else {
          filter.isActive = true;
          const now = new Date();
          filter.startTime = { $lte: now };
          filter.endTime = { $gte: now };
        }
      } else {
        if (examId && !accessibleExamIds.some((id) => String(id) === String(examId))) {
          filter._id = { $in: [] };
        } else {
          filter.examId = examId || { $in: accessibleExamIds };
        }
        if (isActive !== undefined) {
          filter.isActive = isActive === 'true';
        } else {
          filter.isActive = true;
          const now = new Date();
          filter.startTime = { $lte: now };
          filter.endTime = { $gte: now };
        }
      }

      const assignedSessionIds = await SessionAssignment.distinct('sessionId', {
        userId: req.user._id,
        grantsAccess: true,
      });
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { assignAllCandidates: { $ne: false } },
            { _id: { $in: assignedSessionIds } },
          ],
        },
      ];

      const exhaustedExamIds = await resolveAttemptExhaustedExamIds({
        userId: req.user._id,
        tenantId: req.user.tenantId,
      });
      if (exhaustedExamIds.length > 0) {
        if (examId && exhaustedExamIds.some((id) => String(id) === String(examId))) {
          filter._id = { $in: [] };
        } else if (filter.examId && typeof filter.examId === 'object' && Array.isArray(filter.examId.$in)) {
          filter.examId = {
            ...filter.examId,
            $nin: exhaustedExamIds,
          };
        } else if (!filter.examId) {
          filter.examId = { $nin: exhaustedExamIds };
        }
      }
    }

    const sessions = await ExamSession.find(filter)
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt candidateCount')
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await ExamSession.countDocuments(filter);

    const sessionIds = sessions.map((session) => session._id);
    const candidateCounts = sessionIds.length
      ? await SessionAssignment.aggregate([
          {
            $match: {
              sessionId: { $in: sessionIds },
              grantsAccess: true,
            },
          },
          { $group: { _id: '$sessionId', count: { $sum: 1 } } },
        ])
      : [];

    const countMap = {};
    candidateCounts.forEach((c) => { countMap[String(c._id)] = c.count; });

    const sessionsWithCounts = sessions.map((s) => {
      const sessionId = String(s._id);
      const plain = s.toObject ? s.toObject() : { ...s };
      plain.assignedCandidatesCount = countMap[sessionId] ?? 0;
      return plain;
    });

    res.json({
      sessions: sessionsWithCounts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------------------
// Get all assigned candidates for a session (with attempt status)
// Must be registered BEFORE /:sessionId to avoid route conflicts
// -------------------------------------------------------------------------
router.get('/:sessionId/candidates', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const session = await ExamSession.findById(req.params.sessionId)
      .select('examId tenantId createdBy assignAllCandidates')
      .populate('examId', 'subTenantId')
      .lean();
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const examId = session.examId?._id || session.examId;

    // Only EXAM_CREATOR / TENANT_ADMIN / SUPER_ADMIN may list candidates
    const canCreateSession = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION');
    if (!canCreateSession && req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'TENANT_ADMIN' && req.user.role !== 'EXAM_CREATOR') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const ExamAttempt = (await import('../models/ExamAttempt.js')).default;

    let candidatesList = [];
    if (session.assignAllCandidates === false) {
      const [assignments, participants] = await Promise.all([
        SessionAssignment.find({
          sessionId: session._id,
          grantsAccess: true,
        })
          .select('userId assignedAt')
          .lean(),
        ExamParticipant.find({
          examId,
          examRole: 'CANDIDATE',
        })
          .select('userId assignedAt')
          .lean(),
      ]);
      const sessionAssignmentByUserId = new Map(
        assignments.map((assignment) => [String(assignment.userId), assignment])
      );
      const examParticipantByUserId = new Map(
        participants.map((participant) => [String(participant.userId), participant])
      );
      const candidateUserIds = [
        ...new Set([
          ...assignments.map((assignment) => String(assignment.userId)),
          ...participants.map((participant) => String(participant.userId)),
        ]),
      ];
      const users = await User.find({ _id: { $in: candidateUserIds } })
        .select('name email profileImage')
        .lean();
      const userMap = {};
      users.forEach((u) => { userMap[String(u._id)] = u; });

      candidatesList = candidateUserIds.map((uid) => {
        const assignment = sessionAssignmentByUserId.get(uid);
        const participant = examParticipantByUserId.get(uid);
        const user = userMap[uid] || null;
        return {
          _id: assignment?._id || participant?._id || uid,
          userId: { _id: uid, ...(user || {}) },
          assignedAt: assignment?.assignedAt || participant?.assignedAt || null,
          sessionAssigned: Boolean(assignment),
          examAssigned: Boolean(participant),
        };
      });
    } else {
      const participants = await ExamParticipant.find({
        examId,
        examRole: 'CANDIDATE',
      }).lean();

      if (participants.length > 0) {
        const candidateUserIds = participants.map((participant) => participant.userId);
        const users = await User.find({ _id: { $in: candidateUserIds } })
          .select('name email profileImage')
          .lean();
        const userMap = new Map(users.map((user) => [String(user._id), user]));
        candidatesList = participants.map((participant) => ({
          _id: participant._id,
          userId: {
            _id: participant.userId,
            ...(userMap.get(String(participant.userId)) || {}),
          },
          assignedAt: participant.assignedAt,
          sessionAssigned: true,
          examAssigned: true,
        }));
      } else {
        const userQuery = {
          role: 'CANDIDATE',
          tenantId: session.tenantId,
          status: 'ACTIVE',
        };
        if (session.examId?.subTenantId) {
          userQuery.subTenantId = session.examId.subTenantId;
        }
        const users = await User.find(userQuery)
          .select('name email profileImage createdAt')
          .lean();

        candidatesList = users.map((user) => ({
          _id: user._id,
          userId: user,
          assignedAt: user.createdAt,
          sessionAssigned: true,
          examAssigned: false,
        }));
      }
    }

    // Fetch attempts for this specific session
    const attempts = await ExamAttempt.find({ sessionId: req.params.sessionId })
      .select('userId isCompleted isDisqualified scoreSummary startTime submittedAt createdAt')
      .lean();

    const attemptMap = {};
    attempts.forEach((a) => { attemptMap[String(a.userId)] = a; });

    // Make sure all users who have attempts are also included in candidatesList if not already present
    const candidateMap = {};
    candidatesList.forEach((c) => {
      candidateMap[String(c.userId._id)] = c;
    });

    const missingAttemptUserIds = attempts
      .map((attempt) => attempt.userId)
      .filter((userId) => !candidateMap[String(userId)]);
    const missingAttemptUsers = missingAttemptUserIds.length
      ? await User.find({ _id: { $in: missingAttemptUserIds } })
          .select('name email profileImage createdAt')
          .lean()
      : [];

    for (const attemptUser of missingAttemptUsers) {
      candidateMap[String(attemptUser._id)] = {
        _id: attemptUser._id,
        userId: attemptUser,
        assignedAt: attemptUser.createdAt,
        sessionAssigned: false,
        examAssigned: false,
      };
    }

    const candidates = Object.values(candidateMap).map((c) => {
      const uid = String(c.userId._id);
      const attempt = attemptMap[uid] || null;

      return {
        _id: c._id,
        participantId: c._id,
        userId: c.userId,
        assignedAt: c.assignedAt,
        sessionAssigned: c.sessionAssigned !== false,
        examAssigned: Boolean(c.examAssigned),
        // Attempt fields (null/false if not started yet)
        attemptId: attempt?._id || null,
        isCompleted: attempt?.isCompleted || false,
        isDisqualified: attempt?.isDisqualified || false,
        score: attempt?.isCompleted && attempt?.scoreSummary
          ? (attempt.scoreSummary.percentage ?? null)
          : null,
        startTime: attempt?.startTime || null,
        submittedAt: attempt?.submittedAt || null,
        hasStarted: !!attempt,
      };
    });

    // Aggregate stats
    const total = candidates.length;
    const started = candidates.filter((c) => c.hasStarted).length;
    const submitted = candidates.filter((c) => c.isCompleted && !c.isDisqualified).length;
    const inProgress = candidates.filter((c) => c.hasStarted && !c.isCompleted && !c.isDisqualified).length;
    const disqualified = candidates.filter((c) => c.isDisqualified).length;
    const notStarted = candidates.filter((c) => !c.hasStarted).length;

    res.json({
      candidates,
      stats: { total, started, submitted, inProgress, disqualified, notStarted },
    });
  } catch (error) {
    next(error);
  }
});

// Get single session
router.get('/:sessionId', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const session = await ExamSession.findById(req.params.sessionId)
      .populate(
        'examId',
        'title description duration gracePeriod maxAttempts showResultsImmediately resultsReleasedAt allowCertification passingPercentage'
      )
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName')
      .populate('createdBy', 'name email');

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const canAttempt =
      req.user.role === 'CANDIDATE'
        ? await canCandidateAccessSession(req.user._id, session)
        : await hasExamPermission(req.user._id, session.examId._id, 'ATTEMPT_EXAM');
    const canCreateSession = await hasExamPermission(req.user._id, session.examId._id, 'CREATE_SESSION');

    if (!canAttempt && !canCreateSession && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'You are not assigned to this session' });
    }

    // For candidates, only show if active and within time
    if (canAttempt && !canCreateSession) {
      const now = new Date();
      if (!session.isActive || now < session.startTime || now > session.endTime) {
        return res.status(403).json({ error: 'Session not available' });
      }
    }

    let assignment = null;
    // Only assign question paper if user can attempt the exam
    if (canAttempt) {
      await session.populate('questionPaperIds', 'setName');
      const result = await assignQuestionPaperToStudent({
        session,
        userId: req.user._id,
      });
      const resolvedQuestionPaperId = result.questionPaperId?._id || result.questionPaperId || null;
      const questionCount = resolvedQuestionPaperId
        ? await Question.countDocuments({ questionPaperId: resolvedQuestionPaperId })
        : 0;
      assignment = {
        questionPaperId: resolvedQuestionPaperId,
        setName: result.questionPaperId?.setName,
        questionCount,
      };
    }

    res.json({ session, assignment });
  } catch (error) {
    next(error);
  }
});

/**
 * Create session - Only EXAM_CREATOR can create sessions
 *
 * Simple flow:
 * 1. User must be EXAM_CREATOR role
 * 2. User must belong to a tenant (except SUPER_ADMIN)
 * 3. Session inherits tenantId from exam
 * 4. QR code and manual token are generated
 */
router.post(
  '/',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  [
    body('examId').notEmpty().withMessage('Exam ID is required'),
    body('questionPaperId').optional().isMongoId(),
    body('questionPaperIds').optional().isArray({ min: 1 }),
    body('questionPaperIds.*').optional().isMongoId(),
    body('distributionMode')
      .optional()
      .isIn(['single', 'random', 'sequential', 'roll', 'manual']),
    body('candidateIds').optional().isArray(),
    body('candidateIds.*').optional().isMongoId(),
    body('assignedCandidates').optional().isArray(),
    body('assignedCandidates.*').optional().isMongoId(),
    body('candidateAssignmentMode').optional().isIn(['replace']),
    body('startTime').isISO8601().withMessage('Valid start time is required'),
    body('endTime').isISO8601().withMessage('Valid end time is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        examId,
        questionPaperId,
        questionPaperIds = [],
        startTime,
        endTime,
        distributionMode = 'single',
      } = req.body;

      const normalizedMode = distributionMode || 'single';
      const candidatePayloadValue = Object.prototype.hasOwnProperty.call(req.body, 'candidateIds')
        ? req.body.candidateIds
        : Object.prototype.hasOwnProperty.call(req.body, 'assignedCandidates')
          ? req.body.assignedCandidates
          : req.body.assignAllCandidates === true
            ? []
            : undefined;
      const candidatePayload = parseCandidateIds(candidatePayloadValue);
      if (candidatePayload.invalidIds.length || candidatePayload.duplicateIds.length) {
        return res.status(400).json({
          error: 'Candidate assignments contain invalid or duplicate user IDs.',
          invalidIds: candidatePayload.invalidIds,
          duplicateIds: candidatePayload.duplicateIds,
        });
      }

      // Verify exam exists and user has CREATE_SESSION permission
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check if user has CREATE_SESSION permission for this exam
      const canCreateSession = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION');
      if (!canCreateSession && req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'EXAM_CREATOR') {
        return res.status(403).json({ error: 'You do not have permission to create sessions for this exam' });
      }

      // Inherit tenant ID from exam
      const tenantId = exam.tenantId || null;
      await validateCandidateUsers(candidatePayload.ids, tenantId);

      let selectedPaperIds = Array.isArray(questionPaperIds)
        ? questionPaperIds.map((id) => id.toString())
        : [];

      if (questionPaperId) {
        selectedPaperIds.push(questionPaperId.toString());
      }

      selectedPaperIds = [...new Set(selectedPaperIds)];

      if (normalizedMode === 'single') {
        if (!selectedPaperIds.length) {
          return res
            .status(400)
            .json({ error: 'Please select a question paper for the session.' });
        }
        selectedPaperIds = [selectedPaperIds[0]];
      } else {
        if (selectedPaperIds.length < 2) {
          return res.status(400).json({
            error: 'Select at least two question papers for distributed sessions.',
          });
        }
      }

      const questionPapers = await QuestionPaper.find({
        _id: { $in: selectedPaperIds },
        examId,
      });

      if (questionPapers.length !== selectedPaperIds.length) {
        return res
          .status(404)
          .json({ error: 'One or more selected question papers were not found.' });
      }

      // Verify times
      const start = new Date(startTime);
      const end = new Date(endTime);
      if (end <= start) {
        return res.status(400).json({ error: 'End time must be after start time' });
      }

      const manualToken = await generateManualToken();

      const session = new ExamSession({
        examId,
        questionPaperId: selectedPaperIds[0],
        questionPaperIds: selectedPaperIds,
        distributionMode: normalizedMode,
        distributionState: { lastAssignedIndex: -1 },
        qrCode: 'placeholder',
        qrImage: '',
        manualToken,
        isActive: true,
        startTime: start,
        endTime: end,
        createdBy: req.user._id,
        tenantId,
        assignAllCandidates: candidatePayload.ids.length === 0,
      });

      const requestOrigin =
        req.body.appBaseUrl ||
        req.get('origin') ||
        req.headers['x-forwarded-origin'] ||
        undefined;

      const { qrCode, qrImage } = await generateSessionQRCode(
        session._id,
        examId,
        manualToken,
        requestOrigin
      );
      session.qrCode = qrCode;
      session.qrImage = qrImage;

      await session.save();
      const assignmentChanges = await updateSessionCandidateAssignments({
        session,
        candidateIds: candidatePayload.ids,
        mode: 'replace',
        assignedBy: req.user._id,
      });

      if (assignmentChanges.addedIds.length) {
        await logAuditEvent(AUDIT_ACTIONS.SESSION_CANDIDATES_ASSIGNED, {
          userId: req.user._id,
          userRole: req.user.role,
          tenantId,
          resourceType: 'ExamSession',
          resourceId: session._id,
          candidateIds: assignmentChanges.addedIds,
          method: req.method,
          path: req.path,
        });
      }

      await session.populate('examId', 'title duration showResultsImmediately resultsReleasedAt');
      await session.populate('questionPaperId', 'setName');
      await session.populate('questionPaperIds', 'setName');

      res.status(201).json({
        session,
        qrImage,
        manualToken,
        assignedCandidateIds: assignmentChanges.candidateIds,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Update a session (end now / extend end time)
router.put(
  '/:sessionId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const session = await ExamSession.findById(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Tenant safety guard
      if (
        req.user?.tenantId &&
        session.tenantId &&
        String(req.user.tenantId) !== String(session.tenantId)
      ) {
        return res.status(403).json({ error: 'Forbidden - Session belongs to different tenant' });
      }

      // Check if user can manage sessions for this exam.
      const canCreateSession = await hasExamPermission(
        req.user._id,
        session.examId,
        'CREATE_SESSION'
      );
      if (!canCreateSession && req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'EXAM_CREATOR') {
        return res.status(403).json({
          error: 'You do not have permission to update this session',
        });
      }

      const candidatePayloadValue = Object.prototype.hasOwnProperty.call(req.body, 'candidateIds')
        ? req.body.candidateIds
        : Object.prototype.hasOwnProperty.call(req.body, 'assignedCandidates')
          ? req.body.assignedCandidates
          : req.body.assignAllCandidates === true
            ? []
            : undefined;
      const candidatePayload = parseCandidateIds(candidatePayloadValue);
      const assignmentMode = String(req.body?.candidateAssignmentMode || 'replace').toLowerCase();
      if (!['add', 'remove', 'replace'].includes(assignmentMode)) {
        return res.status(400).json({
          error: 'candidateAssignmentMode must be add, remove, or replace',
        });
      }
      if (candidatePayload.invalidIds.length || candidatePayload.duplicateIds.length) {
        return res.status(400).json({
          error: 'Candidate assignments contain invalid or duplicate user IDs.',
          invalidIds: candidatePayload.invalidIds,
          duplicateIds: candidatePayload.duplicateIds,
        });
      }
      if (candidatePayload.provided) {
        await validateCandidateUsers(candidatePayload.ids, session.tenantId, {
          requireActive: assignmentMode !== 'remove',
        });
      }

      const action = String(req.body?.action || '').trim().toLowerCase();
      const nextEndTimeRaw = req.body?.endTime;
      const now = new Date();

      if (action === 'end') {
        session.isActive = false;
        if (session.endTime > now) {
          session.endTime = now;
        }
      } else if (nextEndTimeRaw) {
        const nextEndTime = new Date(nextEndTimeRaw);
        if (Number.isNaN(nextEndTime.getTime())) {
          return res.status(400).json({ error: 'Valid end time is required' });
        }
        if (nextEndTime <= session.startTime) {
          return res.status(400).json({ error: 'End time must be after start time' });
        }
        session.endTime = nextEndTime;
      } else if (!candidatePayload.provided) {
        return res.status(400).json({
          error:
            'Nothing to update. Provide action="end", a valid endTime, or candidateIds.',
        });
      }

      await session.save();
      let assignmentChanges = null;
      if (candidatePayload.provided) {
        assignmentChanges = await updateSessionCandidateAssignments({
          session,
          candidateIds: candidatePayload.ids,
          mode: assignmentMode,
          assignedBy: req.user._id,
        });

        let auditAction = null;
        if (assignmentChanges.addedIds.length && assignmentChanges.removedIds.length) {
          auditAction = AUDIT_ACTIONS.SESSION_CANDIDATES_UPDATED;
        } else if (assignmentChanges.addedIds.length) {
          auditAction = AUDIT_ACTIONS.SESSION_CANDIDATES_ASSIGNED;
        } else if (assignmentChanges.removedIds.length) {
          auditAction = AUDIT_ACTIONS.SESSION_CANDIDATES_REMOVED;
        }

        if (auditAction) {
          await logAuditEvent(auditAction, {
            userId: req.user._id,
            userRole: req.user.role,
            tenantId: session.tenantId,
            resourceType: 'ExamSession',
            resourceId: session._id,
            candidateAssignmentMode: assignmentMode,
            addedCandidateIds: assignmentChanges.addedIds,
            removedCandidateIds: assignmentChanges.removedIds,
            method: req.method,
            path: req.path,
          });
        }
      }

      await session.populate('examId', 'title duration showResultsImmediately resultsReleasedAt');
      await session.populate('questionPaperId', 'setName');
      await session.populate('questionPaperIds', 'setName');
      await session.populate('createdBy', 'name email');

      res.json({
        message: action === 'end' ? 'Session ended successfully' : 'Session updated successfully',
        session,
        assignedCandidateIds: assignmentChanges?.candidateIds,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Delete a session
router.delete(
  '/:sessionId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const session = await ExamSession.findById(req.params.sessionId).select(
        '_id examId tenantId'
      );
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Tenant safety guard
      if (
        req.user?.tenantId &&
        session.tenantId &&
        String(req.user.tenantId) !== String(session.tenantId)
      ) {
        return res.status(403).json({
          error: 'Forbidden - Session belongs to different tenant',
        });
      }

      // Check if user can manage sessions for this exam.
      const canCreateSession = await hasExamPermission(
        req.user._id,
        session.examId,
        'CREATE_SESSION'
      );
      if (
        !canCreateSession &&
        req.user.role !== 'SUPER_ADMIN' &&
        req.user.role !== 'EXAM_CREATOR'
      ) {
        return res.status(403).json({
          error: 'You do not have permission to delete this session',
        });
      }

      // Remove per-candidate paper assignments linked to this session.
      await SessionAssignment.deleteMany({ sessionId: session._id });

      await ExamSession.deleteOne({ _id: session._id });

      res.json({
        message: 'Session deleted successfully',
        sessionId: session._id,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Validate QR code
router.get('/validate/:qrCode', requireAuth, async (req, res, next) => {
  try {
    const { qrCode } = req.params;

    const session = await ExamSession.findOne({ qrCode })
      .populate('examId', 'title duration maxAttempts showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName');

    const validation = await validateSessionAvailability(session, req.user);
    if (!validation.valid) {
      return res.json({ valid: false, message: validation.message });
    }

    const canAttempt =
      req.user.role === 'CANDIDATE'
        ? await canCandidateAccessSession(req.user._id, session)
        : await hasExamPermission(req.user._id, session.examId._id, 'ATTEMPT_EXAM');
    if (!canAttempt) {
      return res.status(403).json({ error: 'You are not assigned to this session' });
    }

    let assignment = null;
    // Assign question paper if user can attempt.
    assignment = await assignQuestionPaperToStudent({
      session,
      userId: req.user._id,
    });

    res.json({
      valid: true,
      sessionId: session._id,
      session,
      manualToken: session.manualToken,
      assignment: assignment
        ? {
          questionPaperId: assignment.questionPaperId?._id || assignment.questionPaperId,
          setName: assignment.questionPaperId?.setName,
        }
        : null,
      message: 'QR code is valid',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/manual-token/:token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.params;

    const session = await ExamSession.findOne({ manualToken: token })
      .populate('examId', 'title duration maxAttempts showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName');

    const validation = await validateSessionAvailability(session, req.user);
    if (!validation.valid) {
      return res.json({ valid: false, message: validation.message });
    }

    const canAttempt =
      req.user.role === 'CANDIDATE'
        ? await canCandidateAccessSession(req.user._id, session)
        : await hasExamPermission(req.user._id, session.examId._id, 'ATTEMPT_EXAM');
    if (!canAttempt) {
      return res.status(403).json({ error: 'You are not assigned to this session' });
    }

    let assignment = null;
    // Assign question paper if user can attempt.
    assignment = await assignQuestionPaperToStudent({
      session,
      userId: req.user._id,
    });

    res.json({
      valid: true,
      sessionId: session._id,
      session,
      assignment: assignment
        ? {
          questionPaperId: assignment.questionPaperId?._id || assignment.questionPaperId,
          setName: assignment.questionPaperId?.setName,
        }
        : null,
      message: 'Manual token is valid',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
