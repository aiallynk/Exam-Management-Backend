import express from 'express';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import Exam from '../models/Exam.js';
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
  {
    key: 'auth',
    label: 'Authentication',
    actions: ['USER_LOGIN', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'USER_LOGGED_IN', 'LOGIN', 'USER_LOGOUT', 'LOGOUT'],
  },
  { key: 'login', label: 'Login', actions: ['USER_LOGIN', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'USER_LOGGED_IN', 'LOGIN'] },
  { key: 'logout', label: 'Logout', actions: ['USER_LOGOUT', 'LOGOUT'] },
  { key: 'security', label: 'Security', actions: ['UNAUTHORIZED_ACCESS'] },
];
const ENTITY_DEFS = [
  { key: 'USER', label: 'User', resourceType: 'User', actionPrefix: 'USER_' },
  { key: 'EXAM', label: 'Exam', resourceType: 'Exam', actionPrefix: 'EXAM_' },
  { key: 'TENANT', label: 'Tenant', resourceType: 'Tenant', actionPrefix: 'TENANT_' },
  { key: 'ATTEMPT', label: 'Attempt', resourceType: 'Attempt', actionPrefix: 'ATTEMPT_' },
  { key: 'ROLE', label: 'Role', action: 'USER_ROLE_CHANGED' },
];
const SUPER_ADMIN_ACTIVITY_VIEW = 'super_admin_activity';
const NO_EXCLUDED_ACTIONS = new Set();
const SUPER_ADMIN_ACTIVITY_ACTIONS = new Set([
  'USER_CREATED',
  'USER_UPDATED',
  'USER_ROLE_CHANGED',
  'USER_DELETED',
  'USER_BLOCKED',
  'USER_UNBLOCKED',
  'USER_ACTIVATED',
  'USER_DEACTIVATED',
  'TENANT_CREATED',
  'TENANT_UPDATED',
  'TENANT_ACTIVATED',
  'TENANT_DELETED',
  'TENANT_DEACTIVATED',
  'EXAM_CREATED',
  'EXAM_UPDATED',
  'EXAM_DELETED',
  'USER_LOGIN',
  'USER_LOGOUT',
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'USER_LOGGED_IN',
  'LOGIN',
]);
const SUPER_ADMIN_ACTIVITY_ACTION_LIST = Array.from(SUPER_ADMIN_ACTIVITY_ACTIONS);
const SUPER_ADMIN_ACTIVITY_ACTION_GROUPS = [
  { key: 'create', label: 'Create', actions: ['USER_CREATED', 'EXAM_CREATED', 'TENANT_CREATED'] },
  {
    key: 'update',
    label: 'Update',
    actions: [
      'USER_UPDATED',
      'USER_ROLE_CHANGED',
      'EXAM_UPDATED',
      'TENANT_UPDATED',
    ],
  },
  { key: 'delete', label: 'Delete', actions: ['USER_DELETED', 'EXAM_DELETED', 'TENANT_DELETED'] },
  { key: 'activate', label: 'Activate', actions: ['USER_UNBLOCKED', 'USER_ACTIVATED', 'TENANT_ACTIVATED', 'USER_UPDATED', 'TENANT_UPDATED'] },
  { key: 'deactivate', label: 'Deactivate', actions: ['USER_BLOCKED', 'USER_DEACTIVATED', 'TENANT_DEACTIVATED', 'USER_UPDATED', 'TENANT_UPDATED'] },
  {
    key: 'auth',
    label: 'Authentication',
    actions: ['USER_LOGIN', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'USER_LOGGED_IN', 'LOGIN', 'USER_LOGOUT', 'LOGOUT'],
  },
  { key: 'login', label: 'Login', actions: ['USER_LOGIN', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'USER_LOGGED_IN', 'LOGIN'] },
  { key: 'logout', label: 'Logout', actions: ['USER_LOGOUT', 'LOGOUT'] },
];
const SUPER_ADMIN_ACTIVITY_ENTITY_DEFS = [
  { key: 'USER', label: 'User', resourceType: 'User', actionPrefix: 'USER_' },
  { key: 'EXAM', label: 'Exam', resourceType: 'Exam', actionPrefix: 'EXAM_' },
  { key: 'TENANT', label: 'Tenant', resourceType: 'Tenant', actionPrefix: 'TENANT_' },
];

