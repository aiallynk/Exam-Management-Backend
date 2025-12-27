/**
 * Validation Middleware
 * Provides common validation utilities for API routes
 */

import mongoose from 'mongoose';

/**
 * Validate MongoDB ObjectId
 * @param {string} id - ObjectId string to validate
 * @returns {boolean} True if valid ObjectId
 */
export function isValidObjectId(id) {
  if (!id || typeof id !== 'string') {
    return false;
  }
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Middleware to validate ObjectId parameters
 * Validates req.params.id and req.params.*Id fields
 */
export function validateObjectId(paramName = 'id') {
  return (req, res, next) => {
    const id = req.params[paramName];
    
    if (id && !isValidObjectId(id)) {
      return res.status(400).json({
        error: 'Invalid ID format',
        field: paramName,
      });
    }
    
    next();
  };
}

/**
 * Validate multiple ObjectIds from query parameters
 * @param {string[]} paramNames - Array of parameter names to validate
 */
export function validateObjectIds(...paramNames) {
  return (req, res, next) => {
    const errors = [];
    
    for (const paramName of paramNames) {
      const value = req.query[paramName] || req.body[paramName];
      if (value && !isValidObjectId(value)) {
        errors.push({
          field: paramName,
          message: 'Invalid ID format',
        });
      }
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Invalid ID format(s)',
        details: errors,
      });
    }
    
    next();
  };
}

/**
 * Sanitize pagination parameters
 * Ensures page and limit are valid numbers with reasonable limits
 */
export function sanitizePagination(req, res, next) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
  
  req.query.page = page;
  req.query.limit = limit;
  
  next();
}

