export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden - Insufficient permissions',
        required: allowedRoles,
        current: req.user.role,
      });
    }

    next();
  };
};

export const requireOwnershipOrAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admin can access everything
    if (req.user.role === 'ADMIN') {
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

      if (exam.createdBy.toString() !== req.user._id.toString()) {
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

