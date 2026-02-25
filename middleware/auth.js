import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';
import { isBlacklisted } from '../utils/tokenBlacklist.js';
import { auditUnauthorized } from './audit.js';

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      auditUnauthorized(req, res);
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    
    // Check if token is blacklisted
    if (isBlacklisted(token)) {
      return res.status(401).json({ error: 'Token has been invalidated' });
    }
    
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      
      // Optionally verify user still exists
      const user = await User.findById(decoded.sub).select('-password');
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Check user status
      if (user.status && user.status !== 'ACTIVE' && user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      req.user = {
        ...decoded,
        _id: decoded.sub,
        role: user.role,
        tenantId: decoded.tenantId || user.tenantId?.toString() || null,
        planType: user.planType,
      };
      next();
    } catch (error) {
      auditUnauthorized(req, res);
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Authentication error' });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      try {
        const decoded = jwt.verify(token, config.jwtSecret);
        const user = await User.findById(decoded.sub).select('-password');
        if (user) {
          req.user = {
            ...decoded,
            _id: decoded.sub,
          };
        }
      } catch (error) {
        // Ignore token errors for optional auth
      }
    }
    next();
  } catch (error) {
    next();
  }
};

