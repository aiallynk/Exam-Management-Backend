import config from '../config/env.js';
import { logError } from '../utils/logger.js';
import { emitSystemFailureAlert } from '../services/systemAlertService.js';

export const errorHandler = (err, req, res, next) => {
  logError(err, `${req.method} ${req.path}`);

  // Standardized error response structure
  const createErrorResponse = (statusCode, error, message, details = null) => {
    if (statusCode >= 500) {
      emitSystemFailureAlert({
        title: 'System API Failure',
        message: `${error || 'Internal server error'} on ${req.method} ${req.path}`,
        method: req.method,
        path: req.path,
        statusCode,
        errorMessage: err?.message || message || '',
        stack: err?.stack || '',
      }).catch((alertError) => {
        console.error(
          '[SYSTEM ALERT] Failed to emit API failure alert:',
          alertError?.message || alertError
        );
      });
    }

    const response = {
      error,
      message,
      ...(details && { details }),
      ...(config.nodeEnv !== 'production' && statusCode === 500 && { stack: err.stack }),
    };
    return res.status(statusCode).json(response);
  };

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return createErrorResponse(400, 'Validation error', 'Invalid input data', errors);
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return createErrorResponse(409, 'Duplicate entry', `${field} already exists`);
  }

  // Mongoose CastError (invalid ObjectId)
  if (err.name === 'CastError') {
    return createErrorResponse(400, 'Invalid ID', 'The provided ID is invalid');
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return createErrorResponse(401, 'Invalid token', 'Authentication token is invalid');
  }

  if (err.name === 'TokenExpiredError') {
    return createErrorResponse(401, 'Token expired', 'Authentication token has expired');
  }

  // MongoDB connection errors
  if (err.name === 'MongoServerError' || err.name === 'MongoNetworkError') {
    return createErrorResponse(503, 'Database error', 'Database connection error. Please try again later.');
  }

  // Request timeout errors
  if (err.message && err.message.includes('timeout')) {
    return createErrorResponse(408, 'Request timeout', 'The request took too long to process');
  }

  // Custom error with status code
  if (err.statusCode) {
    return createErrorResponse(
      err.statusCode,
      err.name || 'Error',
      err.message || 'An error occurred',
      err.details
    );
  }

  // Default error (500)
  const statusCode = 500;
  const message =
    config.nodeEnv === 'production'
      ? 'Internal server error'
      : err.message || 'Something went wrong';

  return createErrorResponse(statusCode, 'Internal server error', message);
};

export const notFound = (req, res, next) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
  });
};

