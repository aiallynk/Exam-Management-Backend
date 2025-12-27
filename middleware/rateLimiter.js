/**
 * Rate Limiting Middleware
 * Protects API endpoints from brute force attacks and DoS
 */

import rateLimit from 'express-rate-limit';

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
  skip: (req) => {
    return process.env.NODE_ENV === 'development';
  },
});

/**
 * Moderate rate limiter for general API endpoints
 * Prevents abuse while allowing normal usage
 * Skips rate limiting for exams routes (no limit for exam management)
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.connection?.remoteAddress || 'unknown';
  },
  // Skip rate limiting for exams routes (no limit for exam management)
  skip: (req) => {
    return req.path.startsWith('/exams') || req.originalUrl.startsWith('/api/exams');
  },
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

