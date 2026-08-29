import express from 'express';
import AssessmentFramework from '../models/AssessmentFramework.js';
import FrameworkVersion from '../models/FrameworkVersion.js';
import RubricTemplate from '../models/RubricTemplate.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { resolveAssessmentSpecification } from '../services/assessmentSpecificationResolver.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import { resolveAcademicVisibility } from '../services/academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { isGlobalGovernanceScope, isGovernanceScopeReadable } from '../utils/governanceScope.js';
import { validateCognitiveDemandDistribution } from '../utils/cognitiveDemand.js';
const router = express.Router();

// Part C: LOT+MOT+HOT must equal 100 when a percentage distribution is
// configured — rejected outright, never silently normalized. Checks both
// the paper-level distribution and any section-level override object
// (rules.cognitiveDemandDistribution.sections: { [sectionName]: {LOT,MOT,HOT} }).
const assertCognitiveDemandRulesValid = (rules) => {
  const distribution = rules?.cognitiveDemandDistribution;
  if (!distribution) return;
  const { sections, ...paperLevel } = distribution;
  if (Object.keys(paperLevel).length) {
    const result = validateCognitiveDemandDistribution(paperLevel);
    if (!result.valid) {
      const error = new Error(`Invalid paper-level cognitive demand distribution: ${result.error}`);
      error.statusCode = 400;
      throw error;
    }
  }
  if (sections && typeof sections === 'object') {
    Object.entries(sections).forEach(([sectionName, sectionDistribution]) => {
      const result = validateCognitiveDemandDistribution(sectionDistribution);
      if (!result.valid) {
        const error = new Error(`Invalid cognitive demand distribution for section "${sectionName}": ${result.error}`);
        error.statusCode = 400;
        throw error;
      }
    });
  }
};
const canRead = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'EXAM_CREATOR', 'TEACHER')];
const canGovern = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN')];
const canResolve = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'EXAM_CREATOR')];
const manage = canGovern;
const assertGovernanceScope = async (user, scope = {}, { allowGlobal = false } = {}) => {
  const visibility = await resolveAcademicVisibility(user);
  if (visibility.all) return visibility;
  if (!allowGlobal && isGlobalGovernanceScope(scope)) {
    const error = new Error('A bounded Academic Admin must select an academic scope.'); error.status = 403; throw error;
  }
  if (!isGovernanceScopeReadable(visibility, scope)) {
    const error = new Error('This framework or rubric is outside your delegated academic scope.'); error.status = 403; throw error;
  }
  return visibility;
};
const filterReadableItems = async (user, items, scopeField) => {
  const visibility = await resolveAcademicVisibility(user);
  return items.filter((item) => isGovernanceScopeReadable(visibility, item?.[scopeField] || {}));
};
const loadScopedFramework = async (req) => {
  const item = await AssessmentFramework.findOne({ _id: req.params.frameworkId, tenantId: req.user.tenantId });
  if (!item) return null;
    await assertGovernanceScope(req.user, item.scope || {}, { allowGlobal: req.method === 'GET' || hasRole(req.user, 'TENANT_ADMIN') });
  return item;
};
const requireScopedFramework = async (req, res, next) => {
  try {
    const item = await loadScopedFramework(req);
    if (!item) return res.status(404).json({ error: 'Framework not found.' });
    req.assessmentFramework = item;
    return next();
  } catch (error) { return next(error); }
};
const requireScopedRubric = async (req, res, next) => {
  try {
    const item = await RubricTemplate.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
    if (!item) return res.status(404).json({ error: 'Rubric not found.' });
    await assertGovernanceScope(req.user, item.applicability || {}, { allowGlobal: req.method === 'GET' || hasRole(req.user, 'TENANT_ADMIN') });
    req.rubricTemplate = item;
    return next();
  } catch (error) { return next(error); }
};
const audit = (req, action, resourceType, resourceId, extra = {}) => logAuditEvent(action, {
  userId: req.user._id,
  userEmail: req.user.email,
  userName: req.user.name,
  userRole: req.user.role,
  tenantId: req.user.tenantId || null,
  resourceType,
  resourceId,
  method: req.method,
  path: req.path,
  ...extra,
});

