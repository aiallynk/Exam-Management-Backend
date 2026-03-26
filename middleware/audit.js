/**
 * Audit Logging Middleware
 * Automatically logs sensitive actions for security and compliance
 */

import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';

// Re-export AUDIT_ACTIONS for convenience
export { AUDIT_ACTIONS };

const resolveClientIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || null;
};

const detectClientDevice = (userAgentValue) => {
  const userAgent = String(userAgentValue || '').toLowerCase();
  let browser = 'Unknown';

  if (userAgent.includes('edg/')) browser = 'Edge';
  else if (userAgent.includes('chrome/')) browser = 'Chrome';
  else if (userAgent.includes('safari/') && !userAgent.includes('chrome/')) browser = 'Safari';
  else if (userAgent.includes('firefox/')) browser = 'Firefox';
  else if (userAgent.includes('opr/') || userAgent.includes('opera/')) browser = 'Opera';

  let device = 'Desktop';
  if (userAgent.includes('ipad') || userAgent.includes('tablet')) {
    device = 'Tablet';
  } else if (userAgent.includes('mobile') || userAgent.includes('android')) {
    device = 'Mobile';
  }

  return { browser, device };
};

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
        ip: resolveClientIp(req),
        ipAddress: resolveClientIp(req),
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
  let hasLogged = false;
  const originalJson = res.json;
  res.json = function (data) {
    if (hasLogged) {
      return originalJson.call(this, data);
    }
    hasLogged = true;

    const statusCode = Number(res.statusCode) || 0;
    const status = statusCode >= 200 && statusCode < 300 ? 'SUCCESS' : 'FAILED';
    const context =
      req.auditLoginContext && typeof req.auditLoginContext === 'object'
        ? req.auditLoginContext
        : {};
    const userPayload =
      data?.user && typeof data.user === 'object'
        ? data.user
        : {};
    const userId =
      userPayload?._id ||
      userPayload?.id ||
      context.userId ||
      null;
    const userEmail =
      userPayload?.email ||
      context.userEmail ||
      req.body?.email ||
      null;
    const userName = userPayload?.name || context.userName || null;
    const userRole = userPayload?.role || context.userRole || null;
    const tenantId =
      userPayload?.tenantId ||
      userPayload?.tenant?._id ||
      context.tenantId ||
      null;
    const ipAddress = resolveClientIp(req);
    const userAgent = req.get('user-agent') || null;
    const deviceInfo = detectClientDevice(userAgent);

    const details = {
      attemptedEmail: req.body?.email || null,
      email: userEmail || req.body?.email || 'unknown',
      userId,
      userEmail,
      userName,
      userRole,
      tenantId,
      method: req.method,
      path: req.path,
      resourceType: 'User',
      resourceId: userId || null,
      status,
      ip: ipAddress,
      ipAddress,
      userAgent,
      device: deviceInfo.device,
      browser: deviceInfo.browser,
      statusCode,
    };

    // Call async function but don't await (non-blocking)
    logAuditEvent(AUDIT_ACTIONS.USER_LOGIN, details).catch(err => {
      console.error('[AUDIT LOGIN ERROR]', err);
    });
    return originalJson.call(this, data);
  };
  
  next();
};

/**
 * Audit logout
 */
export const auditLogout = auditLog(AUDIT_ACTIONS.USER_LOGOUT);

/**
 * Audit unauthorized access attempts
 */
export const auditUnauthorized = (req, res) => {
  const ipAddress = resolveClientIp(req);
  logAuditEvent(AUDIT_ACTIONS.UNAUTHORIZED_ACCESS, {
    method: req.method,
    path: req.path,
    ip: ipAddress,
    ipAddress,
    userAgent: req.get('user-agent'),
    hasToken: !!req.headers.authorization,
  }).catch(err => {
    console.error('[AUDIT UNAUTHORIZED ERROR]', err);
  });
};

