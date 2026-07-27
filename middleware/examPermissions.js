/**
 * Exam-Level Permission Middleware
 * 
 * Universal exam-context permission system that replaces role-based assumptions.
 * Permissions are checked at the exam level, not user role level.
 * 
 * This enables:
 * - A user can create Exam A (CREATOR)
 * - The same user can attempt Exam B (CANDIDATE)
 * - The same user can evaluate Exam C (EVALUATOR)
 * 
 * All based on exam context, not global user role.
 */

import ExamParticipant from '../models/ExamParticipant.js';
import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import SessionAssignment from '../models/SessionAssignment.js';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import User from '../models/User.js';
import { resolveTenantFeature } from '../services/tenantFeatureService.js';
import { hasRole } from '../utils/userRoles.js';

const normalizeId = (value) => String(value || '').trim();

const getCandidateAssignmentCount = async (examId) =>
  ExamParticipant.countDocuments({
    examId,
    examRole: 'CANDIDATE',
  });

export const isExamPublicForCandidates = async (examId) => {
  try {
    return (await getCandidateAssignmentCount(examId)) === 0;
  } catch (error) {
    console.error('isExamPublicForCandidates error:', error);
    return false;
  }
};

export const isCandidateAssignedToExam = async (userId, examId) => {
  try {
    const participant = await ExamParticipant.findOne({
      examId,
      userId,
      examRole: 'CANDIDATE',
    })
      .select('_id')
      .lean();
    return Boolean(participant);
  } catch (error) {
    console.error('isCandidateAssignedToExam error:', error);
    return false;
  }
};

export const canCandidateAccessExam = async (userId, examId) => {
  try {
    const User = (await import('../models/User.js')).default;
    const [user, exam, publicExam, assigned] = await Promise.all([
      User.findById(userId).select('role tenantId').lean(),
      Exam.findById(examId).select('tenantId isActive').lean(),
      isExamPublicForCandidates(examId),
      isCandidateAssignedToExam(userId, examId),
    ]);

    if (!user || !exam) {
      return false;
    }

    if (user.role !== 'CANDIDATE') {
      return false;
    }

    const userTenantId = normalizeId(user.tenantId);
    const examTenantId = normalizeId(exam.tenantId);
    if (!userTenantId || !examTenantId || userTenantId !== examTenantId) {
      return false;
    }

    return publicExam || assigned;
  } catch (error) {
    console.error('canCandidateAccessExam error:', error);
    return false;
  }
};

export const canCandidateAccessSession = async (userId, sessionOrId) => {
  try {
    const suppliedSessionHasAccessFields =
      typeof sessionOrId === 'object' &&
      sessionOrId?.examId &&
      sessionOrId?.assignAllCandidates !== undefined;
    const session =
      suppliedSessionHasAccessFields
        ? sessionOrId
        : await ExamSession.findById(sessionOrId?._id || sessionOrId)
            .select('examId tenantId assignAllCandidates')
            .lean();

    if (!session) {
      return false;
    }

    const User = (await import('../models/User.js')).default;
    const examId = session.examId?._id || session.examId;
    const [canAccessExam, user, exam] = await Promise.all([
      canCandidateAccessExam(userId, examId),
      User.findById(userId).select('tenantId').lean(),
      Exam.findById(examId).select('tenantId').lean(),
    ]);
    if (!canAccessExam) {
      return false;
    }
    const sessionTenantId = session.tenantId || exam?.tenantId;
    if (
      !user?.tenantId ||
      !sessionTenantId ||
      normalizeId(user.tenantId) !== normalizeId(sessionTenantId) ||
      (session.tenantId &&
        exam?.tenantId &&
        normalizeId(session.tenantId) !== normalizeId(exam.tenantId))
    ) {
      return false;
    }

    if (session.assignAllCandidates !== false) {
      return true;
    }

    const assignment = await SessionAssignment.findOne({
      sessionId: session._id,
      userId,
      grantsAccess: true,
    })
      .select('_id')
      .lean();

    return Boolean(assignment);
  } catch (error) {
    console.error('canCandidateAccessSession error:', error);
    return false;
  }
};

/**
 * Check if user has a specific exam role
 * @param {string} examRole - CREATOR, CANDIDATE, or EVALUATOR
 * @returns {Function} Express middleware
 */
