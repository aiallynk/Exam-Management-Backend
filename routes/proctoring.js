import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validateObjectId } from '../middleware/validation.js';
import * as proctoringService from '../services/proctoringService.js';

const router = express.Router();

// Log device info
router.post(
  '/attempt/:attemptId/device-info',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      await proctoringService.logDeviceInfo(req.params.attemptId, req.body);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// Check multiple logins
router.get(
  '/check-multiple-logins',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await proctoringService.checkMultipleLogins(
        req.user._id,
        req.query.examId,
        req.query
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Record tab switch
router.post(
  '/attempt/:attemptId/tab-switch',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      await proctoringService.recordTabSwitch(req.params.attemptId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// Record window blur
router.post(
  '/attempt/:attemptId/window-blur',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      await proctoringService.recordWindowBlur(req.params.attemptId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// Record copy/paste attempt
router.post(
  '/attempt/:attemptId/copy-paste',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      await proctoringService.recordCopyPasteAttempt(req.params.attemptId, req.body.action);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// Record right-click attempt
router.post(
  '/attempt/:attemptId/right-click',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      await proctoringService.recordRightClickAttempt(req.params.attemptId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// Record keyboard shortcut
router.post(
  '/attempt/:attemptId/keyboard-shortcut',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      await proctoringService.recordKeyboardShortcut(req.params.attemptId, req.body.shortcut);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// Get suspicious activity
router.get(
  '/attempt/:attemptId/suspicious-activity',
  requireAuth,
  validateObjectId('attemptId'),
  async (req, res, next) => {
    try {
      const result = await proctoringService.getSuspiciousActivitySummary(req.params.attemptId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
