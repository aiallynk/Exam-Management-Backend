/**
 * Audit Logging Middleware
 * Automatically logs sensitive actions for security and compliance
 */

import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';

// Re-export AUDIT_ACTIONS for convenience
export { AUDIT_ACTIONS };

/**
 * Audit middleware factory
 * Creates middleware to log specific actions
 * @param {string} action - Audit action type
 * @param {function} getDetails - Function to extract details from req/res
 */
export const auditLog = (action, getDetails = (req, res) => ({})) => {
  return (req, res, next) => {
    // Log after response is sent to avoid blocking
    const originalSend = res.send;
    res.send = function (body) {
      // Extract details after response
      const details = {
        userId: req.user?._id || req.user?.sub || null,
        userEmail: req.user?.email || null,
        userName: req.user?.name || null,
        userRole: req.user?.role || null,
        tenantId: req.user?.tenantId || null,
        method: req.method,
        path: req.path,
        ip: req.ip || req.connection?.remoteAddress,
        ipAddress: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('user-agent'),
        statusCode: res.statusCode,
        ...getDetails(req, res),
      };
      
      // Only log successful operations (2xx, 3xx) or important failures (4xx, 5xx)
      if (res.statusCode < 400 || res.statusCode >= 500) {
        // Call async function but don't await (non-blocking)
        logAuditEvent(action, details).catch(err => {
          console.error('[AUDIT MIDDLEWARE ERROR]', err);
        });
      }
      
      return originalSend.call(this, body);
    };
    
    next();
  };
};

/**
 * Audit login attempts (success and failure)
 */
export const auditLogin = (req, res, next) => {
  const originalJson = res.json;
  res.json = function (data) {
    const action = res.statusCode === 200 ? AUDIT_ACTIONS.LOGIN_SUCCESS : AUDIT_ACTIONS.LOGIN_FAILED;
    const details = {
      email: req.body?.email || 'unknown',
      ip: req.ip || req.connection?.remoteAddress,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent'),
      statusCode: res.statusCode,
      userId: data?.user?._id || data?.user?.id || null,
    };
    
    // Call async function but don't await (non-blocking)
    logAuditEvent(action, details).catch(err => {
      console.error('[AUDIT LOGIN ERROR]', err);
    });
    return originalJson.call(this, data);
  };
  
  next();
};

/**
 * Audit logout
 */
export const auditLogout = auditLog(AUDIT_ACTIONS.LOGOUT);

/**
 * Audit unauthorized access attempts
 */
export const auditUnauthorized = (req, res) => {
  logAuditEvent(AUDIT_ACTIONS.UNAUTHORIZED_ACCESS, {
    method: req.method,
    path: req.path,
    ip: req.ip || req.connection?.remoteAddress,
    ipAddress: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('user-agent'),
    hasToken: !!req.headers.authorization,
  }).catch(err => {
    console.error('[AUDIT UNAUTHORIZED ERROR]', err);
  });
};

