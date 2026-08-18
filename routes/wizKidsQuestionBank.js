import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import {
  createBankItem,
  listBankItems,
  getBankItemForTenant,
  updateBankItem,
  setBankItemStatus,
  materializeQuestion,
  listMaterializations,
  WizKidsQuestionBankError,
} from '../services/wizKidsQuestionBankService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

// WizKids Phase 5 — Reusable Question Bank.
// Full guard chain per master prompt §10. Question-bank authoring is a
// Teacher/Tenant-Admin capability, matching Phase 4's exam-creation router.
const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('TENANT_ADMIN', 'EXAM_CREATOR'), requireTenantFeature('WIZKIDS'));

const respondToBankError = (error, res, next) => {
  if (error instanceof WizKidsQuestionBankError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
};

router.get('/', async (req, res, next) => {
  try {
    const items = await listBankItems({
      tenantId: req.user.tenantId,
      domain: req.query.domain,
      gradeLevel: req.query.gradeLevel,
      status: req.query.status,
    });
    return res.json({ items });
  } catch (error) {
    return respondToBankError(error, res, next);
  }
});

router.post(
  '/',
  [
    body('domain').isIn(['MENTAL_MATHS', 'VEDIC_MATHS', 'SUPER_MATHS', 'LOGIC', 'OLYMPIAD']),
    body('gradeLevel').isInt({ min: 1, max: 7 }),
    body('interactionType').isIn(['MCQ', 'NUMBER', 'SHORT_ANSWER', 'FILL_IN_THE_BLANK', 'MATCHING', 'IMAGE']),
    body('questionContent').trim().notEmpty(),
    body('correctAnswer').exists({ checkNull: true }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const item = await createBankItem({
        tenantId: req.user.tenantId,
        createdBy: req.user._id,
        domain: req.body.domain,
        gradeLevel: req.body.gradeLevel,
        topic: req.body.topic,
        subTopic: req.body.subTopic,
        skill: req.body.skill,
        difficulty: req.body.difficulty,
        interactionType: req.body.interactionType,
        questionContent: req.body.questionContent,
        options: req.body.options,
        correctAnswer: req.body.correctAnswer,
        solution: req.body.solution,
        explanation: req.body.explanation,
        media: req.body.media,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_QUESTION_BANK_ITEM_CREATED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsQuestionBankItem',
        resourceId: item._id,
        details: { domain: item.domain, gradeLevel: item.gradeLevel, interactionType: item.interactionType },
      });

      return res.status(201).json({ item });
    } catch (error) {
      return respondToBankError(error, res, next);
    }
  }
);

router.get('/:bankItemId', validateObjectId('bankItemId'), async (req, res, next) => {
  try {
    const item = await getBankItemForTenant({ tenantId: req.user.tenantId, bankItemId: req.params.bankItemId });
    if (!item) return res.status(404).json({ error: 'Question bank item not found.' });
    return res.json({ item });
  } catch (error) {
    return respondToBankError(error, res, next);
  }
});

router.put('/:bankItemId', validateObjectId('bankItemId'), async (req, res, next) => {
  try {
    const item = await updateBankItem({
      tenantId: req.user.tenantId,
      bankItemId: req.params.bankItemId,
      updates: req.body,
    });
    return res.json({ item });
  } catch (error) {
    return respondToBankError(error, res, next);
  }
});

router.patch(
  '/:bankItemId/status',
  validateObjectId('bankItemId'),
  [body('status').isIn(['DRAFT', 'PUBLISHED', 'ARCHIVED'])],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const item = await setBankItemStatus({
        tenantId: req.user.tenantId,
        bankItemId: req.params.bankItemId,
        status: req.body.status,
      });
      return res.json({ item });
    } catch (error) {
      return respondToBankError(error, res, next);
    }
  }
);

router.post(
  '/:bankItemId/materialize',
  validateObjectId('bankItemId'),
  [
    body('examId').isMongoId(),
    body('questionPaperId').isMongoId(),
    body('sectionId').optional().isMongoId(),
    body('points').optional().isFloat({ min: 0 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { question, link } = await materializeQuestion({
        tenantId: req.user.tenantId,
        bankItemId: req.params.bankItemId,
        examId: req.body.examId,
        questionPaperId: req.body.questionPaperId,
        sectionId: req.body.sectionId,
        points: req.body.points,
        materializedBy: req.user._id,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_QUESTION_MATERIALIZED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'Question',
        resourceId: question._id,
        details: { source: 'WIZKIDS_QUESTION_BANK', bankItemId: req.params.bankItemId, linkId: link._id },
      });

      return res.status(201).json({ question, link });
    } catch (error) {
      return respondToBankError(error, res, next);
    }
  }
);

router.get('/:bankItemId/materializations', validateObjectId('bankItemId'), async (req, res, next) => {
  try {
    const links = await listMaterializations({ tenantId: req.user.tenantId, bankItemId: req.params.bankItemId });
    return res.json({ links });
  } catch (error) {
    return respondToBankError(error, res, next);
  }
});

export default router;
