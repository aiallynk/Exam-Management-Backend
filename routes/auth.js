import express from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();

// Register
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
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

      // Validate role (SUPER_ADMIN cannot register - must be created manually)
      const validRoles = ['STUDENT', 'TEACHER', 'INSTITUTE_ADMIN', 'ORG_ADMIN'];
      const selectedRole = role || 'STUDENT';
      
      // Map legacy roles for backward compatibility
      const roleMapping = {
        'DESIGNER': 'TEACHER',
        'ADMIN': 'INSTITUTE_ADMIN',
      };
      const mappedRole = roleMapping[selectedRole] || selectedRole;
      
      // Prevent SUPER_ADMIN registration
      if (selectedRole === 'SUPER_ADMIN' || mappedRole === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Super Admin accounts cannot be created through registration' });
      }
      
      if (!validRoles.includes(mappedRole)) {
        return res.status(400).json({ error: 'Invalid role for registration' });
      }

      // Create user
      // SUPER_ADMIN doesn't need organizationId/instituteId
      // Other roles will have organizationId/instituteId set to null initially (must be assigned by admin)
      const userData = {
        name,
        email,
        password,
        role: mappedRole,
      };

      // Only set organizationId/instituteId for non-SUPER_ADMIN roles (but they'll be null initially)
      if (mappedRole !== 'SUPER_ADMIN') {
        // organizationId and instituteId will be null initially - must be assigned by admin
        // User model validation will enforce tenant assignment later
      }

      const user = new User(userData);

      await user.save();

      // Populate organization and institute info (if applicable)
      if (user.organizationId) {
        await user.populate('organizationId', 'name code status');
      }
      if (user.instituteId) {
        await user.populate('instituteId', 'name code status');
      }

      // Generate tokens with multi-tenant info
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId?._id?.toString() || null,
          instituteId: user.instituteId?._id?.toString() || null,
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
          organizationId: user.organizationId?._id || null,
          instituteId: user.instituteId?._id || null,
          organization: user.organizationId || null,
          institute: user.instituteId || null,
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
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check password
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check user status
      if (user.status && user.status !== 'ACTIVE' && user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      // Populate organization and institute info
      await user.populate('organizationId', 'name code status');
      await user.populate('instituteId', 'name code status');

      // Generate tokens with multi-tenant info
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId?._id?.toString() || null,
          instituteId: user.instituteId?._id?.toString() || null,
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
          organizationId: user.organizationId?._id || null,
          instituteId: user.instituteId?._id || null,
          organization: user.organizationId || null,
          institute: user.instituteId || null,
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

    try {
      const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
      const user = await User.findById(decoded.sub).select('-password');
      
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Populate organization and institute info
      await user.populate('organizationId', 'name code status');
      await user.populate('instituteId', 'name code status');

      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId?._id?.toString() || null,
          instituteId: user.instituteId?._id?.toString() || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      res.json({ accessToken });
    } catch (error) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
  } catch (error) {
    next(error);
  }
});

// Logout (client-side token removal, server can maintain denylist if needed)
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// Get current user
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

export default router;

