/**
 * CSRF Protection Middleware
 * 
 * For JWT-based APIs, CSRF is less critical since tokens are in Authorization headers
 * (not cookies), but we add defense-in-depth protection.
 * 
 * Strategy: Require a custom header that browsers can't set from other origins
 * This prevents simple CSRF attacks while maintaining compatibility with SPAs
 */

/**
 * CSRF protection middleware
 * Requires a custom header for state-changing requests (POST, PUT, PATCH, DELETE)
 * Browsers cannot set custom headers in cross-origin requests without CORS preflight
 */
export const csrfProtection = (req, res, next) => {
  // Skip CSRF check for safe methods (GET, HEAD, OPTIONS)
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Skip CSRF check for health check endpoint
  if (req.path === '/health') {
    return next();
  }

  // Require custom header for state-changing requests
  // This header cannot be set by browsers in cross-origin requests without CORS preflight
  const csrfHeader = req.headers['x-requested-with'];
  
  // Allow if header is present (SPA will set this)
  // OR if request is from same origin (checked via referer/origin)
  if (csrfHeader === 'XMLHttpRequest' || csrfHeader === 'Fetch') {
    return next();
  }

  // Check if request appears to be from same origin (defense-in-depth)
  const origin = req.headers.origin || req.headers.referer;
  const host = req.get('host');
  
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname === host.split(':')[0] || 
          originUrl.hostname === 'localhost' || 
          originUrl.hostname === '127.0.0.1') {
        return next();
      }
    } catch (e) {
      // Invalid origin, continue to check
    }
  }

  // In development, be more lenient
  if (process.env.NODE_ENV === 'development') {
    console.warn('⚠️  CSRF protection: Missing X-Requested-With header. Allowing in development.');
    return next();
  }

  // Reject request
  return res.status(403).json({
    error: 'CSRF protection: Request must include X-Requested-With header',
  });
};