router.get('/frameworks', ...canRead, async (req, res, next) => { try { const items = await AssessmentFramework.find({ tenantId: req.user.tenantId }).sort({ name: 1 }).lean(); res.json({ items: await filterReadableItems(req.user, items, 'scope') }); } catch (e) { next(e); } });
router.post('/frameworks', ...manage, async (req, res, next) => { try { await assertGovernanceScope(req.user, req.body.scope || {}, { allowGlobal: hasRole(req.user, 'TENANT_ADMIN') }); const item = await AssessmentFramework.create({ tenantId: req.user.tenantId, name: req.body.name, code: req.body.code, description: req.body.description || '', scope: req.body.scope || {}, createdBy: req.user._id }); await audit(req, AUDIT_ACTIONS.FRAMEWORK_CREATED, 'AssessmentFramework', item._id, { name: item.name, code: item.code }); res.status(201).json({ item }); } catch (e) { next(e); } });
router.patch('/frameworks/:frameworkId', ...manage, requireScopedFramework, async (req, res, next) => { try { await assertGovernanceScope(req.user, req.body.scope || {}, { allowGlobal: hasRole(req.user, 'TENANT_ADMIN') }); const item = await AssessmentFramework.findOneAndUpdate({ _id: req.params.frameworkId, tenantId: req.user.tenantId }, { $set: { name: req.body.name, description: req.body.description || '', scope: req.body.scope || {}, status: req.body.status || 'ACTIVE' } }, { new: true, runValidators: true }); if (!item) return res.status(404).json({ error: 'Framework not found.' }); await audit(req, AUDIT_ACTIONS.FRAMEWORK_UPDATED, 'AssessmentFramework', item._id, { name: item.name, status: item.status }); return res.json({ item }); } catch (e) { return next(e); } });
router.post('/frameworks/:frameworkId/clone', ...manage, requireScopedFramework, async (req, res, next) => { try { const source = req.assessmentFramework.toObject(); const item = await AssessmentFramework.create({ tenantId: req.user.tenantId, name: `${source.name} copy`, code: `${source.code}-${Date.now().toString().slice(-5)}`, description: source.description, scope: source.scope, createdBy: req.user._id }); await audit(req, AUDIT_ACTIONS.FRAMEWORK_CLONED, 'AssessmentFramework', item._id, { sourceFrameworkId: source._id }); return res.status(201).json({ item }); } catch (e) { return next(e); } });
router.get('/frameworks/:frameworkId/versions', ...canRead, requireScopedFramework, async (req, res, next) => { try { res.json({ items: await FrameworkVersion.find({ tenantId: req.user.tenantId, frameworkId: req.params.frameworkId }).sort({ createdAt: -1 }).lean() }); } catch (e) { next(e); } });
router.post('/frameworks/:frameworkId/versions', ...manage, requireScopedFramework, async (req, res, next) => { try { assertCognitiveDemandRulesValid(req.body.rules); const item = await FrameworkVersion.create({ tenantId: req.user.tenantId, frameworkId: req.params.frameworkId, version: req.body.version, rules: req.body.rules || {}, status: 'DRAFT' }); await audit(req, AUDIT_ACTIONS.FRAMEWORK_VERSION_CREATED, 'FrameworkVersion', item._id, { frameworkId: item.frameworkId, version: item.version }); res.status(201).json({ item }); } catch (e) { next(e); } });
router.patch('/frameworks/:frameworkId/versions/:versionId', ...manage, requireScopedFramework, async (req, res, next) => { try { const item = await FrameworkVersion.findOne({ _id: req.params.versionId, frameworkId: req.params.frameworkId, tenantId: req.user.tenantId, status: 'DRAFT' }); if (!item) return res.status(409).json({ error: 'Only a draft framework version can be edited.' }); if (req.body.rules) assertCognitiveDemandRulesValid(req.body.rules); item.version = req.body.version || item.version; item.rules = req.body.rules || item.rules; await item.save(); await audit(req, AUDIT_ACTIONS.FRAMEWORK_VERSION_UPDATED, 'FrameworkVersion', item._id, { frameworkId: item.frameworkId, version: item.version }); return res.json({ item }); } catch (e) { return next(e); } });
router.post('/frameworks/:frameworkId/versions/:versionId/clone', ...manage, requireScopedFramework, async (req, res, next) => { try { const source = await FrameworkVersion.findOne({ _id: req.params.versionId, frameworkId: req.params.frameworkId, tenantId: req.user.tenantId }).lean(); if (!source) return res.status(404).json({ error: 'Framework version not found.' }); const item = await FrameworkVersion.create({ tenantId: req.user.tenantId, frameworkId: source.frameworkId, version: req.body.version || `${source.version}-next`, rules: source.rules, status: 'DRAFT' }); await audit(req, AUDIT_ACTIONS.FRAMEWORK_VERSION_CREATED, 'FrameworkVersion', item._id, { frameworkId: item.frameworkId, version: item.version, sourceVersionId: source._id }); return res.status(201).json({ item }); } catch (e) { return next(e); } });
router.post('/frameworks/:frameworkId/versions/:versionId/publish', ...manage, requireScopedFramework, async (req, res, next) => { try { const item = await FrameworkVersion.findOneAndUpdate({ _id: req.params.versionId, frameworkId: req.params.frameworkId, tenantId: req.user.tenantId, status: 'DRAFT' }, { $set: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: req.user._id } }, { new: true }); if (!item) return res.status(404).json({ error: 'Draft framework version not found.' }); await audit(req, AUDIT_ACTIONS.FRAMEWORK_VERSION_PUBLISHED, 'FrameworkVersion', item._id, { frameworkId: item.frameworkId, version: item.version }); return res.json({ item }); } catch (e) { return next(e); } });
// allowGlobal:true — unlike the governance *write* routes below (create/update
// a framework/rubric, where a bounded Academic Admin must not be able to
// publish institution-wide-scoped policy), /resolve only *consumes* policy
// for one assessment. An empty academicContext here means "no framework, use
// purpose defaults" (see resolveAssessmentSpecification's PURPOSE_DEFAULTS) —
// exactly what Quick Assessment needs in a brand-new tenant with zero
// CourseOfferings, where a bounded EXAM_CREATOR's visibility.all is always
// false and would otherwise 403 with no scope left to select. Real IDOR
// protection is unchanged: isGovernanceScopeReadable below still rejects any
// *non-empty* academicContext/frameworkId the caller isn't authorized to see.
router.post('/resolve', ...canResolve, async (req, res, next) => { try { await assertGovernanceScope(req.user, req.body.academicContext || {}, { allowGlobal: true }); const resolvedSpecification = await resolveAssessmentSpecification({ tenantId: req.user.tenantId, ...req.body }); await audit(req, AUDIT_ACTIONS.ASSESSMENT_SPECIFICATION_RESOLVED, 'AssessmentFramework', resolvedSpecification.framework?.id || null, { purpose: resolvedSpecification.purpose, assessmentType: resolvedSpecification.assessmentType, frameworkVersionId: resolvedSpecification.frameworkVersion?.id || null }); res.json({ resolvedSpecification }); } catch (e) { res.status(e.statusCode || e.status || 400).json({ error: e.message }); } });

