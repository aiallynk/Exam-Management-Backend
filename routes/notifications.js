import express from 'express';
import Notification from '../models/Notification.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

const normalizeRole = (role) => String(role || '').trim().toUpperCase();

const buildAccessFilter = (user) => {
  const role = normalizeRole(user?.role);
  const tenantId = user?.tenantId || null;

  const or = [{ userId: user._id }];

  if (role === 'SUPER_ADMIN') {
    or.push({ roles: 'SUPER_ADMIN' });
  } else if (role) {
    const tenantScope = [];
    if (tenantId) {
      tenantScope.push({ tenantId });
    }
    tenantScope.push({ tenantId: null });

    or.push({
      roles: role,
      ...(tenantScope.length > 0 ? { $or: tenantScope } : {}),
    });
  }

  return { $or: or };
};

const mapNotification = (notification, userId) => {
  const readBy = Array.isArray(notification.readBy) ? notification.readBy : [];
  const isRead = readBy.some((id) => String(id) === String(userId));
  return {
    id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    timestamp: notification.createdAt,
    read: isRead,
    tenantId: notification.tenantId || null,
    examId: notification.examId || null,
    sessionId: notification.sessionId || null,
    attemptId: notification.attemptId || null,
    createdBy: notification.createdBy || null,
    metadata: notification.metadata || null,
  };
};

router.get('/', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const resolvedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const resolvedPage = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (resolvedPage - 1) * resolvedLimit;

    const filter = buildAccessFilter(req.user);

    if (status === 'read') {
      filter.readBy = req.user._id;
    } else if (status === 'unread') {
      filter.readBy = { $ne: req.user._id };
    }

    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(resolvedLimit),
      Notification.countDocuments(filter),
    ]);

    res.json({
      notifications: items.map((item) => mapNotification(item, req.user._id)),
      pagination: {
        page: resolvedPage,
        limit: resolvedLimit,
        total,
        pages: Math.ceil(total / resolvedLimit),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:notificationId/read', async (req, res, next) => {
  try {
    const { notificationId } = req.params;
    const filter = {
      _id: notificationId,
      ...buildAccessFilter(req.user),
    };

    const notification = await Notification.findOne(filter);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (!notification.readBy) {
      notification.readBy = [];
    }

    const alreadyRead = notification.readBy.some(
      (id) => String(id) === String(req.user._id)
    );
    if (!alreadyRead) {
      notification.readBy.push(req.user._id);
      await notification.save();
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const filter = buildAccessFilter(req.user);
    await Notification.updateMany(filter, {
      $addToSet: { readBy: req.user._id },
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