export const requireExamRole = (examRole) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const examId = req.params.examId || req.body.examId || req.query.examId;
      if (!examId) {
        return res.status(400).json({ error: 'Exam ID is required' });
      }

      // SUPER_ADMIN can access everything
      if (req.user.role === 'SUPER_ADMIN') {
        return next();
      }

      // EXAM_CREATOR can access all exams in their tenant
      if (req.user.role === 'EXAM_CREATOR') {
        const exam = await Exam.findById(examId).select('tenantId');
        if (!exam) {
          return res.status(404).json({ error: 'Exam not found' });
        }

        const userTenantId = req.user.tenantId;
        const examTenantId = exam.tenantId;

        if (userTenantId && examTenantId && userTenantId.toString() === examTenantId.toString()) {
          return next();
        }
      }

      // Check ExamParticipant for this user and exam
      const participant = await ExamParticipant.findOne({
        examId,
        userId: req.user._id,
        examRole,
      });

      if (!participant) {
        return res.status(403).json({
          error: `You do not have the required exam role: ${examRole}`,
          required: examRole,
        });
      }

      // Attach participant info to request for use in route handlers
      req.examParticipant = participant;

      next();
    } catch (error) {
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

/**
 * Check if user has a specific exam permission
 * @param {string} permission - CREATE_SESSION, VIEW_RESULTS, ATTEMPT_EXAM, REVIEW_ANSWERS
 * @returns {Function} Express middleware
 */
export const requireExamPermission = (permission) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const examId = req.params.examId || req.body.examId || req.query.examId || req.params.sessionId 
        ? (await import('../models/ExamSession.js')).default.findById(req.params.sessionId).then(s => s?.examId)
        : null;
      
      // Handle async examId from sessionId
      let resolvedExamId = examId;
      if (examId && typeof examId.then === 'function') {
        resolvedExamId = await examId;
      }

      if (!resolvedExamId) {
        return res.status(400).json({ error: 'Exam ID is required' });
      }

      // Check if user has permission
      const hasPermission = await hasExamPermission(req.user._id, resolvedExamId, permission);

      if (!hasPermission) {
        return res.status(403).json({
          error: `You do not have the required permission: ${permission}`,
          required: permission,
        });
      }

      next();
    } catch (error) {
      console.error('Permission check error:', error);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

/**
 * Utility function to check if user has exam permission
 * @param {ObjectId|string} userId - User ID
 * @param {ObjectId|string} examId - Exam ID
 * @param {string} permission - Permission name
 * @returns {Promise<boolean>} True if user has permission
 */
export const hasExamPermission = async (userId, examId, permission) => {
  try {
    // SUPER_ADMIN has all permissions
    const User = (await import('../models/User.js')).default;
    const user = await User.findById(userId).select('role tenantId');
    if (user && user.role === 'SUPER_ADMIN') {
      return true;
    }

    // EXAM_CREATOR has all permissions for exams in their tenant
    if (user && user.role === 'EXAM_CREATOR') {
      const exam = await Exam.findById(examId).select('tenantId');
      if (!exam) return false;

      const userTenantId = user.tenantId;
      const examTenantId = exam.tenantId;

      if (userTenantId && examTenantId && userTenantId.toString() === examTenantId.toString()) {
        return true;
      }
    }

    const permissionKey = String(permission || '').toUpperCase();

    if (permissionKey === 'ATTEMPT_EXAM') {
      return await canCandidateAccessExam(userId, examId);
    }

    // A user can hold multiple ExamParticipant docs for the same exam (one per
    // examRole, enforced by the {examId,userId,examRole} unique index) — e.g.
    // EVALUATOR and MODERATOR simultaneously. Check every role doc the user
    // holds for this exam and grant the permission if ANY of them allow it,
    // rather than picking whichever doc Mongo happens to return first.
    const participants = await ExamParticipant.find({
      examId,
      userId,
    }).select('permissions');

    if (!participants.length) {
      return false;
    }

    return participants.some((participant) => participant.permissions?.[permissionKey] === true);
  } catch (error) {
    console.error('hasExamPermission error:', error);
    return false;
  }
};

/**
 * Utility function to get user's exam role for a specific exam
 * @param {ObjectId|string} userId - User ID
 * @param {ObjectId|string} examId - Exam ID
 * @returns {Promise<string|null>} Exam role or null
 */
export const getExamRole = async (userId, examId) => {
  try {
    const participant = await ExamParticipant.findOne({
      examId,
      userId,
    }).select('examRole');

    return participant ? participant.examRole : null;
  } catch (error) {
    console.error('getExamRole error:', error);
    return null;
  }
};

/**
 * Utility function to ensure ExamParticipant exists with specified role
 * Creates if doesn't exist, updates if exists with different role
 * @param {ObjectId|string} userId - User ID
 * @param {ObjectId|string} examId - Exam ID
 * @param {string} examRole - CREATOR, CANDIDATE, or EVALUATOR
 * @param {ObjectId|string} assignedBy - User who assigned this role
 * @returns {Promise<ExamParticipant>} ExamParticipant document
 */
export const ensureExamParticipant = async (userId, examId, examRole, assignedBy = null) => {
  try {
    // Get exam to inherit tenant info
    const exam = await Exam.findById(examId).select('tenantId');
    if (!exam) {
      throw new Error('Exam not found');
    }

    // Check if participant already exists
    let participant = await ExamParticipant.findOne({
      examId,
      userId,
      examRole,
    });

    if (participant) {
      participant.__assigned = false;
      return participant;
    }

    // Check if user has different role for this exam
    const existingParticipant = await ExamParticipant.findOne({
      examId,
      userId,
    });

    if (existingParticipant) {
      // CRITICAL: Don't overwrite CREATOR role with CANDIDATE
      // If user is CREATOR, they should keep CREATOR role (with ATTEMPT_EXAM: false by default)
      // If they need to attempt, they can be explicitly granted CANDIDATE role separately
      // OR we can allow CREATOR to have ATTEMPT_EXAM: true if needed
      if (existingParticipant.examRole === 'CREATOR' && examRole === 'CANDIDATE') {
        // Creator trying to become candidate - preserve CREATOR but allow attempt if explicitly granted
        // For now, return existing CREATOR participant (they can't attempt unless ATTEMPT_EXAM is explicitly set to true)
        // TODO: Consider allowing multiple roles or explicit permission override
        existingParticipant.__assigned = false;
        return existingParticipant;
      }
      
      // Update role if different (but not CREATOR → CANDIDATE)
      if (existingParticipant.examRole !== examRole) {
        existingParticipant.examRole = examRole;
        existingParticipant.assignedAt = new Date();
        if (assignedBy) {
          existingParticipant.assignedBy = assignedBy;
        }
        await existingParticipant.save();
        existingParticipant.__assigned = true;
        return existingParticipant;
      }
      existingParticipant.__assigned = false;
      return existingParticipant;
    }

    // Create new participant
    participant = new ExamParticipant({
      examId,
      userId,
      examRole,
      assignedBy: assignedBy || userId,
      tenantId: exam.tenantId || null,
    });

    await participant.save();
    participant.__assigned = true;
    return participant;
  } catch (error) {
    console.error('ensureExamParticipant error:', error);
    throw error;
  }
};

/**
 * Find the ExaminerAssignment (if any) that grants `userId` access to a given
 * evaluation scope within `examId` right now — active, not expired/revoked,
 * and matching the requested section/question/attempt.
 * @param {ObjectId|string} userId
 * @param {ObjectId|string} examId
 * @param {{sectionId?, questionId?, attemptId?}} scope - what's being accessed
 * @returns {Promise<ExaminerAssignment|null>}
 */
export const hasActiveExaminerAssignment = async (userId, examId, scope = {}) => {
  try {
    const now = new Date();
    const assignments = await ExaminerAssignment.find({
      examId,
      examinerId: userId,
      status: 'ACTIVE',
      accessStartsAt: { $lte: now },
      $or: [{ accessExpiresAt: { $exists: false } }, { accessExpiresAt: null }, { accessExpiresAt: { $gte: now } }],
    });

    if (!assignments.length) return null;
    const evaluatorReview = await resolveTenantFeature(assignments[0].tenantId, 'EVALUATOR_REVIEW');
    if (!evaluatorReview?.effectiveEnabled) return null;

    const { sectionId, questionId, attemptId } = scope;

    return (
      assignments.find((assignment) => {
        switch (assignment.scopeType) {
          case 'FULL_EXAM':
            return true;
          case 'SECTION':
            return Boolean(sectionId) && (assignment.scopeData?.sectionIds || [])
              .map(normalizeId)
              .includes(normalizeId(sectionId));
          case 'QUESTIONS':
            return Boolean(questionId) && (assignment.scopeData?.questionIds || [])
              .map(normalizeId)
              .includes(normalizeId(questionId));
          case 'ATTEMPTS':
            return Boolean(attemptId) && (assignment.scopeData?.attemptIds || [])
              .map(normalizeId)
              .includes(normalizeId(attemptId));
          default:
            return false;
        }
      }) || null
    );
  } catch (error) {
    console.error('hasActiveExaminerAssignment error:', error);
    return null;
  }
};

/**
 * Express middleware for the evaluator workspace's entry points (assignment
 * list, per-assignment attempt list). Gates on the full chain the correction
 * spec requires — not just `evaluatorAccess.enabled`, which alone used to be
 * treated as sufficient:
 *
 *   user has EVALUATOR in their effective roles
 *   AND account is active
 *   AND evaluatorAccess is enabled and unexpired
 *   AND EVALUATOR_REVIEW is effectively enabled for the tenant
 *
 * Deliberately does NOT check for a specific assignment — that is exam/
 * scope-specific and stays the job of hasActiveExaminerAssignment /
 * requireExaminerAssignment. This only answers "is this person currently
 * allowed to be an evaluator at all".
 */
export const requireEvaluatorAccess = () => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!hasRole(req.user, 'EVALUATOR')) {
        return res.status(403).json({ error: 'Evaluator role required' });
      }

      const user = await User.findById(req.user._id).select('status evaluatorAccess tenantId');
      if (!user || (user.status && user.status !== 'ACTIVE')) {
        return res.status(403).json({ error: 'Account is not active' });
      }
      if (!user.evaluatorAccess?.enabled) {
        return res.status(403).json({ error: 'Evaluator access is disabled for this account' });
      }
      if (user.evaluatorAccess.accessExpiresAt && new Date(user.evaluatorAccess.accessExpiresAt) < new Date()) {
        return res.status(403).json({
          error: 'Evaluator access has expired',
          expiredAt: user.evaluatorAccess.accessExpiresAt,
        });
      }

      const feature = await resolveTenantFeature(user.tenantId || req.user.tenantId, 'EVALUATOR_REVIEW');
      if (!feature?.effectiveEnabled) {
        return res.status(403).json({ error: 'Evaluator Review is not enabled for this tenant' });
      }

      next();
    } catch (error) {
      console.error('requireEvaluatorAccess error:', error);
      return res.status(500).json({ error: 'Authorization error' });
    }
  };
};

