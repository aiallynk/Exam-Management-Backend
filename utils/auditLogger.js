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
  FORGOT_PASSWORD_REQUEST: 'FORGOT_PASSWORD_REQUEST',
  PASSWORD_RESET_SUCCESS: 'PASSWORD_RESET_SUCCESS',
  
  // Exam actions
  EXAM_CREATED: 'EXAM_CREATED',
  EXAM_UPDATED: 'EXAM_UPDATED',
  EXAM_CANDIDATES_ASSIGNED: 'EXAM_CANDIDATES_ASSIGNED',
  EXAM_CANDIDATES_REMOVED: 'EXAM_CANDIDATES_REMOVED',
  EXAM_CANDIDATES_UPDATED: 'EXAM_CANDIDATES_UPDATED',
  EXAM_DELETED: 'EXAM_DELETED',
  EXAM_RESULTS_RELEASED: 'EXAM_RESULTS_RELEASED',
  
  // Session actions
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  SESSION_CANDIDATES_ASSIGNED: 'SESSION_CANDIDATES_ASSIGNED',
  SESSION_CANDIDATES_REMOVED: 'SESSION_CANDIDATES_REMOVED',
  SESSION_CANDIDATES_UPDATED: 'SESSION_CANDIDATES_UPDATED',
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

  // Examiner evaluation & verification actions
  EXAMINER_ASSIGNMENT_CREATED: 'EXAMINER_ASSIGNMENT_CREATED',
  EXAMINER_ASSIGNMENT_UPDATED: 'EXAMINER_ASSIGNMENT_UPDATED',
  EXAMINER_ASSIGNMENT_REVOKED: 'EXAMINER_ASSIGNMENT_REVOKED',
  EXAMINER_ASSIGNMENT_EXPIRED: 'EXAMINER_ASSIGNMENT_EXPIRED',
  ANSWER_EXAMINER_REVIEWED: 'ANSWER_EXAMINER_REVIEWED',
  ANSWER_SCORE_OVERRIDDEN: 'ANSWER_SCORE_OVERRIDDEN',
  ANSWER_FLAGGED_FOR_MODERATION: 'ANSWER_FLAGGED_FOR_MODERATION',
  RESULT_PUBLICATION_BLOCKED: 'RESULT_PUBLICATION_BLOCKED',
  RESULT_RECALCULATED: 'RESULT_RECALCULATED',
  TENANT_FEATURE_ENABLED: 'TENANT_FEATURE_ENABLED',
  TENANT_FEATURE_DISABLED: 'TENANT_FEATURE_DISABLED',
  EVALUATOR_CAPABILITY_ASSIGNED: 'EVALUATOR_CAPABILITY_ASSIGNED',
  EVALUATOR_CAPABILITY_REMOVED: 'EVALUATOR_CAPABILITY_REMOVED',
  EVALUATOR_ACCESS_EXPIRY_CHANGED: 'EVALUATOR_ACCESS_EXPIRY_CHANGED',
  EVALUATION_ASSIGNMENT_REASSIGNED: 'EVALUATION_ASSIGNMENT_REASSIGNED',
  RESPONSE_DISTRIBUTION_COMPLETED: 'RESPONSE_DISTRIBUTION_COMPLETED',
  EVALUATOR_DISTRIBUTION_STRATEGY_CHANGED: 'EVALUATOR_DISTRIBUTION_STRATEGY_CHANGED',

  // Evaluator real-role lifecycle (XAM-ROLE-EVAL correction)
  EVALUATOR_USER_CREATED: 'EVALUATOR_USER_CREATED',
  EVALUATOR_ROLE_ASSIGNED: 'EVALUATOR_ROLE_ASSIGNED',
  EVALUATOR_ROLE_REMOVED: 'EVALUATOR_ROLE_REMOVED',
  EVALUATOR_PRIMARY_ROLE_CORRECTED: 'EVALUATOR_PRIMARY_ROLE_CORRECTED',
  EVALUATOR_CANDIDATE_FALLBACK_MIGRATED: 'EVALUATOR_CANDIDATE_FALLBACK_MIGRATED',

  // Assessment governance (V2 Phase 2)
  FRAMEWORK_CREATED: 'FRAMEWORK_CREATED',
  FRAMEWORK_UPDATED: 'FRAMEWORK_UPDATED',
  FRAMEWORK_CLONED: 'FRAMEWORK_CLONED',
  FRAMEWORK_VERSION_CREATED: 'FRAMEWORK_VERSION_CREATED',
  FRAMEWORK_VERSION_UPDATED: 'FRAMEWORK_VERSION_UPDATED',
  FRAMEWORK_VERSION_PUBLISHED: 'FRAMEWORK_VERSION_PUBLISHED',
  RUBRIC_TEMPLATE_CREATED: 'RUBRIC_TEMPLATE_CREATED',
  RUBRIC_TEMPLATE_UPDATED: 'RUBRIC_TEMPLATE_UPDATED',
  RUBRIC_TEMPLATE_PUBLISHED: 'RUBRIC_TEMPLATE_PUBLISHED',
  RUBRIC_TEMPLATE_ARCHIVED: 'RUBRIC_TEMPLATE_ARCHIVED',
  QUESTION_BANK_REUSED: 'QUESTION_BANK_REUSED',
  ASSESSMENT_SPECIFICATION_RESOLVED: 'ASSESSMENT_SPECIFICATION_RESOLVED',
  QUESTION_MEMORY_CHECKED: 'QUESTION_MEMORY_CHECKED',
  QUESTION_BANK_ITEM_CREATED: 'QUESTION_BANK_ITEM_CREATED',
  QUESTION_BANK_VERSION_STATUS_CHANGED: 'QUESTION_BANK_VERSION_STATUS_CHANGED',

  // Offline answer-sheet evaluation (Master Phase 4)
  OFFLINE_SCRIPT_UPLOADED: 'OFFLINE_SCRIPT_UPLOADED',
  OFFLINE_CANDIDATE_AUTO_MAPPED: 'OFFLINE_CANDIDATE_AUTO_MAPPED',
  OFFLINE_CANDIDATE_MAPPING_OVERRIDDEN: 'OFFLINE_CANDIDATE_MAPPING_OVERRIDDEN',
  OFFLINE_OCR_COMPLETED: 'OFFLINE_OCR_COMPLETED',
  OFFLINE_OCR_FAILED: 'OFFLINE_OCR_FAILED',
  OFFLINE_QUESTION_MAPPING_CHANGED: 'OFFLINE_QUESTION_MAPPING_CHANGED',
  OFFLINE_AI_EVALUATION_EXECUTED: 'OFFLINE_AI_EVALUATION_EXECUTED',
  OFFLINE_SCRIPT_FINALIZED: 'OFFLINE_SCRIPT_FINALIZED',
  OFFLINE_ANNOTATED_OUTPUT_GENERATED: 'OFFLINE_ANNOTATED_OUTPUT_GENERATED',
  OFFLINE_RESULT_SYNCHRONIZED: 'OFFLINE_RESULT_SYNCHRONIZED',

  // Content Library (Blueprint section 7A)
  CONTENT_LIBRARY_SOURCE_UPLOADED: 'CONTENT_LIBRARY_SOURCE_UPLOADED',
  CONTENT_LIBRARY_SOURCE_UPDATED: 'CONTENT_LIBRARY_SOURCE_UPDATED',
  CONTENT_LIBRARY_SOURCE_DELETED: 'CONTENT_LIBRARY_SOURCE_DELETED',
  CONTENT_LIBRARY_SOURCE_REPROCESSED: 'CONTENT_LIBRARY_SOURCE_REPROCESSED',

  // LibraryResource (Blueprint section 7B)
  LIBRARY_RESOURCE_CREATED: 'LIBRARY_RESOURCE_CREATED',
  LIBRARY_RESOURCE_UPDATED: 'LIBRARY_RESOURCE_UPDATED',
  LIBRARY_RESOURCE_DELETED: 'LIBRARY_RESOURCE_DELETED',

  AI_ENGINE_CONFIG_UPDATED: 'AI_ENGINE_CONFIG_UPDATED',
};
