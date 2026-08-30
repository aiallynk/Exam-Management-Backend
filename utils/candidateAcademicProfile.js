const trim = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

/**
 * Optional candidate identity stored on User.academicProfile.
 * Enrollment remains the academic placement source of truth; this is
 * lightweight roster/intake metadata only. Junior Exam grade 1–7,
 * class, and division are no longer the product shape.
 */
export function normalizeCandidateAcademicProfile(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rollNumber = trim(source.rollNumber || source.rollNo);
  const grade = trim(source.grade ?? source.gradeLevel);
  const section = trim(source.section || source.division || source.className);
  const externalStudentId = trim(source.externalStudentId || source.studentId);
  const parsedGrade = Number(grade);
  const gradeLevel = Number.isInteger(parsedGrade) && parsedGrade > 0 ? parsedGrade : null;

  return {
    rollNumber,
    grade,
    section,
    externalStudentId,
    ...(gradeLevel != null ? { gradeLevel } : {}),
  };
}

export function hasCandidateAcademicProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return Boolean(
    trim(profile.rollNumber)
    || trim(profile.grade)
    || trim(profile.section)
    || trim(profile.externalStudentId)
  );
}
