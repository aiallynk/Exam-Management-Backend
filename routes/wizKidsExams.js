import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { checkExamCreationLimit } from '../middleware/planLimits.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import {
  createWizKidsExam,
  getWizKidsExamConfig,
  listWizKidsExams,
  assignBatchToWizKidsExam,
  SUPPORTED_EXAM_MODES,
  WizKidsExamError,
} from '../services/wizKidsExamService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

// WizKids Phase 4 — Exam Integration.
//
// Full guard chain per master prompt §10. checkExamCreationLimit is the
// exact existing middleware routes/exams.js uses for maxExamsPerMonth — a
// WizKids exam counts against the same tenant-wide monthly quota as a
// standard exam (master prompt §48: "Exams/month | Existing
// maxExamsPerMonth"), not a separate WizKids-only counter.
const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('TENANT_ADMIN', 'EXAM_CREATOR'), requireTenantFeature('WIZKIDS'));

const respondToExamError = (error, res, next) => {
  if (error instanceof WizKidsExamError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
};

router.get('/', async (req, res, next) => {
  try {
    const entries = await listWizKidsExams({ tenantId: req.user.tenantId, mode: req.query.mode });
    return res.json({ exams: entries });
  } catch (error) {
    return respondToExamError(error, res, next);
  }
});

router.post(
  '/',
  checkExamCreationLimit,
  [
    body('title').trim().notEmpty().withMessage('title is required.'),
    body('duration').isInt({ min: 1 }).withMessage('duration must be a positive number of minutes.'),
    body('mode').isIn(SUPPORTED_EXAM_MODES).withMessage(`mode must be one of ${SUPPORTED_EXAM_MODES.join(', ')}.`),
    body('gradeLevel').isInt({ min: 1, max: 7 }).withMessage('gradeLevel must be between 1 and 7.'),
    body('domains').optional().isArray(),
    body('batchIds').optional().isArray(),
    body('autoAdvance').optional().isBoolean(),
    body('allowBackNavigation').optional().isBoolean(),
    body('questionTimerSeconds').optional({ nullable: true }).isInt({ min: 1 }),
    body('interactionMode').optional().isIn(['STANDARD', 'FLASH_MATHS']),
    body('flashMaths').optional().isObject(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { exam, questionPaper, config } = await createWizKidsExam({
        tenantId: req.user.tenantId,
        createdBy: req.user._id,
        title: req.body.title,
        description: req.body.description,
        duration: req.body.duration,
        gracePeriod: req.body.gracePeriod,
        maxAttempts: req.body.maxAttempts,
        mode: req.body.mode,
        gradeLevel: req.body.gradeLevel,
        domains: req.body.domains,
        batchIds: req.body.batchIds,
        autoAdvance: req.body.autoAdvance,
        allowBackNavigation: req.body.allowBackNavigation,
        questionTimerSeconds: req.body.questionTimerSeconds,
        interactionMode: req.body.interactionMode,
        flashMaths: req.body.flashMaths,
      });

      await logAuditEvent(AUDIT_ACTIONS.EXAM_CREATED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'Exam',
        resourceId: exam._id,
        details: { productModule: 'WIZKIDS', mode: config.mode, gradeLevel: config.gradeLevel, domains: config.domains },
      });

      return res.status(201).json({ exam, questionPaper, config });
    } catch (error) {
      return respondToExamError(error, res, next);
    }
  }
);

router.get('/:examId/config', validateObjectId('examId'), async (req, res, next) => {
  try {
    const config = await getWizKidsExamConfig({ tenantId: req.user.tenantId, examId: req.params.examId });
    if (!config) return res.status(404).json({ error: 'WizKids exam not found.' });
    return res.json({ config });
  } catch (error) {
    return respondToExamError(error, res, next);
  }
});

router.post(
  '/:examId/assign-batch',
  validateObjectId('examId'),
  [body('batchId').isMongoId()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const results = await assignBatchToWizKidsExam({
        tenantId: req.user.tenantId,
        examId: req.params.examId,
        batchId: req.body.batchId,
        assignedBy: req.user._id,
      });

      const assignedCount = results.filter((result) => result.status === 'assigned').length;
      await logAuditEvent(AUDIT_ACTIONS.EXAM_UPDATED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'Exam',
        resourceId: req.params.examId,
        details: { action: 'WIZKIDS_BATCH_ASSIGNED', batchId: req.body.batchId, requested: results.length, assigned: assignedCount, results },
      });

      return res.json({ results });
    } catch (error) {
      return respondToExamError(error, res, next);
    }
  }
);

export default router;
