import { hasAnyRole } from './userRoles.js';

const id = (value) => (value == null ? '' : String(value));

const OPERATING_STAFF_ROLES = ['EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER'];

/**
 * Exam ownership for intake/operations. createdBy must authorize the
 * person who owns the assessment even when they are Academic Admin or
 * Teacher rather than Exam Creator. Navigation workspace is not
 * authorization — see Blueprint §14.
 */
export const isStaffExamOwner = (user, exam) => {
  if (!user || !exam) return false;
  if (id(user.tenantId) !== id(exam.tenantId)) return false;
  if (!hasAnyRole(user, OPERATING_STAFF_ROLES)) return false;
  return id(exam.createdBy) === id(user._id);
};

export { OPERATING_STAFF_ROLES };
