import Enrollment from '../../models/academic/Enrollment.js';
import ExamParticipant from '../../models/ExamParticipant.js';
import User from '../../models/User.js';

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normalizeRoll = (value) => String(value || '').trim().replace(/^0+/, '') || '';

const legacyRollFromUser = (user = {}) => {
  const profile = user?.academicProfile || {};
  return String(profile.rollNumber || profile.rollNo || '').trim();
};

export const resolveParticipantRollNumber = (participant = {}, enrollment = null, user = null) => {
  const snapshotRoll = String(participant?.candidateIdentitySnapshot?.rollNumber || '').trim();
  if (snapshotRoll) return snapshotRoll;
  const enrollmentRoll = String(enrollment?.rollNumber || enrollment?.metadata?.rollNumber || '').trim();
  if (enrollmentRoll) return enrollmentRoll;
  return legacyRollFromUser(user);
};

export const buildExamRosterEntries = async ({ tenantId, examId }) => {
  const participants = await ExamParticipant.find({ examId, examRole: 'CANDIDATE' }).lean();
  if (!participants.length) return [];

  const userIds = participants.map((p) => p.userId);
  const enrollmentIds = participants
    .map((p) => p.candidateIdentitySnapshot?.enrollmentId)
    .filter(Boolean);

  const [users, enrollments] = await Promise.all([
    User.find({ _id: { $in: userIds }, tenantId }).select('name email academicProfile').lean(),
    enrollmentIds.length
      ? Enrollment.find({ _id: { $in: enrollmentIds }, tenantId }).lean()
      : Enrollment.find({ tenantId, userId: { $in: userIds }, status: 'ACTIVE' }).lean(),
  ]);

  const userById = new Map(users.map((u) => [String(u._id), u]));
  const enrollmentByUser = new Map();
  enrollments.forEach((enrollment) => {
    const key = String(enrollment.userId);
    if (!enrollmentByUser.has(key)) enrollmentByUser.set(key, enrollment);
  });

  return participants.map((participant) => {
    const user = userById.get(String(participant.userId)) || {};
    const enrollment = participant.candidateIdentitySnapshot?.enrollmentId
      ? enrollments.find((e) => String(e._id) === String(participant.candidateIdentitySnapshot.enrollmentId))
      : enrollmentByUser.get(String(participant.userId));
    const displayName = participant.candidateIdentitySnapshot?.displayName || user.name || '';
    const rollNumber = resolveParticipantRollNumber(participant, enrollment, user);
    const externalStudentId = participant.candidateIdentitySnapshot?.externalStudentId
      || enrollment?.externalStudentId
      || String(enrollment?.metadata?.externalStudentId || '').trim();
    return {
      participantId: participant._id,
      userId: participant.userId,
      displayName,
      normalizedName: normalize(displayName),
      rollNumber,
      normalizedRoll: normalizeRoll(rollNumber),
      externalStudentId: String(externalStudentId || '').trim(),
      enrollmentId: enrollment?._id || participant.candidateIdentitySnapshot?.enrollmentId || null,
      academicSectionId: enrollment?.academicSectionId || participant.candidateIdentitySnapshot?.academicSectionId || null,
      email: user.email || '',
    };
  });
};

export const captureCandidateIdentitySnapshot = async ({ tenantId, userId, examAcademicContext = {} }) => {
  const user = await User.findOne({ _id: userId, tenantId }).select('name email academicProfile').lean();
  if (!user) return null;

  let enrollment = null;
  const offering = examAcademicContext?.courseOfferingId
    ? await (await import('../../models/academic/CourseOffering.js')).default.findOne({
      _id: examAcademicContext.courseOfferingId,
      tenantId,
    }).lean()
    : null;

  if (offering) {
    enrollment = await Enrollment.findOne({
      tenantId,
      userId,
      academicSessionId: offering.academicSessionId,
      programId: offering.programId,
      status: 'ACTIVE',
      ...(offering.cohortId ? { cohortId: offering.cohortId } : {}),
      ...(offering.academicSectionId ? { academicSectionId: offering.academicSectionId } : {}),
    }).lean();
  } else {
    enrollment = await Enrollment.findOne({ tenantId, userId, status: 'ACTIVE' }).sort({ updatedAt: -1 }).lean();
  }

  return {
    displayName: user.name || '',
    rollNumber: resolveParticipantRollNumber({}, enrollment, user),
    externalStudentId: String(enrollment?.externalStudentId || enrollment?.metadata?.externalStudentId || '').trim(),
    enrollmentId: enrollment?._id || null,
    academicSectionId: enrollment?.academicSectionId || null,
    capturedAt: new Date(),
  };
};

export const applyIdentitySnapshotToParticipant = async (participant, snapshot) => {
  if (!participant || !snapshot) return participant;
  participant.candidateIdentitySnapshot = snapshot;
  await participant.save();
  return participant;
};
