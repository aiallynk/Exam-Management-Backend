/**
 * Audit Logger Utility
 * Logs sensitive actions for security and compliance
 */

import { logError } from './logger.js';
import { resolveTenantSnapshot } from './tenantResolver.js';
import AuditLog from '../models/AuditLog.js';
import { emitSystemAlertFromAuditEvent } from '../services/systemAlertService.js';

const EXCLUDED_ACTIONS = new Set(['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT']);

/**
 * Audit log entry structure
 */
export const createAuditLog = (action, details) => {
  return {
    timestamp: new Date(),
    action,
    ...details,
  };
};

/**
 * Log audit event to database
 * @param {string} action - Action performed (e.g., 'USER_CREATED', 'EXAM_DELETED')
 * @param {object} details - Additional details (userId, resourceId, etc.)
 */
export const logAuditEvent = async (action, details = {}) => {
  try {
    if (EXCLUDED_ACTIONS.has(action)) {
      return;
    }

    const resolvedUserName =
      details.userName || details.user?.name || details.user?.fullName || null;
    const resolvedUserEmail = details.userEmail || details.email || null;
    const resolvedTenantId = details.tenantId || null;
    let resolvedTenantName =
      details.tenantName || details.tenant?.name || null;

    if (!resolvedTenantName && resolvedTenantId) {
      try {
        const tenant = await resolveTenantSnapshot(resolvedTenantId, 'name');
        resolvedTenantName = tenant?.name || null;
      } catch (lookupError) {
        resolvedTenantName = null;
      }
    }

    const auditEntry = new AuditLog({
      action,
      userId: details.userId || null,
      userEmail: resolvedUserEmail,
      userName: resolvedUserName,
      userRole: details.userRole || null,
      tenantId: resolvedTenantId,
      tenantName: resolvedTenantName,
      resourceType: details.resourceType || null,
      resourceId: details.resourceId || null,
      details: {
        method: details.method,
        path: details.path,
        ...details,
      },
      ipAddress: details.ip || details.ipAddress || null,
      userAgent: details.userAgent || null,
      method: details.method || null,
      path: details.path || null,
      statusCode: details.statusCode || null,
      timestamp: new Date(),
    });
    
    // Save to database (non-blocking)
    auditEntry.save().catch(error => {
      // Log error but don't throw - audit logging should not break the main flow
      console.error('[AUDIT ERROR] Failed to save audit log:', error);
      logError(error, { context: 'auditLogger', action, details });
    });

    // Emit system alert from real audit events (non-blocking).
    emitSystemAlertFromAuditEvent(action, {
      ...details,
      tenantId: resolvedTenantId,
      tenantName: resolvedTenantName,
      userEmail: resolvedUserEmail,
      userName: resolvedUserName,
    }).catch((error) => {
      console.error(
        '[AUDIT ERROR] Failed to emit system alert from audit event:',
        error?.message || error
      );
    });
    
    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      console.log('[AUDIT]', JSON.stringify({
        action,
        userId: details.userId,
        resourceType: details.resourceType,
        resourceId: details.resourceId,
        timestamp: new Date().toISOString(),
      }, null, 2));
    }
  } catch (error) {
    // Log error but don't throw - audit logging should not break the main flow
    console.error('[AUDIT ERROR] Failed to create audit log:', error);
    logError(error, { context: 'auditLogger', action, details });
  }
};

/**
 * Audit action types
 */
export const AUDIT_ACTIONS = {
  // User actions
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_DELETED: 'USER_DELETED',
  USER_BLOCKED: 'USER_BLOCKED',
  USER_UNBLOCKED: 'USER_UNBLOCKED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  
  // Exam actions
  EXAM_CREATED: 'EXAM_CREATED',
  EXAM_UPDATED: 'EXAM_UPDATED',
  EXAM_DELETED: 'EXAM_DELETED',
  EXAM_RESULTS_RELEASED: 'EXAM_RESULTS_RELEASED',
  
  // Session actions
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  SESSION_DELETED: 'SESSION_DELETED',
  
  // Attempt actions
  ATTEMPT_STARTED: 'ATTEMPT_STARTED',
  ATTEMPT_SUBMITTED: 'ATTEMPT_SUBMITTED',
  ATTEMPT_DISQUALIFIED: 'ATTEMPT_DISQUALIFIED',
  
  // Admin actions
  CERTIFICATE_SENT: 'CERTIFICATE_SENT',
  TENANT_CREATED: 'TENANT_CREATED',
  TENANT_UPDATED: 'TENANT_UPDATED',
  TENANT_DEACTIVATED: 'TENANT_DEACTIVATED',
  SUBSCRIPTION_PLAN_UPDATED: 'SUBSCRIPTION_PLAN_UPDATED',
  
  // Security events
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGOUT: 'USER_LOGOUT',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  UNAUTHORIZED_ACCESS: 'UNAUTHORIZED_ACCESS',
  
  // New Phase 2 actions
  RE_ATTEMPT_ALLOWED: 'RE_ATTEMPT_ALLOWED',
  ATTEMPT_RESUMED: 'ATTEMPT_RESUMED',
  NORMALIZATION_CONFIGURED: 'NORMALIZATION_CONFIGURED',
  NORMALIZATION_RECALCULATED: 'NORMALIZATION_RECALCULATED',
  NORMALIZATION_LOCKED: 'NORMALIZATION_LOCKED',
  ANSWER_KEY_IMPORTED: 'ANSWER_KEY_IMPORTED',
  ANSWER_KEY_APPLIED: 'ANSWER_KEY_APPLIED',
  QUESTIONS_IMPORTED: 'QUESTIONS_IMPORTED',
  SECTION_CREATED: 'SECTION_CREATED',
  SECTION_UPDATED: 'SECTION_UPDATED',
  SECTION_DELETED: 'SECTION_DELETED',
  LANGUAGE_ADDED: 'LANGUAGE_ADDED',
  TRANSLATION_ADDED: 'TRANSLATION_ADDED',
  
  // Admin visibility actions
  EXAM_ENABLED: 'EXAM_ENABLED',
  EXAM_DISABLED: 'EXAM_DISABLED',
  EXAM_PREVIEWED: 'EXAM_PREVIEWED',
  EXAM_AUDITED: 'EXAM_AUDITED',
  ATTEMPT_RE_ENABLED: 'ATTEMPT_RE_ENABLED',
  ATTEMPT_RECALCULATED: 'ATTEMPT_RECALCULATED',
  ATTEMPT_OVERRIDE: 'ATTEMPT_OVERRIDE',
  ATTEMPT_FLAGGED: 'ATTEMPT_FLAGGED',
  ATTEMPT_NOTE_ADDED: 'ATTEMPT_NOTE_ADDED',
};