const resolveActionGroup = (value, actionGroups = ACTION_GROUPS) => {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  return actionGroups.find((group) => group.key === normalized) || null;
};

const resolveEntity = (value, entityDefs = ENTITY_DEFS) => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return entityDefs.find((entity) => entity.key === normalized) || null;
};

const toSafeObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const toNonEmptyString = (value) => {
  const normalized = String(value || '').trim();
  return normalized || '';
};

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const normalized = toNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
};

const isSuperAdminActivityViewRequest = (req) =>
  req?.user?.role === 'SUPER_ADMIN' &&
  toNonEmptyString(req?.query?.view).toLowerCase() === SUPER_ADMIN_ACTIVITY_VIEW;

const getActionGroupsForRequest = (req) =>
  isSuperAdminActivityViewRequest(req) ? SUPER_ADMIN_ACTIVITY_ACTION_GROUPS : ACTION_GROUPS;

const getEntityDefsForRequest = (req) =>
  isSuperAdminActivityViewRequest(req) ? SUPER_ADMIN_ACTIVITY_ENTITY_DEFS : ENTITY_DEFS;

const getExcludedActionsForRequest = (req) =>
  isSuperAdminActivityViewRequest(req) ? NO_EXCLUDED_ACTIONS : EXCLUDED_ACTIONS;

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

