import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      
      // Optionally verify user still exists
      const user = await User.findById(decoded.sub).select('-password');
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      req.user = {
        ...decoded,
        _id: decoded.sub,
      };
      next();
    } catch (error) {
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

