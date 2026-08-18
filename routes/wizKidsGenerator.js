import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature, resolveTenantFeature } from '../services/tenantFeatureService.js';
import WizKidsQuestionTemplate from '../models/WizKidsQuestionTemplate.js';
import { createBankItem } from '../services/wizKidsQuestionBankService.js';
import {
  generateDeterministicQuestion,
  INITIAL_TEMPLATE_DEFINITIONS,
  WizKidsGeneratorError,
} from '../services/wizKidsQuestionGeneratorService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

const DOMAIN_CAPABILITY = Object.freeze({
  MENTAL_MATHS: 'WIZKIDS_MENTAL_MATHS',
  VEDIC_MATHS: 'WIZKIDS_VEDIC_MATHS',
  SUPER_MATHS: 'WIZKIDS_SUPER_MATHS',
  LOGIC: 'WIZKIDS_LOGIC',
});

const router = express.Router();
router.use(
  requireAuth,
  requireTenant,
  requireRole('TENANT_ADMIN', 'EXAM_CREATOR'),
  requireTenantFeature('WIZKIDS'),
  requireTenantFeature('WIZKIDS_GENERATED_QUESTIONS')
);

const respond = (error, res, next) => {
  if (error instanceof WizKidsGeneratorError) return res.status(error.status).json({ error: error.message });
  return next(error);
};

const ensureDomainEnabled = async (tenantId, domain) => {
  const capability = DOMAIN_CAPABILITY[domain];
  if (!capability) throw new WizKidsGeneratorError(400, 'Only Mental Maths, Vedic Maths, Super Maths, and Logic templates are supported.');
  const state = await resolveTenantFeature(tenantId, capability);
  if (!state?.effectiveEnabled) throw new WizKidsGeneratorError(403, `The ${capability} capability is not enabled for this tenant.`);
};

router.get('/templates', async (req, res, next) => {
  try {
    const filter = { tenantId: req.user.tenantId };
    if (req.query.domain) filter.domain = req.query.domain;
    if (req.query.status) filter.status = req.query.status;
    const templates = await WizKidsQuestionTemplate.find(filter).sort({ domain: 1, templateKey: 1, version: -1 }).lean();
    return res.json({ templates });
  } catch (error) {
    return respond(error, res, next);
  }
});

router.post('/templates/seed-initial', requireRole('TENANT_ADMIN'), async (req, res, next) => {
  try {
    const created = [];
    const skipped = [];
    const unavailable = [];
    for (const definition of INITIAL_TEMPLATE_DEFINITIONS) {
      const capability = DOMAIN_CAPABILITY[definition.domain];
      // Seeding is progressive: an enabled Mental Maths tenant can seed its
      // templates even if Vedic/Super/Logic are not yet enabled.  We never
      // create content for a disabled child capability.
      // eslint-disable-next-line no-await-in-loop
      const state = await resolveTenantFeature(req.user.tenantId, capability);
      if (!state?.effectiveEnabled) {
        unavailable.push({ templateKey: definition.templateKey, capability });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const existing = await WizKidsQuestionTemplate.findOne({ tenantId: req.user.tenantId, templateKey: definition.templateKey, version: 1 }).select('_id').lean();
      if (existing) {
        skipped.push(definition.templateKey);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const template = await WizKidsQuestionTemplate.create({
        tenantId: req.user.tenantId,
        ...definition,
        gradeLevel: 4,
        difficulty: 'MEDIUM',
        version: 1,
        status: 'PUBLISHED',
        createdBy: req.user._id,
      });
      created.push(template);
    }
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_TEMPLATE_SEEDED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'WizKidsQuestionTemplate',
      details: { created: created.map((template) => template.templateKey), skipped, unavailable },
    });
    return res.status(201).json({ templates: created, skipped, unavailable });
  } catch (error) {
    return respond(error, res, next);
  }
});

router.post(
  '/templates',
  [
    body('templateKey').trim().notEmpty(),
    body('name').trim().notEmpty(),
    body('domain').isIn(Object.keys(DOMAIN_CAPABILITY)),
    body('gradeLevel').isInt({ min: 1, max: 7 }),
    body('strategy').isIn([
      'ARITHMETIC', 'MULTI_ADD', 'CHAIN', 'MISSING_NUMBER', 'FRACTION', 'PERCENTAGE', 'POWER', 'SEQUENCE',
      'VEDIC_TIMES_ELEVEN', 'VEDIC_NEAR_BASE', 'VEDIC_SQUARE_ENDING_FIVE', 'SUPER_CHALLENGE',
      'LOGIC_ODD_ONE_OUT',
    ]),
    body('rules').optional().isObject(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      await ensureDomainEnabled(req.user.tenantId, req.body.domain);
      const template = await WizKidsQuestionTemplate.create({
        tenantId: req.user.tenantId,
        templateKey: req.body.templateKey,
        name: req.body.name,
        domain: req.body.domain,
        gradeLevel: req.body.gradeLevel,
        topic: req.body.topic || '',
        subTopic: req.body.subTopic || '',
        skill: req.body.skill || '',
        difficulty: req.body.difficulty || 'MEDIUM',
        strategy: req.body.strategy,
        rules: req.body.rules || {},
        version: 1,
        status: req.body.status || 'DRAFT',
        createdBy: req.user._id,
      });
      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_TEMPLATE_CREATED, {
        userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId,
        resourceType: 'WizKidsQuestionTemplate', resourceId: template._id,
        details: { templateKey: template.templateKey, domain: template.domain, strategy: template.strategy },
      });
      return res.status(201).json({ template });
    } catch (error) {
      return respond(error, res, next);
    }
  }
);

router.post('/:templateId/generate', validateObjectId('templateId'), [body('seed').trim().notEmpty()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const template = await WizKidsQuestionTemplate.findOne({ _id: req.params.templateId, tenantId: req.user.tenantId, status: 'PUBLISHED' }).lean();
    if (!template) return res.status(404).json({ error: 'Published template not found.' });
    await ensureDomainEnabled(req.user.tenantId, template.domain);
    return res.json({ generated: generateDeterministicQuestion({ template, seed: req.body.seed }) });
  } catch (error) {
    return respond(error, res, next);
  }
});

router.post('/:templateId/materialize', validateObjectId('templateId'), [body('seed').trim().notEmpty()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const template = await WizKidsQuestionTemplate.findOne({ _id: req.params.templateId, tenantId: req.user.tenantId, status: 'PUBLISHED' }).lean();
    if (!template) return res.status(404).json({ error: 'Published template not found.' });
    await ensureDomainEnabled(req.user.tenantId, template.domain);
    const generated = generateDeterministicQuestion({ template, seed: req.body.seed });
    const item = await createBankItem({
      tenantId: req.user.tenantId,
      createdBy: req.user._id,
      ...generated,
      status: req.body.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED',
    });
    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_GENERATED_QUESTION_MATERIALIZED, {
      userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId,
      resourceType: 'WizKidsQuestionBankItem', resourceId: item._id,
      details: { templateId: template._id, templateKey: template.templateKey, seed: generated.seed },
    });
    return res.status(201).json({ item, generated });
  } catch (error) {
    return respond(error, res, next);
  }
});

export default router;
