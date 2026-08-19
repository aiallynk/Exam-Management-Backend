import express from 'express';
import { body, validationResult } from 'express-validator';
import Exam from '../models/Exam.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { checkQuestionLimit } from '../middleware/planLimits.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { syncExamQuestionCount } from '../utils/planUsage.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';
import {
  WizKidsFlashMathsError,
  advanceFlashRound,
  completeFlashAttempt,
  createFlashRounds,
  getOrStartFlashAttempt,
  submitFlashAnswer,
} from '../services/wizKidsFlashMathsService.js';

const router = express.Router();
const baseGuards = [requireAuth, requireTenant, requireTenantFeature('WIZKIDS'), requireTenantFeature('WIZKIDS_SPEED_MODE')];

const respond = (error, res, next) => error instanceof WizKidsFlashMathsError
  ? res.status(error.status).json({ error: error.message })
  : next(error);

const prepareQuestionCount = (req, _res, next) => {
  req.planLimitContext = { ...(req.planLimitContext || {}), questionsToAdd: Number(req.body?.count) || 0 };
  next();
};

router.post(
  '/exams/:examId/rounds',
  ...baseGuards,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  [body('questionPaperId').isMongoId(), body('count').isInt({ min: 1, max: 20 }), body('seedBase').optional().isString().isLength({ min: 1, max: 120 })],
  prepareQuestionCount,
  checkQuestionLimit,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const exam = await Exam.findOne({ _id: req.params.examId, tenantId: req.user.tenantId, productModule: 'WIZKIDS' }).select('_id createdBy').lean();
      if (!exam) return res.status(404).json({ error: 'Junior Exam not found.' });
      if (req.user.role !== 'TENANT_ADMIN' && String(exam.createdBy) !== String(req.user._id)) {
        return res.status(403).json({ error: 'Only the exam owner can add Flash Maths rounds.' });
      }
      const rounds = await createFlashRounds({
        tenantId: req.user.tenantId,
        examId: exam._id,
        questionPaperId: req.body.questionPaperId,
        count: Number(req.body.count),
        seedBase: String(req.body.seedBase || `${exam._id}:${Date.now()}`),
        createdBy: req.user._id,
      });
      await syncExamQuestionCount(exam._id);
      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_FLASH_ROUNDS_CREATED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'Exam',
        resourceId: exam._id,
        details: { questionPaperId: req.body.questionPaperId, generatedCount: rounds.length },
      });
      return res.status(201).json({
        questions: rounds.map((entry) => entry.question),
        generatedCount: rounds.length,
      });
    } catch (error) {
      return respond(error, res, next);
    }
  }
);

router.post('/attempts/:attemptId/start', ...baseGuards, requireRole('CANDIDATE'), validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const payload = await getOrStartFlashAttempt({ tenantId: req.user.tenantId, userId: req.user._id, attemptId: req.params.attemptId });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_FLASH_STARTED, { userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId, resourceType: 'ExamAttempt', resourceId: req.params.attemptId, details: { totalRounds: payload.progress?.total } });
    return res.json(payload);
  } catch (error) { return respond(error, res, next); }
});

router.get('/attempts/:attemptId', ...baseGuards, requireRole('CANDIDATE'), validateObjectId('attemptId'), async (req, res, next) => {
  try {
    return res.json(await getOrStartFlashAttempt({ tenantId: req.user.tenantId, userId: req.user._id, attemptId: req.params.attemptId }));
  } catch (error) { return respond(error, res, next); }
});

router.post(
  '/attempts/:attemptId/answer',
  ...baseGuards,
  requireRole('CANDIDATE'),
  validateObjectId('attemptId'),
  [body('questionId').isMongoId(), body('answer').optional({ nullable: true })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const payload = await submitFlashAnswer({ tenantId: req.user.tenantId, userId: req.user._id, attemptId: req.params.attemptId, questionId: req.body.questionId, answer: req.body.answer });
      if (!payload.duplicate) await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_FLASH_ANSWER_RECORDED, { userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId, resourceType: 'Answer', resourceId: req.body.questionId, details: { attemptId: req.params.attemptId, questionId: req.body.questionId } });
      return res.json(payload);
    } catch (error) { return respond(error, res, next); }
  }
);

router.post('/attempts/:attemptId/next', ...baseGuards, requireRole('CANDIDATE'), validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const payload = await advanceFlashRound({ tenantId: req.user.tenantId, userId: req.user._id, attemptId: req.params.attemptId });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_FLASH_ROUND_ADVANCED, { userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId, resourceType: 'ExamAttempt', resourceId: req.params.attemptId, details: { progress: payload.progress || null } });
    return res.json(payload);
  } catch (error) { return respond(error, res, next); }
});

router.post('/attempts/:attemptId/complete', ...baseGuards, requireRole('CANDIDATE'), validateObjectId('attemptId'), async (req, res, next) => {
  try {
    const result = await completeFlashAttempt({ tenantId: req.user.tenantId, userId: req.user._id, attemptId: req.params.attemptId });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_ATTEMPT_COMPLETED, { userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId, resourceType: 'ExamAttempt', resourceId: req.params.attemptId, details: { interactionMode: 'FLASH_MATHS', score: result.score || null, alreadyCompleted: result.alreadyCompleted } });
    return res.json(result);
  } catch (error) { return respond(error, res, next); }
});

export default router;
