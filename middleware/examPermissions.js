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

    // Check ExamParticipant permissions
    const participant = await ExamParticipant.findOne({
      examId,
      userId,
    });

    if (!participant) {
      return false;
    }

    // Check specific permission
    const permissionKey = permission.toUpperCase();
    return participant.permissions[permissionKey] === true;
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

