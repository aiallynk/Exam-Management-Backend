import Notification from '../models/Notification.js';

const normalizeRoles = (roles) => {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => String(role || '').trim().toUpperCase())
    .filter(Boolean);
};

const toIdString = (value) => (value ? String(value) : null);

export const createNotification = async (payload = {}) => {
  try {
    const roles = normalizeRoles(payload.roles);
    const notification = await Notification.create({
      title: String(payload.title || '').trim(),
      message: String(payload.message || '').trim(),
      type: String(payload.type || '').trim(),
      roles,
      userId: payload.userId || null,
      tenantId: payload.tenantId || null,
      examId: payload.examId || null,
      sessionId: payload.sessionId || null,
      attemptId: payload.attemptId || null,
      createdBy: payload.createdBy || null,
      metadata: payload.metadata || null,
    });
    return notification;
  } catch (error) {
    console.error('[NOTIFICATIONS] Failed to create notification:', error?.message || error);
    return null;
  }
};

export const createRoleNotification = async (payload = {}) =>
  createNotification(payload);

export const createUserNotification = async (payload = {}) =>
  createNotification(payload);

export const createUserNotifications = async ({ userIds = [], ...payload } = {}) => {
  const roles = normalizeRoles(payload.roles);
  const uniqueUserIds = Array.from(
    new Set(
      (Array.isArray(userIds) ? userIds : [])
        .map((id) => toIdString(id))
        .filter(Boolean)
    )
  );

  if (uniqueUserIds.length === 0) {
    return [];
  }

  const docs = uniqueUserIds.map((userId) => ({
    title: String(payload.title || '').trim(),
    message: String(payload.message || '').trim(),
    type: String(payload.type || '').trim(),
    roles,
    userId,
    tenantId: payload.tenantId || null,
    examId: payload.examId || null,
    sessionId: payload.sessionId || null,
    attemptId: payload.attemptId || null,
    createdBy: payload.createdBy || null,
    metadata: payload.metadata || null,
  }));

  try {
    return await Notification.insertMany(docs, { ordered: false });
  } catch (error) {
    console.error('[NOTIFICATIONS] Failed to bulk create notifications:', error?.message || error);
    return [];
  }
};
