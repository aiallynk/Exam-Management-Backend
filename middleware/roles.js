/**
 * Role-based access control middleware
 * Supports both new roles (SUPER_ADMIN, ORG_ADMIN, etc.) and legacy roles (ADMIN, DESIGNER)
 */
export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role;

    // Map legacy roles to new roles for backward compatibility
    const roleMapping = {
      'ADMIN': 'INSTITUTE_ADMIN', // Legacy ADMIN -> INSTITUTE_ADMIN
      'DESIGNER': 'TEACHER', // Legacy DESIGNER -> TEACHER
    };

    const mappedRole = roleMapping[userRole] || userRole;

    // Check if user's role (or mapped role) is in allowed roles
    const isAllowed = allowedRoles.includes(userRole) || allowedRoles.includes(mappedRole);

    // Special case: SUPER_ADMIN can access everything
    if (userRole === 'SUPER_ADMIN') {
      return next();
    }

    if (!isAllowed) {
      return res.status(403).json({
        error: 'Forbidden - Insufficient permissions',
        required: allowedRoles,
        current: userRole,
      });
    }

    next();
  };
};

/**
 * Check if user owns the resource or has admin privileges
 * Updated for multi-tenant architecture
 */
export const requireOwnershipOrAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role;

    // SUPER_ADMIN, ORG_ADMIN can access everything (within their scope)
    if (['SUPER_ADMIN', 'ORG_ADMIN'].includes(userRole)) {
      return next();
    }

    // INSTITUTE_ADMIN can access everything in their institute
    if (userRole === 'INSTITUTE_ADMIN') {
      return next();
    }

    // For exam-related routes, check if user created the exam
    const examId = req.params.examId || req.body.examId;
    if (examId) {
      const Exam = (await import('../models/Exam.js')).default;
      const exam = await Exam.findById(examId);
      
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check tenant boundaries
      if (userRole !== 'SUPER_ADMIN') {
        if (exam.organizationId && req.user.organizationId) {
          if (exam.organizationId.toString() !== req.user.organizationId.toString()) {
            return res.status(403).json({
              error: 'Forbidden - Exam belongs to different organization',
            });
          }
        }

        if (exam.instituteId && req.user.instituteId) {
          if (exam.instituteId.toString() !== req.user.instituteId.toString()) {
            return res.status(403).json({
              error: 'Forbidden - Exam belongs to different institute',
            });
          }
        }
      }

      // TEACHER can only modify their own exams
      if (userRole === 'TEACHER' && exam.createdBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          error: 'Forbidden - You can only modify your own exams',
        });
      }
    }

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Authorization error' });
  }
};

