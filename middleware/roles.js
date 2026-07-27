import { hasAnyRole, normalizeRoles } from '../utils/userRoles.js';

/**
 * Role-Based Access Control Middleware
 *
 * Supports 5 roles: SUPER_ADMIN, TENANT_ADMIN, EXAM_CREATOR, CANDIDATE,
 * EVALUATOR. A user may hold more than one role (e.g. an EXAM_CREATOR who is
 * additionally an EVALUATOR) — matching is against the user's full role set
 * (req.user.roles, falling back to [req.user.role] for legacy tokens/users),
 * not just their single primary `role`. This means every existing
 * `requireRole('X', 'Y')` call site keeps working unchanged for
 * single-role users, and additionally now also matches multi-role users.
 *
 * For exam-level permissions, use examPermissions.js middleware instead.
 */
export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // SUPER_ADMIN can access everything
    if (normalizeRoles(req.user).includes('SUPER_ADMIN')) {
      return next();
    }

    if (!hasAnyRole(req.user, allowedRoles)) {
      return res.status(403).json({
        error: 'Forbidden - Insufficient permissions',
        required: allowedRoles,
        current: req.user.role,
        currentRoles: normalizeRoles(req.user),
      });
    }

    next();
  };
};

// Array-accepting variant of requireRole, matching the naming used in the
// evaluator-role correction spec (`requireAnyRole(['A', 'B'])`).
export const requireAnyRole = (allowedRoles = []) => requireRole(...allowedRoles);

// Convenience middleware for SUPER_ADMIN-only routes
export const superAdminOnly = requireRole('SUPER_ADMIN');

/**
 * Check if user owns the resource or has admin privileges
 * SUPER_ADMIN, TENANT_ADMIN, or EXAM_CREATOR in same tenant
 * 
 * For exam-level permissions, prefer using examPermissions.js middleware
 */
export const requireOwnershipOrAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role;

    // SUPER_ADMIN can access everything
    if (userRole === 'SUPER_ADMIN') {
      return next();
    }

    // TENANT_ADMIN can access everything in their tenant
    if (userRole === 'TENANT_ADMIN') {
      return next();
    }

    // EXAM_CREATOR can access everything in their tenant
    if (userRole === 'EXAM_CREATOR') {
      return next();
    }

    // For exam-related routes, check exam-level permissions or ownership
    const examId = req.params.examId || req.body.examId;
    if (examId) {
      const Exam = (await import('../models/Exam.js')).default;
      const { hasExamPermission } = await import('./examPermissions.js');
      
      const exam = await Exam.findById(examId);
      
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check tenant boundaries
      const userTenantId = req.user.tenantId;
      const examTenantId = exam.tenantId;
      
      if (userTenantId && examTenantId) {
        if (userTenantId.toString() !== examTenantId.toString()) {
          return res.status(403).json({
            error: 'Forbidden - Exam belongs to different tenant',
          });
        }
      }

      // Check if user is exam creator (has CREATOR role) or has appropriate permissions
      const isCreator = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION');
      if (!isCreator && exam.createdBy.toString() !== req.user._id.toString()) {
        // User is not creator and doesn't have CREATE_SESSION permission
        // Allow if they have other relevant permissions (VIEW_RESULTS, etc.)
        const hasViewResults = await hasExamPermission(req.user._id, examId, 'VIEW_RESULTS');
        if (!hasViewResults) {
          return res.status(403).json({
            error: 'Forbidden - You do not have permission to modify this exam',
          });
        }
      }
    }

    next();
  } catch (error) {
    console.error('requireOwnershipOrAdmin error:', error);
    return res.status(500).json({ error: 'Authorization error' });
  }
};

