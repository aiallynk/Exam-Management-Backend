import config from '../config/env.js';
import { logError } from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
  logError(err, `${req.method} ${req.path}`);

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      error: 'Validation error',
      details: errors,
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(409).json({
      error: 'Duplicate entry',
      message: `${field} already exists`,
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }

  // Default error
  const statusCode = err.statusCode || 500;
  const message =
    config.nodeEnv === 'production' && statusCode === 500
      ? 'Internal server error'
      : err.message || 'Something went wrong';

  res.status(statusCode).json({
    error: message,
    ...(config.nodeEnv !== 'production' && { stack: err.stack }),
  });
};

export const notFound = (req, res, next) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
  });
};

