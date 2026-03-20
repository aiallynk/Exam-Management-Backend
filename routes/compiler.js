import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { autosaveCode, runCode, submitCode } from '../controllers/compilerController.js';
import { FREE_PLAN_MESSAGES, isPlanFeatureEnabled } from '../config/planLimits.js';
import {
  blockFreePlanByAttemptId,
  blockFreePlanByQuestionId,
  resolveUserEffectivePlanType,
  sendPlanRestriction,
} from '../middleware/planRestrictions.js';

const router = express.Router();
const blockFreePlanCodingAttempt = blockFreePlanByAttemptId(
  FREE_PLAN_MESSAGES.CODING_LOCKED,
  'codingCompiler'
);
const blockFreePlanCodingQuestion = blockFreePlanByQuestionId(
  FREE_PLAN_MESSAGES.CODING_LOCKED,
  'codingCompiler'
);

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  return next();
};

router.post(
  '/autosave',
  requireAuth,
  [
    body('attemptId').isMongoId().withMessage('attemptId must be a valid id.'),
    body('questionId').isMongoId().withMessage('questionId must be a valid id.'),
    body('language').trim().notEmpty().withMessage('Language is required.'),
    body('code').optional().isString().withMessage('Code must be a string.'),
    body('input').optional().isString().withMessage('Input must be a string.'),
  ],
  validateRequest,
  blockFreePlanCodingAttempt,
  autosaveCode
);

router.post(
  '/run',
  requireAuth,
  [
    body('language').trim().notEmpty().withMessage('Language is required.'),
    body('code').trim().notEmpty().withMessage('Code is required.'),
    body('input').optional().isString().withMessage('Input must be a string.'),
    body('questionId').optional().isMongoId().withMessage('questionId must be a valid id.'),
    body('timeLimit').optional().isNumeric().withMessage('timeLimit must be numeric.'),
    body('memoryLimit').optional().isNumeric().withMessage('memoryLimit must be numeric.'),
  ],
  validateRequest,
  blockFreePlanCodingQuestion,
  async (req, res, next) => {
    try {
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      if (!req.body?.questionId && !isPlanFeatureEnabled(effectivePlanType, 'codingCompiler')) {
        return sendPlanRestriction(res, FREE_PLAN_MESSAGES.CODING_LOCKED);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  },
  runCode
);

router.post(
  '/submit',
  requireAuth,
  [
    body('attemptId').isMongoId().withMessage('attemptId must be a valid id.'),
    body('questionId').isMongoId().withMessage('questionId must be a valid id.'),
    body('language').trim().notEmpty().withMessage('Language is required.'),
    body('code').trim().notEmpty().withMessage('Code is required.'),
    body('input').optional().isString().withMessage('Input must be a string.'),
  ],
  validateRequest,
  blockFreePlanCodingAttempt,
  submitCode
);

export default router;
