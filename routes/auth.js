import express from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { addToBlacklist, isBlacklisted } from '../utils/tokenBlacklist.js';
import { validatePasswordStrength as validatePassword } from '../utils/passwordValidator.js';
import { auditLogin, auditLogout } from '../middleware/audit.js';

const router = express.Router();

/**
 * Register - Create new user account
 * 
 * Simple flow:
 * - Only EXAM_CREATOR and CANDIDATE roles can register
 * - SUPER_ADMIN cannot register (must be created manually)
 * - Users start without tenantId (must be assigned by SUPER_ADMIN)
 */
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password')
      .custom((value) => {
        try {
          validatePassword(value);
          return true;
        } catch (error) {
          throw new Error(error.message);
        }
      })
      .withMessage('Password does not meet strength requirements'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role } = req.body;

      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Simple role system: Only EXAM_CREATOR and CANDIDATE can register
      // SUPER_ADMIN cannot register - must be created manually
      const validRoles = ['EXAM_CREATOR', 'CANDIDATE'];
      const selectedRole = role || 'CANDIDATE';
      
      // Prevent SUPER_ADMIN registration
      if (selectedRole === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Super Admin accounts cannot be created through registration' });
      }
      
      // Validate role
      if (!validRoles.includes(selectedRole)) {
        return res.status(400).json({ error: 'Invalid role for registration. Must be EXAM_CREATOR or CANDIDATE' });
      }

      // Create user
      // Users will have tenantId set to null initially (must be assigned by Super Admin)
      const userData = {
        name,
        email,
        password,
        role: selectedRole,
      };

      const user = new User(userData);

      await user.save();

      // Populate tenant info (if applicable)
      if (user.tenantId) {
        await user.populate('tenantId', 'name code status type');
      }

      // Generate tokens with tenant info
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId?._id?.toString() || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      const refreshToken = jwt.sign(
        { sub: user._id },
        config.jwtRefreshSecret,
        { expiresIn: `${config.refreshTtlDays}d` }
      );

      res.status(201).json({
        accessToken,
        refreshToken,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId?._id || null,
          tenant: user.tenantId || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Login
router.post(
  '/login',
  auditLogin,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;

      // Find user
      const user = await User.findOne({ email });
      if (!user) {
        // In development, provide more helpful error message
        if (process.env.NODE_ENV === 'development') {
          console.log(`⚠️  Login attempt failed: User not found - ${email}`);
          // Check if similar email exists (case-insensitive)
          const similarUser = await User.findOne({ 
            email: { $regex: new RegExp(email.split('@')[0], 'i') } 
          });
          if (similarUser) {
            console.log(`💡 Hint: Found similar user: ${similarUser.email}`);
          }
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check password
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        // In development, log password mismatch
        if (process.env.NODE_ENV === 'development') {
          console.log(`⚠️  Login attempt failed: Password mismatch for ${email}`);
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check user status
      if (user.status && user.status !== 'ACTIVE' && user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      // Populate tenant info
      await user.populate('tenantId', 'name code status type');

      // Generate tokens with tenant info
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId?._id?.toString() || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      const refreshToken = jwt.sign(
        { sub: user._id },
        config.jwtRefreshSecret,
        { expiresIn: `${config.refreshTtlDays}d` }
      );

      res.json({
        accessToken,
        refreshToken,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId?._id || null,
          tenant: user.tenantId || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Refresh token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Check if refresh token is blacklisted
    if (isBlacklisted(refreshToken)) {
      return res.status(401).json({ error: 'Refresh token has been invalidated' });
    }

    try {
      const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
      const user = await User.findById(decoded.sub).select('-password');
      
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Populate tenant info
      await user.populate('tenantId', 'name code status type');

      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId?._id?.toString() || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      res.json({
        accessToken,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId?._id || null,
          tenant: user.tenantId || null,
        },
      });
    } catch (error) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
  } catch (error) {
    next(error);
  }
});

// Logout (blacklist tokens to prevent reuse)
router.post('/logout', requireAuth, auditLogout, async (req, res) => {
  try {
    // Get tokens from request
    const authHeader = req.headers.authorization;
    const accessToken = authHeader?.replace('Bearer ', '');
    const refreshToken = req.body.refreshToken; // Client should send refresh token
    
    // Blacklist access token (if provided)
    if (accessToken) {
      // Access tokens expire in tokenTtlMinutes, convert to seconds
      const expiresInSeconds = config.tokenTtlMinutes * 60;
      addToBlacklist(accessToken, expiresInSeconds);
    }
    
    // Blacklist refresh token (if provided)
    if (refreshToken) {
      try {
        // Verify token to get expiry, then blacklist it
        const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
        // Refresh tokens expire in refreshTtlDays, convert to seconds
        const expiresInSeconds = config.refreshTtlDays * 24 * 60 * 60;
        addToBlacklist(refreshToken, expiresInSeconds);
      } catch (error) {
        // If refresh token is invalid, ignore (might already be expired)
        // Still proceed with logout
      }
    }
    
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    // Even if blacklisting fails, return success (client-side cleanup still works)
    res.json({ message: 'Logged out successfully' });
  }
});

// Get current user
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password')
      .populate('tenantId', 'name code status uniqueId type');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

export default router;

