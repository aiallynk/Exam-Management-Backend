import express from 'express';
import ExamSession from '../models/ExamSession.js';
import Exam from '../models/Exam.js';
import QuestionPaper from '../models/QuestionPaper.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { hasExamPermission, ensureExamParticipant } from '../middleware/examPermissions.js';
import { body, validationResult } from 'express-validator';
import { generateSessionQRCode } from '../services/qrService.js';
import { assignQuestionPaperToStudent } from '../services/sessionAssignment.js';

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

  // Universal: Check if user is blocked (changed from blocked_student_ to blocked_user_)
  const SystemConfig = (await import('../models/SystemConfig.js')).default;
  const blockedConfig = await SystemConfig.findOne({
    key: `blocked_user_${user._id}`, // Universal: changed from blocked_student_
  });

  if (blockedConfig && blockedConfig.value === 'true') {
    return { valid: false, message: 'Your account has been blocked' };
  }

  return { valid: true };
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
      // Regular users: check exam permissions
      const ExamParticipant = (await import('../models/ExamParticipant.js')).default;
      const participants = await ExamParticipant.find({ userId: req.user._id })
        .select('examId examRole')
        .lean();
      
      const examIds = participants.map(p => p.examId);
      
      if (examIds.length > 0) {
        filter.examId = { $in: examIds };
        // Candidates only see active sessions they can attempt
        const candidateExamIds = participants
          .filter(p => p.examRole === 'CANDIDATE')
          .map(p => p.examId);
        if (candidateExamIds.length > 0 && examIds.every(id => candidateExamIds.includes(id))) {
          filter.isActive = true;
          const now = new Date();
          filter.startTime = { $lte: now };
          filter.endTime = { $gte: now };
        }
      } else {
        // User has no exam roles, return empty
        filter.examId = { $in: [] };
      }
    }

    const sessions = await ExamSession.find(filter)
      .populate('examId', 'title duration showResultsImmediately resultsReleasedAt')
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await ExamSession.countDocuments(filter);

    res.json({
      sessions,
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

// Get single session
router.get('/:sessionId', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const session = await ExamSession.findById(req.params.sessionId)
      .populate(
        'examId',
        'title description duration gracePeriod maxAttempts showResultsImmediately resultsReleasedAt'
      )
      .populate('questionPaperId', 'setName')
      .populate('questionPaperIds', 'setName')
      .populate('createdBy', 'name email');

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Universal: Check exam permissions
    const canAttempt = await hasExamPermission(req.user._id, session.examId._id, 'ATTEMPT_EXAM');
    const canCreateSession = await hasExamPermission(req.user._id, session.examId._id, 'CREATE_SESSION');
    
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
      assignment = {
        questionPaperId: result.questionPaperId?._id || result.questionPaperId,
        setName: result.questionPaperId?.setName,
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
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can create sessions
  [
    body('examId').notEmpty().withMessage('Exam ID is required'),
    body('questionPaperId').optional().isMongoId(),
    body('questionPaperIds').optional().isArray({ min: 1 }),
    body('questionPaperIds.*').optional().isMongoId(),
    body('distributionMode')
      .optional()
      .isIn(['single', 'random', 'sequential', 'roll', 'manual']),
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
        // Inherit tenant ID from exam
        tenantId: tenantId,
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
      await session.populate(
        'examId',
        'title duration showResultsImmediately resultsReleasedAt'
      );
      await session.populate('questionPaperId', 'setName');
      await session.populate('questionPaperIds', 'setName');

      res.status(201).json({
        session,
        qrImage,
        manualToken,
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

    // UNIVERSAL: Check exam permission and create ExamParticipant if needed
    const canAttempt = await hasExamPermission(req.user._id, session.examId._id, 'ATTEMPT_EXAM');
    if (!canAttempt) {
      // User doesn't have permission yet - create ExamParticipant with CANDIDATE role
      // This happens when user scans QR or enters token
      await ensureExamParticipant(
        req.user._id,
        session.examId._id,
        'CANDIDATE',
        req.user._id
      );
    }

    let assignment = null;
    // Assign question paper if user can attempt (now they have CANDIDATE role)
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

    // UNIVERSAL: Check exam permission and create ExamParticipant if needed
    const canAttempt = await hasExamPermission(req.user._id, session.examId._id, 'ATTEMPT_EXAM');
    if (!canAttempt) {
      // User doesn't have permission yet - create ExamParticipant with CANDIDATE role
      // This happens when user scans QR or enters token
      await ensureExamParticipant(
        req.user._id,
        session.examId._id,
        'CANDIDATE',
        req.user._id
      );
    }

    let assignment = null;
    // Assign question paper if user can attempt (now they have CANDIDATE role)
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