router.get('/rubrics', ...canRead, async (req, res, next) => { try { const items = await RubricTemplate.find({ tenantId: req.user.tenantId }).sort({ name: 1 }).lean(); res.json({ items: await filterReadableItems(req.user, items, 'applicability') }); } catch (e) { next(e); } });
router.post('/rubrics', ...manage, async (req, res, next) => { try { if (!Array.isArray(req.body.criteria) || !req.body.criteria.length) return res.status(400).json({ error: 'At least one rubric criterion is required.' }); await assertGovernanceScope(req.user, req.body.applicability || {}, { allowGlobal: hasRole(req.user, 'TENANT_ADMIN') }); const item = await RubricTemplate.create({ tenantId: req.user.tenantId, name: req.body.name, version: req.body.version || '1.0', applicability: req.body.applicability || {}, criteria: req.body.criteria, createdBy: req.user._id }); await audit(req, AUDIT_ACTIONS.RUBRIC_TEMPLATE_CREATED, 'RubricTemplate', item._id, { name: item.name, version: item.version }); res.status(201).json({ item }); } catch (e) { next(e); } });
router.patch('/rubrics/:id', ...manage, requireScopedRubric, async (req, res, next) => { try { const item = req.rubricTemplate; if (item.status !== 'DRAFT') return res.status(409).json({ error: 'Only a draft rubric can be edited.' }); if (!Array.isArray(req.body.criteria) || !req.body.criteria.length) return res.status(400).json({ error: 'At least one rubric criterion is required.' }); await assertGovernanceScope(req.user, req.body.applicability || {}, { allowGlobal: hasRole(req.user, 'TENANT_ADMIN') }); item.name = req.body.name || item.name; item.version = req.body.version || item.version; item.applicability = req.body.applicability || {}; item.criteria = req.body.criteria; await item.save(); await audit(req, AUDIT_ACTIONS.RUBRIC_TEMPLATE_UPDATED, 'RubricTemplate', item._id, { name: item.name, version: item.version }); return res.json({ item }); } catch (e) { return next(e); } });
router.post('/rubrics/:id/clone', ...manage, requireScopedRubric, async (req, res, next) => { try { const source = req.rubricTemplate.toObject(); const item = await RubricTemplate.create({ tenantId: req.user.tenantId, name: `${source.name} copy`, version: req.body.version || `${source.version}-next`, applicability: source.applicability, criteria: source.criteria, createdBy: req.user._id }); await audit(req, AUDIT_ACTIONS.RUBRIC_TEMPLATE_CREATED, 'RubricTemplate', item._id, { name: item.name, sourceRubricId: source._id }); return res.status(201).json({ item }); } catch (e) { return next(e); } });
router.post('/rubrics/:id/archive', ...manage, requireScopedRubric, async (req, res, next) => { try { const item = await RubricTemplate.findOneAndUpdate({ _id: req.rubricTemplate._id, tenantId: req.user.tenantId }, { $set: { status: 'ARCHIVED' } }, { new: true }); await audit(req, AUDIT_ACTIONS.RUBRIC_TEMPLATE_ARCHIVED, 'RubricTemplate', item._id, { name: item.name }); return res.json({ item }); } catch (e) { return next(e); } });
router.post('/rubrics/:id/publish', ...manage, requireScopedRubric, async (req, res, next) => { try { const item = await RubricTemplate.findOneAndUpdate({ _id: req.rubricTemplate._id, tenantId: req.user.tenantId, status: 'DRAFT' }, { $set: { status: 'PUBLISHED' } }, { new: true }); if (!item) return res.status(404).json({ error: 'Draft rubric not found.' }); await audit(req, AUDIT_ACTIONS.RUBRIC_TEMPLATE_PUBLISHED, 'RubricTemplate', item._id, { name: item.name, version: item.version }); res.json({ item }); } catch (e) { next(e); } });
export default router;
