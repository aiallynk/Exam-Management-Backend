import express from 'express';
import AuditLog from '../models/AuditLog.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { sanitizePagination, isValidObjectId } from '../middleware/validation.js';

const router = express.Router();
const EXCLUDED_ACTIONS = new Set(['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT']);
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACTION_GROUPS = [
  { key: 'create', label: 'Create', actions: ['USER_CREATED', 'EXAM_CREATED', 'TENANT_CREATED'] },
  { key: 'update', label: 'Update', actions: ['USER_UPDATED', 'EXAM_UPDATED', 'TENANT_UPDATED'] },
  { key: 'delete', label: 'Delete', actions: ['USER_DELETED', 'EXAM_DELETED', 'TENANT_DEACTIVATED'] },
  { key: 'assign', label: 'Assign', regex: /ASSIGN/i },
  { key: 'role_change', label: 'Role Change', actions: ['USER_ROLE_CHANGED'] },
  { key: 'attempt', label: 'Attempt', regex: /^ATTEMPT_/i },
  { key: 'security', label: 'Security', actions: ['UNAUTHORIZED_ACCESS'] },
];
const ENTITY_DEFS = [
  { key: 'USER', label: 'User', resourceType: 'User', actionPrefix: 'USER_' },
  { key: 'EXAM', label: 'Exam', resourceType: 'Exam', actionPrefix: 'EXAM_' },
  { key: 'TENANT', label: 'Tenant', resourceType: 'Tenant', actionPrefix: 'TENANT_' },
  { key: 'ATTEMPT', label: 'Attempt', resourceType: 'Attempt', actionPrefix: 'ATTEMPT_' },
  { key: 'ROLE', label: 'Role', action: 'USER_ROLE_CHANGED' },
];

const resolveActionGroup = (value) => {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  return ACTION_GROUPS.find((group) => group.key === normalized) || null;
};

const resolveEntity = (value) => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return ENTITY_DEFS.find((entity) => entity.key === normalized) || null;
};

const toSafeObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const toNonEmptyString = (value) => {
  const normalized = String(value || '').trim();
  return normalized || '';
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const appendAndCondition = (filter, condition) => {
  if (!condition) return;
  filter.$and = Array.isArray(filter.$and) ? filter.$and : [];
  filter.$and.push(condition);
};

const buildActionFilters = ({ action, actionGroup, entity }) => {
  const actionFilters = [];
  const group = resolveActionGroup(actionGroup);
  const entityDef = resolveEntity(entity);

  if (group) {
    if (Array.isArray(group.actions) && group.actions.length > 0) {
      actionFilters.push({ action: { $in: group.actions } });
    } else if (group.regex instanceof RegExp) {
      actionFilters.push({ action: { $regex: group.regex } });
    }
  } else if (action) {
    actionFilters.push({ action });
  }

  if (entityDef?.action) {
    actionFilters.push({ action: entityDef.action });
  } else if (entityDef?.actionPrefix) {
    actionFilters.push({
      $or: [
        { action: { $regex: new RegExp(`^${escapeRegex(entityDef.actionPrefix)}`) } },
        { resourceType: entityDef.resourceType },
        { 'details.resourceType': entityDef.resourceType },
      ],
    });
  }

  actionFilters.push({ action: { $nin: Array.from(EXCLUDED_ACTIONS) } });
  return actionFilters;
};

const applyActionFilters = (filter, actionFilters) => {
  if (!actionFilters.length) return;
  appendAndCondition(filter, { $and: actionFilters });
};

const inferEntityTypeFromAction = (action) => {
  const normalizedAction = toNonEmptyString(action).toUpperCase();
  if (normalizedAction.startsWith('USER_')) return 'User';
  if (normalizedAction.startsWith('EXAM_')) return 'Exam';
  if (normalizedAction.startsWith('TENANT_')) return 'Tenant';
  if (normalizedAction.startsWith('ATTEMPT_')) return 'Attempt';
  if (normalizedAction.includes('ROLE')) return 'Role';
  return '';
};

const resolveEntityType = (log) => {
  const details = toSafeObject(log?.details);
  return (
    toNonEmptyString(log?.resourceType) ||
    toNonEmptyString(details.resourceType) ||
    inferEntityTypeFromAction(log?.action)
  );
};

const resolveEntityId = (log, entityType) => {
  const details = toSafeObject(log?.details);

  const directResourceId =
    log?.resourceId !== null && log?.resourceId !== undefined ? String(log.resourceId) : '';
  if (directResourceId) return directResourceId;

  const detailResourceId =
    details.resourceId !== null && details.resourceId !== undefined
      ? String(details.resourceId)
      : '';
  if (detailResourceId) return detailResourceId;

  if (entityType === 'Tenant') {
    return (
      toNonEmptyString(details.tenantId) ||
      (log?.tenantId ? String(log.tenantId) : '')
    );
  }

  if (entityType === 'User') {
    return (
      toNonEmptyString(details.targetUserId) ||
      (log?.userId ? String(log.userId?._id || log.userId) : '')
    );
  }

  return '';
};

const resolveUserName = (log) => {
  const details = toSafeObject(log?.details);
  return (
    toNonEmptyString(log?.userName) ||
    toNonEmptyString(log?.userId?.name) ||
    toNonEmptyString(details.userName) ||
    toNonEmptyString(log?.userEmail)
  );
};

const resolveUserEmail = (log) => {
  const details = toSafeObject(log?.details);
  return (
    toNonEmptyString(log?.userEmail) ||
    toNonEmptyString(log?.userId?.email) ||
    toNonEmptyString(details.userEmail)
  );
};

const resolveUserRole = (log) => {
  const details = toSafeObject(log?.details);
  return toNonEmptyString(log?.userRole) || toNonEmptyString(details.userRole);
};

const resolveIpAddress = (log) => {
  const details = toSafeObject(log?.details);
  return (
    toNonEmptyString(log?.ipAddress) ||
    toNonEmptyString(details.ipAddress) ||
    toNonEmptyString(details.ip)
  );
};

const resolveStatusCode = (log) => {
  const details = toSafeObject(log?.details);
  const candidate = log?.statusCode ?? details.statusCode;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
};

const mapAuditLogForResponse = (auditLog) => {
  const log = auditLog?.toObject ? auditLog.toObject() : auditLog;
  const entityType = resolveEntityType(log);
  const entityId = resolveEntityId(log, entityType);
  const userName = resolveUserName(log);
  const userEmail = resolveUserEmail(log);
  const userRole = resolveUserRole(log);
  const statusCode = resolveStatusCode(log);
  const timestamp = log?.timestamp || log?.createdAt || null;
  const ipAddress = resolveIpAddress(log);

  return {
    ...log,
    userName: userName || null,
    userEmail: userEmail || null,
    userRole: userRole || null,
    resourceType: entityType || null,
    resourceId: entityId || null,
    ipAddress: ipAddress || null,
    statusCode,
    timestamp,
    metadata: toSafeObject(log?.details),
    user_name: userName || null,
    role: userRole || null,
    action: toNonEmptyString(log?.action),
    entity_type: entityType || null,
    entity_id: entityId || null,
    ip_address: ipAddress || null,
    status_code: statusCode,
  };
};

const buildBaseFilter = (req) => {
  const filter = { ...req.tenantFilter };
  const tenantId = req.query?.tenantId;
  if (tenantId && req.user?.role === 'SUPER_ADMIN') {
    filter.tenantId = tenantId;
  }
  return filter;
};

const dedupeUserOptions = (logs) => {
  const uniqueByKey = new Map();
  (Array.isArray(logs) ? logs : []).forEach((log) => {
    const mapped = mapAuditLogForResponse(log);
    const userId = toNonEmptyString(mapped?.userId?._id || mapped?.userId);
    const userEmail = toNonEmptyString(mapped?.userEmail);
    const userName = toNonEmptyString(mapped?.userName);
    const role = toNonEmptyString(mapped?.userRole);

    const key = userId || userEmail || userName;
    if (!key || uniqueByKey.has(key)) return;

    uniqueByKey.set(key, {
      value: userId || userEmail || userName,
      label: userEmail ? `${userName || userEmail} (${userEmail})` : userName,
      userId: userId || null,
      userName: userName || null,
      userEmail: userEmail || null,
      role: role || null,
    });
  });
  return Array.from(uniqueByKey.values()).slice(0, 100);
};

// Get audit log filter options
router.get(
  '/options',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const baseFilter = buildBaseFilter(req);
      baseFilter.action = { $nin: Array.from(EXCLUDED_ACTIONS) };

      const [actions, resourceTypes, detailResourceTypes, recentUserLogs] = await Promise.all([
        AuditLog.distinct('action', baseFilter),
        AuditLog.distinct('resourceType', baseFilter),
        AuditLog.distinct('details.resourceType', baseFilter),
        AuditLog.find(baseFilter)
          .select('userId userName userEmail userRole details timestamp')
          .sort({ timestamp: -1 })
          .limit(500)
          .lean(),
      ]);

      const availableActions = new Set(
        (actions || []).map((value) => String(value || '').trim()).filter(Boolean)
      );

      const actionOptions = ACTION_GROUPS.map((group) => {
        let matches = [];
        if (Array.isArray(group.actions) && group.actions.length > 0) {
          matches = group.actions.filter((actionValue) => availableActions.has(actionValue));
        } else if (group.regex instanceof RegExp) {
          matches = Array.from(availableActions).filter((actionValue) => group.regex.test(actionValue));
        }
        return matches.length > 0
          ? { value: group.key, label: group.label }
          : null;
      }).filter(Boolean);

      const actionValueOptions = Array.from(availableActions)
        .sort((left, right) => left.localeCompare(right))
        .map((actionValue) => ({
          value: actionValue,
          label: actionValue.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase()),
        }));

      const availableResourceTypes = new Set(
        [...(resourceTypes || []), ...(detailResourceTypes || [])]
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
      );

      const entityOptions = ENTITY_DEFS.map((entity) => {
        if (entity.resourceType) {
          return availableResourceTypes.has(entity.resourceType.toLowerCase())
            ? { value: entity.key, label: entity.label }
            : null;
        }
        if (entity.action && availableActions.has(entity.action)) {
          return { value: entity.key, label: entity.label };
        }
        return null;
      }).filter(Boolean);

      const userOptions = dedupeUserOptions(recentUserLogs);

      res.json({ actionOptions, actionValueOptions, entityOptions, userOptions });
    } catch (error) {
      next(error);
    }
  }
);