const buildActionFilters = ({
  action,
  actionGroup,
  entity,
  actionGroups = ACTION_GROUPS,
  entityDefs = ENTITY_DEFS,
  excludedActions = EXCLUDED_ACTIONS,
}) => {
  const actionFilters = [];
  const group = resolveActionGroup(actionGroup, actionGroups);
  const entityDef = resolveEntity(entity, entityDefs);

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

  if (excludedActions instanceof Set && excludedActions.size > 0) {
    actionFilters.push({ action: { $nin: Array.from(excludedActions) } });
  }
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

const toStringArray = (value) =>
  Array.isArray(value)
    ? value.map((item) => toNonEmptyString(item)).filter(Boolean)
    : [];

const normalizeStatusToken = (value) => toNonEmptyString(value).toUpperCase();

const isActiveStatus = (status) =>
  ['ACTIVE', 'ENABLED', 'ACTIVATED', 'UNBLOCKED'].includes(status);

const isInactiveStatus = (status) =>
  ['INACTIVE', 'SUSPENDED', 'BLOCKED', 'DISABLED', 'DEACTIVATED'].includes(status);

const resolveStatusVerbFromMetadata = (metadata = {}) => {
  const details = toSafeObject(metadata);
  const updatedFields = toStringArray(details.updatedFields).map((field) => field.toLowerCase());
  const statusTouched = updatedFields.some((field) =>
    ['status', 'isactive', 'active', 'blocked'].includes(field)
  );

  const beforeStatus = normalizeStatusToken(
    firstNonEmpty(
      details.beforeStatus,
      details.before?.status,
      details.before?.state,
      details.before?.userStatus,
      details.before?.tenantStatus
    )
  );

  const afterStatus = normalizeStatusToken(
    firstNonEmpty(
      details.afterStatus,
      details.targetUserStatus,
      details.targetTenantStatus,
      details.after?.status,
      details.after?.state,
      details.after?.userStatus,
      details.after?.tenantStatus
    )
  );

  if (!afterStatus) return '';
  if (!beforeStatus && !statusTouched) return '';
  if (beforeStatus && beforeStatus === afterStatus && !statusTouched) return '';

  if (isActiveStatus(afterStatus)) return 'activated';
  if (isInactiveStatus(afterStatus)) return 'deactivated';
  return '';
};

const normalizeActivityEventType = (value) => {
  const normalized = toNonEmptyString(value).toLowerCase();
  if (!normalized) return '';
  if (normalized.startsWith('creat')) return 'create';
  if (normalized.startsWith('updat')) return 'update';
  if (normalized.startsWith('delet')) return 'delete';
  if (normalized.startsWith('activat')) return 'activate';
  if (normalized.startsWith('deactivat')) return 'deactivate';
  if (normalized.startsWith('logout') || normalized.startsWith('signout')) return 'logout';
  if (normalized.startsWith('log')) return 'login';
  return normalized;
};

const activityEventLabel = (eventType) => {
  const normalized = normalizeActivityEventType(eventType);
  if (normalized === 'create') return 'CREATE';
  if (normalized === 'update') return 'UPDATE';
  if (normalized === 'delete') return 'DELETE';
  if (normalized === 'activate') return 'UPDATE';
  if (normalized === 'deactivate') return 'UPDATE';
  if (normalized === 'login') return 'LOGIN';
  if (normalized === 'logout') return 'LOGOUT';
  return 'UPDATE';
};

const resolveLoginAuditStatus = (action, metadata = {}) => {
  const normalizedAction = toNonEmptyString(action).toUpperCase();
  const rawStatus = toNonEmptyString(
    metadata.status || metadata.loginStatus || metadata.outcome
  ).toUpperCase();
  if (rawStatus === 'SUCCESS') return 'SUCCESS';
  if (rawStatus === 'FAILED' || rawStatus === 'FAIL' || rawStatus === 'FAILURE') return 'FAILED';
  if (normalizedAction === 'LOGIN_FAILED') return 'FAILED';
  if (normalizedAction === 'LOGIN_SUCCESS' || normalizedAction === 'USER_LOGGED_IN' || normalizedAction === 'LOGIN') {
    return 'SUCCESS';
  }
  const statusCode = Number(metadata.statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 400) return 'FAILED';
  return 'SUCCESS';
};

const resolveActivityContext = (log) => {
  const action = toNonEmptyString(log?.action).toUpperCase();
  const metadata = toSafeObject(log?.metadata || log?.details);

  if (
    action === 'USER_LOGIN' ||
    action === 'LOGIN_SUCCESS' ||
    action === 'LOGIN_FAILED' ||
    action === 'USER_LOGGED_IN' ||
    action === 'LOGIN'
  ) {
    const loginStatus = resolveLoginAuditStatus(action, metadata);
    return {
      subject: 'User',
      verb: loginStatus === 'FAILED' ? 'failed login' : 'logged in',
      eventType: 'login',
      loginStatus,
    };
  }

  if (action === 'USER_LOGOUT' || action === 'LOGOUT') {
    return { subject: 'User', verb: 'logged out', eventType: 'logout' };
  }

  if (action === 'USER_CREATED') return { subject: 'User', verb: 'created', eventType: 'create' };
  if (action === 'USER_DELETED') return { subject: 'User', verb: 'deleted', eventType: 'delete' };
  if (action === 'USER_BLOCKED' || action === 'USER_DEACTIVATED') {
    return { subject: 'User', verb: 'deactivated', eventType: 'deactivate' };
  }
  if (action === 'USER_UNBLOCKED' || action === 'USER_ACTIVATED') {
    return { subject: 'User', verb: 'activated', eventType: 'activate' };
  }
  if (action === 'USER_UPDATED' || action === 'USER_ROLE_CHANGED') {
    const statusVerb = resolveStatusVerbFromMetadata(metadata);
    if (statusVerb === 'activated') {
      return { subject: 'User', verb: 'activated', eventType: 'activate' };
    }
    if (statusVerb === 'deactivated') {
      return { subject: 'User', verb: 'deactivated', eventType: 'deactivate' };
    }
    return { subject: 'User', verb: 'updated', eventType: 'update' };
  }

  if (action === 'TENANT_CREATED') return { subject: 'Tenant', verb: 'created', eventType: 'create' };
  if (action === 'TENANT_DELETED') return { subject: 'Tenant', verb: 'deleted', eventType: 'delete' };
  if (action === 'TENANT_DEACTIVATED') return { subject: 'Tenant', verb: 'deactivated', eventType: 'deactivate' };
  if (action === 'TENANT_ACTIVATED') return { subject: 'Tenant', verb: 'activated', eventType: 'activate' };
  if (action === 'TENANT_UPDATED') {
    const statusVerb = resolveStatusVerbFromMetadata(metadata);
    if (statusVerb === 'activated') {
      return { subject: 'Tenant', verb: 'activated', eventType: 'activate' };
    }
    if (statusVerb === 'deactivated') {
      return { subject: 'Tenant', verb: 'deactivated', eventType: 'deactivate' };
    }
    return { subject: 'Tenant', verb: 'updated', eventType: 'update' };
  }

  if (action === 'EXAM_CREATED') return { subject: 'Exam', verb: 'created', eventType: 'create' };
  if (action === 'EXAM_UPDATED') return { subject: 'Exam', verb: 'updated', eventType: 'update' };
  if (action === 'EXAM_DELETED') return { subject: 'Exam', verb: 'deleted', eventType: 'delete' };

  return null;
};

const toObjectIdString = (value) => {
  const candidate = toNonEmptyString(value?._id || value);
  if (!candidate || !isValidObjectId(candidate)) return '';
  return candidate;
};

const buildActivityEntityLookups = async (logs) => {
  const userIds = new Set();
  const tenantIds = new Set();
  const examIds = new Set();

  (Array.isArray(logs) ? logs : []).forEach((log) => {
    const entityType = toNonEmptyString(log?.resourceType || log?.entity_type).toLowerCase();
    const entityId = toObjectIdString(log?.resourceId || log?.entity_id);
    if (entityType === 'user' && entityId) userIds.add(entityId);
    if (entityType === 'tenant' && entityId) tenantIds.add(entityId);
    if (entityType === 'exam' && entityId) examIds.add(entityId);

    const actorUserId = toObjectIdString(log?.userId?._id || log?.userId);
    if (actorUserId) userIds.add(actorUserId);
  });

  const [users, tenants, exams] = await Promise.all([
    userIds.size > 0
      ? User.find({ _id: { $in: Array.from(userIds) } })
          .select('_id name email')
          .lean()
      : Promise.resolve([]),
    tenantIds.size > 0
      ? Tenant.find({ _id: { $in: Array.from(tenantIds) } })
          .select('_id name')
          .lean()
      : Promise.resolve([]),
    examIds.size > 0
      ? Exam.find({ _id: { $in: Array.from(examIds) } })
          .select('_id title')
          .lean()
      : Promise.resolve([]),
  ]);

  return {
    users: new Map(
      (Array.isArray(users) ? users : []).map((row) => [
        String(row._id),
        {
          name: toNonEmptyString(row.name),
          email: toNonEmptyString(row.email),
        },
      ])
    ),
    tenants: new Map(
      (Array.isArray(tenants) ? tenants : []).map((row) => [String(row._id), toNonEmptyString(row.name)])
    ),
    exams: new Map(
      (Array.isArray(exams) ? exams : []).map((row) => [String(row._id), toNonEmptyString(row.title)])
    ),
  };
};

const resolveActivityEntityName = (log, lookups, context) => {
  const metadata = toSafeObject(log?.metadata || log?.details);
  const entityId = toObjectIdString(log?.resourceId || log?.entity_id);
  const actorUserId = toObjectIdString(log?.userId?._id || log?.userId);
  const userByEntity = entityId ? lookups?.users?.get(entityId) : null;
  const userByActor = actorUserId ? lookups?.users?.get(actorUserId) : null;

  if (context?.subject === 'User') {
    if (context.eventType === 'login' || context.eventType === 'logout' || context.verb === 'logged in') {
      return (
        firstNonEmpty(
          log?.userName,
          metadata.userName,
          userByActor?.name,
          log?.userEmail,
          userByActor?.email
        ) || ''
      );
    }

    return (
      firstNonEmpty(
        metadata.targetUserName,
        metadata.createdUserName,
        metadata.deletedUserName,
        userByEntity?.name,
        metadata.targetUserEmail,
        metadata.createdUserEmail,
        metadata.deletedUserEmail,
        userByEntity?.email
      ) || ''
    );
  }

  if (context?.subject === 'Tenant') {
    return (
      firstNonEmpty(
        metadata.tenantName,
        log?.tenantName,
        metadata.targetTenantName,
        entityId ? lookups?.tenants?.get(entityId) : '',
        metadata.contactEmail
      ) || ''
    );
  }

  if (context?.subject === 'Exam') {
    return (
      firstNonEmpty(
        metadata.examTitle,
        metadata.examName,
        metadata.title,
        entityId ? lookups?.exams?.get(entityId) : ''
      ) || ''
    );
  }

  return '';
};

const resolveActivityActorName = (log, lookups) => {
  const metadata = toSafeObject(log?.metadata || log?.details);
  const actorUserId = toObjectIdString(log?.userId?._id || log?.userId);
  const actorSnapshot = actorUserId ? lookups?.users?.get(actorUserId) : null;
  return (
    firstNonEmpty(
      log?.userName,
      metadata.userName,
      actorSnapshot?.name,
      log?.userEmail,
      metadata.userEmail,
      actorSnapshot?.email
    ) || 'User'
  );
};

const buildActivityDescription = (context, entityName, actorName) => {
  if (!context) return '';
  const safeEntityName = entityName || `Unknown ${context.subject}`;
  const loginStatus = toNonEmptyString(context.loginStatus).toUpperCase();

  if (context.eventType === 'login') {
    return loginStatus === 'FAILED'
      ? '\u274C Failed login attempt'
      : '\u2705 User logged in successfully';
  }

  if (context.eventType === 'logout') {
    return 'User logged out';
  }

  const pastVerb =
    context.verb === 'created'
      ? 'Created'
      : context.verb === 'updated'
        ? 'Updated'
        : context.verb === 'deleted'
          ? 'Deleted'
          : context.verb === 'activated'
            ? 'Activated'
            : context.verb === 'deactivated'
              ? 'Deactivated'
              : 'Updated';

  return `${pastVerb} ${context.subject} "${safeEntityName}"`;
};

const enrichSuperAdminActivityLogs = async (logs) => {
  const rows = Array.isArray(logs) ? logs : [];
  if (!rows.length) return [];

  const lookups = await buildActivityEntityLookups(rows);

  return rows.map((log) => {
    const context = resolveActivityContext(log);
    if (!context) return log;

    const entityName = resolveActivityEntityName(log, lookups, context);
    const actorName = resolveActivityActorName(log, lookups);

    return {
      ...log,
      activityEntityName: entityName || null,
      activityDescription: buildActivityDescription(context, entityName, actorName),
      activityCategory: context.subject.toLowerCase(),
      activityVerb: context.verb,
      activityEventType: normalizeActivityEventType(context.eventType || 'update'),
      activityEventLabel: activityEventLabel(context.eventType),
      activityActorName: actorName || null,
    };
  });
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

const buildSuperAdminActivitySearchCondition = async (searchValue) => {
  const term = toNonEmptyString(searchValue);
  if (!term) return null;

  const regex = new RegExp(escapeRegex(term), 'i');

  const [users, tenants, exams] = await Promise.all([
    User.find({ $or: [{ name: regex }, { email: regex }] })
      .select('_id')
      .limit(100)
      .lean(),
    Tenant.find({ name: regex })
      .select('_id')
      .limit(100)
      .lean(),
    Exam.find({ title: regex })
      .select('_id')
      .limit(100)
      .lean(),
  ]);

  const userIds = (Array.isArray(users) ? users : [])
    .map((row) => row?._id)
    .filter(Boolean);
  const tenantIds = (Array.isArray(tenants) ? tenants : [])
    .map((row) => row?._id)
    .filter(Boolean);
  const examIds = (Array.isArray(exams) ? exams : [])
    .map((row) => row?._id)
    .filter(Boolean);

  const conditions = [
    { userName: regex },
    { userEmail: regex },
    { tenantName: regex },
    { 'details.userName': regex },
    { 'details.userEmail': regex },
    { 'details.targetUserName': regex },
    { 'details.createdUserName': regex },
    { 'details.deletedUserName': regex },
    { 'details.targetUserEmail': regex },
    { 'details.createdUserEmail': regex },
    { 'details.deletedUserEmail': regex },
    { 'details.tenantName': regex },
    { 'details.targetTenantName': regex },
    { 'details.tenantCode': regex },
    { 'details.examTitle': regex },
    { 'details.examName': regex },
    { 'details.title': regex },
  ];

  if (userIds.length > 0) {
    conditions.push({ userId: { $in: userIds } });
    conditions.push({ resourceType: 'User', resourceId: { $in: userIds } });
    conditions.push({ 'details.targetUserId': { $in: userIds } });
  }

  if (tenantIds.length > 0) {
    conditions.push({ tenantId: { $in: tenantIds } });
    conditions.push({ resourceType: 'Tenant', resourceId: { $in: tenantIds } });
  }

  if (examIds.length > 0) {
    conditions.push({ resourceType: 'Exam', resourceId: { $in: examIds } });
  }

  return { $or: conditions };
};

const matchesSuperAdminActivityGroup = (log, groupValue) => {
  const normalizedGroup = toNonEmptyString(groupValue).toLowerCase();
  if (!normalizedGroup) return true;

  const eventType = normalizeActivityEventType(log?.activityEventType || log?.activityVerb);
  if (!eventType) return false;

  if (normalizedGroup === 'create') return eventType === 'create';
  if (normalizedGroup === 'update') return eventType === 'update';
  if (normalizedGroup === 'delete') return eventType === 'delete';
  if (normalizedGroup === 'activate') return eventType === 'activate';
  if (normalizedGroup === 'deactivate') return eventType === 'deactivate';
  if (normalizedGroup === 'auth') return eventType === 'login' || eventType === 'logout';
  if (normalizedGroup === 'login') return eventType === 'login';
  if (normalizedGroup === 'logout') return eventType === 'logout';

  return true;
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
      const superAdminActivityView = isSuperAdminActivityViewRequest(req);
      const actionGroups = getActionGroupsForRequest(req);
      const entityDefs = getEntityDefsForRequest(req);
      const baseFilter = buildBaseFilter(req);
      baseFilter.action = superAdminActivityView
        ? { $in: SUPER_ADMIN_ACTIVITY_ACTION_LIST }
        : { $nin: Array.from(EXCLUDED_ACTIONS) };

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

      const actionOptions = superAdminActivityView
        ? actionGroups.map((group) => ({ value: group.key, label: group.label }))
        : actionGroups.map((group) => {
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

      const entityOptions = entityDefs.map((entity) => {
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
        search,
        resourceType,
        resourceId,
        startDate,
        endDate,
      } = req.query;
      const skip = (page - 1) * limit;
      const superAdminActivityView = isSuperAdminActivityViewRequest(req);
      const actionGroups = getActionGroupsForRequest(req);
      const entityDefs = getEntityDefsForRequest(req);
      const excludedActions = getExcludedActionsForRequest(req);

      const filter = buildBaseFilter(req);
      if (superAdminActivityView) {
        appendAndCondition(filter, { action: { $in: SUPER_ADMIN_ACTIVITY_ACTION_LIST } });
      }

      if (!superAdminActivityView && action && EXCLUDED_ACTIONS.has(action)) {
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

      const actionFilters = buildActionFilters({
        action,
        actionGroup,
        entity,
        actionGroups,
        entityDefs,
        excludedActions,
      });
      applyActionFilters(filter, actionFilters);

      if (userId) {
        appendAndCondition(filter, { userId });
      }

      const querySearchTerm = toNonEmptyString(user) || toNonEmptyString(search);
      if (querySearchTerm) {
        if (superAdminActivityView) {
          const searchCondition = await buildSuperAdminActivitySearchCondition(querySearchTerm);
          if (searchCondition) {
            appendAndCondition(filter, searchCondition);
          }
        } else if (isValidObjectId(querySearchTerm)) {
          appendAndCondition(filter, { userId: querySearchTerm });
        } else {
          const regex = new RegExp(escapeRegex(querySearchTerm), 'i');
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

      const entityDef = resolveEntity(entity, entityDefs);
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
      let mappedLogs = (Array.isArray(logs) ? logs : []).map((log) => mapAuditLogForResponse(log));
      mappedLogs = await enrichSuperAdminActivityLogs(mappedLogs);
      if (superAdminActivityView && toNonEmptyString(actionGroup)) {
        mappedLogs = mappedLogs.filter((row) => matchesSuperAdminActivityGroup(row, actionGroup));
      }

      res.json({
        logs: mappedLogs,
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
