/**
 * Rate Limiting Middleware
 * Protects API endpoints from brute force attacks and DoS
 */

import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';

const isDevelopmentMode = () => config.nodeEnv === 'development';
const isDisposableE2E = () =>
  config.nodeEnv === 'test' && process.env.XAMIGO_E2E_DISPOSABLE === 'true';
const skipLocalAutomation = () => isDevelopmentMode() || isDisposableE2E();

const SAFE_READ_METHODS = new Set(['GET', 'HEAD']);

// The common workspace shell makes a number of harmless reads (features,
// context, notifications and plan usage) when it starts.  They must not all
// consume one small, shared NAT/proxy IP budget.  Authentication is still
// enforced by the route middleware; this only derives a safe grouping key
// from an already signed bearer token before those route middlewares run.
export const API_RATE_LIMITS = Object.freeze({
  AUTHENTICATED_READ: 600,
  AUTHENTICATED_MUTATION: 240,
  ANONYMOUS_READ: 300,
  ANONYMOUS_MUTATION: 100,
});

const bearerTokenFromRequest = (req) => {
  const header = String(req?.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
};

export const resolveApiRateLimitPrincipal = (req) => {
  if (req?._apiRateLimitPrincipal !== undefined) return req._apiRateLimitPrincipal;

  const token = bearerTokenFromRequest(req);
  if (!token) {
    req._apiRateLimitPrincipal = '';
    return '';
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const userId = String(decoded?.sub || '').trim();
    if (!userId) {
      req._apiRateLimitPrincipal = '';
      return '';
    }
    const tenantId = String(decoded?.tenantId || 'platform').trim() || 'platform';
    const principal = `user:${userId}:tenant:${tenantId}`;
    req._apiRateLimitPrincipal = principal;
    return principal;
  } catch {
    // Invalid, expired, or blacklisted tokens must continue to share the
    // anonymous IP budget until requireAuth rejects them later in the chain.
    req._apiRateLimitPrincipal = '';
    return '';
  }
};

export const resolveApiRateLimitKey = (req) => {
  const principal = resolveApiRateLimitPrincipal(req);
  if (principal) return principal;
  return `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
};

export const resolveApiRateLimitMax = (req) => {
  const authenticated = Boolean(resolveApiRateLimitPrincipal(req));
  const safeRead = SAFE_READ_METHODS.has(String(req?.method || '').toUpperCase());
  if (authenticated && safeRead) return API_RATE_LIMITS.AUTHENTICATED_READ;
  if (authenticated) return API_RATE_LIMITS.AUTHENTICATED_MUTATION;
  if (safeRead) return API_RATE_LIMITS.ANONYMOUS_READ;
  return API_RATE_LIMITS.ANONYMOUS_MUTATION;
};

export const shouldSkipApiRateLimitPath = (req) => {
  const method = String(req?.method || '').toUpperCase();
  if (method === 'OPTIONS') return true;

  const path = req?.path || req?.originalUrl || '';
  // These routes have their own purpose-specific, stricter limits.  Applying
  // the general limiter first made authentication and uploads depend on an
  // unrelated workspace-read request budget.
  if (
    path.startsWith('/auth') ||
    path.startsWith('/api/auth') ||
    path.startsWith('/upload') ||
    path.startsWith('/api/upload')
  ) return true;

  return path.startsWith('/exams') ||
    path.startsWith('/api/exams') ||
    path.startsWith('/exam-sessions') ||
    path.startsWith('/api/exam-sessions') ||
    path.startsWith('/exam-attempts') ||
    path.startsWith('/api/exam-attempts') ||
    path.startsWith('/sections') ||
    path.startsWith('/api/sections') ||
    path.startsWith('/proctoring') ||
    path.startsWith('/api/proctoring');
};

export const shouldSkipApiRateLimit = (req) =>
  skipLocalAutomation() || shouldSkipApiRateLimitPath(req);

/**
 * Rate limiter for authentication endpoints
 * Prevents brute force attacks while allowing normal usage
 * More lenient to avoid blocking legitimate users
 * 
 * Note: Increased limits to prevent false positives during normal usage
 * - 30 requests per 15 minutes allows for multiple login attempts
 * - skipSuccessfulRequests: true means successful logins don't count
 * - Only failed attempts count towards the limit
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 requests per windowMs (increased from 5)
  message: {
    error: 'Too many authentication attempts, please try again later.',
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip rate limiting for successful requests (2xx status codes)
  // This means only failed login attempts count towards the limit
  skipSuccessfulRequests: true,
  // Use IP address for key
  keyGenerator: (req) => {
    // Use IP from request, fallback to connection remoteAddress
    return req.ip || req.connection?.remoteAddress || 'unknown';
  },
  // Skip rate limiting in development mode
  skip: skipLocalAutomation,
});

/**
 * Moderate rate limiter for general API endpoints
 * Prevents abuse while allowing normal usage
 * Keeps a meaningful anti-abuse budget without making all authenticated
 * workspace users behind one NAT/proxy exhaust the same tiny counter.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: resolveApiRateLimitMax,
  message: {
    error: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveApiRateLimitKey,
  skip: shouldSkipApiRateLimit,
});

/**
 * Strict rate limiter for AI endpoints
 * Prevents abuse of expensive AI operations
 */
export const aiRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 AI requests per hour
  message: {
    error: 'Too many AI requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.connection?.remoteAddress || 'unknown';
  },
  // Skip AI throttling during local development so exam creation work is not blocked.
  skip: skipLocalAutomation,
});

/**
 * Strict rate limiter for file upload endpoints
 * Prevents abuse of storage resources
 */
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 uploads per hour
  message: {
    error: 'Too many file uploads, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.connection?.remoteAddress || 'unknown';
  },
  skip: skipLocalAutomation,
});

/**
 * No-limit rate limiter for exams endpoints
 * Allows unlimited requests for exam management operations
 */
export const noLimitRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Very high limit - effectively unlimited
  message: {
    error: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.connection?.remoteAddress || 'unknown';
  },
  // Skip rate limiting entirely
  skip: () => true,
});