// Get audit logs (admin only)
router.get(
  '/',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  sanitizePagination,
  async (req, res, next) => {
    try {
      const {
        page,
        limit,
        action,
        actionGroup,
        entity,
        userId,
        user,
        resourceType,
        resourceId,
        startDate,
        endDate,
      } = req.query;
      const skip = (page - 1) * limit;

      const filter = buildBaseFilter(req);

      if (action && EXCLUDED_ACTIONS.has(action)) {
        return res.json({
          logs: [],
          pagination: {
            page,
            limit,
            total: 0,
            pages: 0,
          },
        });
      }

      const actionFilters = buildActionFilters({ action, actionGroup, entity });
      applyActionFilters(filter, actionFilters);

      if (userId) {
        appendAndCondition(filter, { userId });
      } else if (user) {
        const trimmed = String(user || '').trim();
        if (trimmed) {
          if (isValidObjectId(trimmed)) {
            appendAndCondition(filter, { userId: trimmed });
          } else {
            const regex = new RegExp(escapeRegex(trimmed), 'i');
            appendAndCondition(filter, {
              $or: [
                { userEmail: regex },
                { userName: regex },
                { 'details.userEmail': regex },
                { 'details.userName': regex },
              ],
            });
          }
        }
      }

      const entityDef = resolveEntity(entity);
      if (entityDef?.resourceType) {
        appendAndCondition(filter, {
          $or: [
            { resourceType: entityDef.resourceType },
            { 'details.resourceType': entityDef.resourceType },
          ],
        });
      } else if (resourceType) {
        appendAndCondition(filter, {
          $or: [
            { resourceType },
            { 'details.resourceType': resourceType },
          ],
        });
      }

      if (resourceId) {
        appendAndCondition(filter, {
          $or: [
            { resourceId },
            { 'details.resourceId': resourceId },
          ],
        });
      }

      if (startDate || endDate) {
        const timestampFilter = {};
        const parsedStartDate = toDateOrNull(startDate);
        const parsedEndDate = toDateOrNull(endDate);
        if (parsedStartDate) {
          timestampFilter.$gte = parsedStartDate;
        }
        if (parsedEndDate) {
          const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate).trim());
          if (isDateOnly) {
            parsedEndDate.setHours(23, 59, 59, 999);
          }
          timestampFilter.$lte = parsedEndDate;
        }
        if (Object.keys(timestampFilter).length > 0) {
          filter.timestamp = timestampFilter;
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
        logs: (Array.isArray(logs) ? logs : []).map((log) => mapAuditLogForResponse(log)),
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
router.get(
  '/:id',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const log = await AuditLog.findOne({
        _id: req.params.id,
        ...req.tenantFilter,
      }).populate('userId', 'name email');
      if (!log) {
        return res.status(404).json({ error: 'Audit log not found' });
      }
      res.json({ log: mapAuditLogForResponse(log) });
    } catch (error) {
      next(error);
    }
  }
);

// Get audit logs for specific resource
router.get(
  '/resource/:resourceType/:resourceId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  sanitizePagination,
  async (req, res, next) => {
    try {
      const { page, limit } = req.query;
      const skip = (page - 1) * limit;

      const filter = {
        ...req.tenantFilter,
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
        logs: (Array.isArray(logs) ? logs : []).map((log) => mapAuditLogForResponse(log)),
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
  requireTenant,
  enforceTenantBoundaries,
  requireRole('SUPER_ADMIN', 'TENANT_ADMIN'),
  sanitizePagination,
  async (req, res, next) => {
    try {
      const { page, limit } = req.query;
      const skip = (page - 1) * limit;

      const filter = {
        ...req.tenantFilter,
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
        logs: (Array.isArray(logs) ? logs : []).map((log) => mapAuditLogForResponse(log)),
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
