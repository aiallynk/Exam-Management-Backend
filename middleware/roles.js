import { hasAnyRole, normalizeRoles } from '../utils/userRoles.js';

/**
 * Role-Based Access Control Middleware
 *
 * Supports the canonical product personas. A user may hold more than one
 * role (e.g. a TEACHER who is also EXAM_CREATOR and EVALUATOR) — matching is
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
 * Explicit SUPER_ADMIN platform bypass, otherwise exam ownership/permission.
 * 
 * For exam-level permissions, prefer using examPermissions.js middleware
 */
export const requireOwnershipOrAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRoles = normalizeRoles(req.user);

    // SUPER_ADMIN can access everything
    if (userRoles.includes('SUPER_ADMIN')) {
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

      // Exam Creator is an ownership/explicit-permission role, not a tenant-
      // wide bypass. Tenant Admin is monitoring/governance only unless the
      // same user separately holds an operational role/participant grant.
      const isCreator = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION');
      if (!isCreator && exam.createdBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          error: 'Forbidden - Only the exam owner or an explicit session creator can modify this exam',
        });
      }
    }

    next();
  } catch (error) {
    console.error('requireOwnershipOrAdmin error:', error);
    return res.status(500).json({ error: 'Authorization error' });
  }
};
