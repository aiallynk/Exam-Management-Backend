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

      // Create user (default role: STUDENT)
      const user = new User({
        name,
        email,
        password,
        role: role || 'STUDENT',
      });

      await user.save();

      // Generate tokens
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
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

      // Generate tokens
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
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

      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
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