/**
 * Express middleware: requires an active ExaminerAssignment covering the
 * scope implied by the request (examId + optional sectionId/questionId/
 * attemptId in params/body/query). Attaches the matching assignment to
 * `req.examinerAssignment` for handlers to read capability flags from.
 * SUPER_ADMIN/TENANT_ADMIN/EXAM_CREATOR (within their tenant) always pass,
 * matching the existing exam-permission bypass convention.
 */
export const requireExaminerAssignment = () => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const examId = req.params.examId || req.body.examId || req.query.examId;
      if (!examId) {
        return res.status(400).json({ error: 'Exam ID is required' });
      }

      if (req.user.role === 'SUPER_ADMIN') {
        return next();
      }

      if (req.user.role === 'EXAM_CREATOR' || req.user.role === 'TENANT_ADMIN') {
        const exam = await Exam.findById(examId).select('tenantId');
        if (exam && req.user.tenantId && exam.tenantId && String(req.user.tenantId) === String(exam.tenantId)) {
          return next();
        }
      }

      const scope = {
        sectionId: req.params.sectionId || req.body.sectionId || req.query.sectionId,
        questionId: req.params.questionId || req.body.questionId || req.query.questionId,
        attemptId: req.params.attemptId || req.body.attemptId || req.query.attemptId,
      };

      const assignment = await hasActiveExaminerAssignment(req.user._id, examId, scope);
      if (!assignment) {
        return res.status(403).json({
          error: 'You do not have an active examiner assignment covering this evaluation.',
        });
      }

      req.examinerAssignment = assignment;
      next();
    } catch (error) {
      console.error('requireExaminerAssignment error:', error);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
};
