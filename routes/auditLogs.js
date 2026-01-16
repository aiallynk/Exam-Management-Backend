import express from 'express';
import AuditLog from '../models/AuditLog.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { sanitizePagination } from '../middleware/validation.js';

const router = express.Router();

// Get audit logs (admin only)
router.get(
  '/',
  requireAuth,
  requireTenant,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  sanitizePagination,
  async (req, res, next) => {
    try {
      const { page, limit, action, userId, resourceType, resourceId, startDate, endDate } = req.query;
      const skip = (page - 1) * limit;

      const filter = { ...req.tenantFilter };

      if (action) {
        filter.action = action;
      }

      if (userId) {
        filter.userId = userId;
      }

      if (resourceType) {
        filter.resourceType = resourceType;
      }

      if (resourceId) {
        filter.resourceId = resourceId;
      }

      if (startDate || endDate) {
        filter.timestamp = {};
        if (startDate) {
          filter.timestamp.$gte = new Date(startDate);
        }
        if (endDate) {
          filter.timestamp.$lte = new Date(endDate);
        }
      }

      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('userId', 'name email')
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit),
        AuditLog.countDocuments(filter),
      ]);

      res.json({
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get audit log by ID
router.get('/:id', requireAuth, requireRole('SUPER_ADMIN', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const log = await AuditLog.findById(req.params.id).populate('userId', 'name email');
    if (!log) {
      return res.status(404).json({ error: 'Audit log not found' });
    }
    res.json({ log });
  } catch (error) {
    next(error);
  }
});

// Get audit logs for specific resource
router.get(
  '/resource/:resourceType/:resourceId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  sanitizePagination,
  async (req, res, next) => {
    try {
      const { page, limit } = req.query;
      const skip = (page - 1) * limit;

      const filter = {
        resourceType: req.params.resourceType,
        resourceId: req.params.resourceId,
      };

      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('userId', 'name email')
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit),
        AuditLog.countDocuments(filter),
      ]);

      res.json({
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get audit logs for user
router.get(
  '/user/:userId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  sanitizePagination,
  async (req, res, next) => {
    try {
      const { page, limit } = req.query;
      const skip = (page - 1) * limit;

      const filter = {
        userId: req.params.userId,
      };

      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('userId', 'name email')
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit),
        AuditLog.countDocuments(filter),
      ]);

      res.json({
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
