import express from 'express';
import QuestionBankItem from '../models/QuestionBankItem.js';
import QuestionVersion from '../models/QuestionVersion.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import { recordQuestionVersionEmbedding } from '../services/questionEmbeddingService.js';
import { recordCreatorDecision } from '../services/questionHistoryService.js';
import { resolveAcademicVisibility } from '../services/academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';
import { BLOOM_LEVELS } from '../utils/cognitiveDemand.js';

// Canonical Question Bank — see docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md
// Part 5. This is content authoring/review; MATERIALIZING an approved
// version into a real exam Question deliberately reuses the existing,
// already-tested `POST /exams/:examId/questions` creation path in
// routes/questions.js (see its `provenance.questionBankItemId` /
// `questionVersionId` handling) rather than duplicating that logic here.

const router = express.Router();
const canRead = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'EXAM_CREATOR')];
const canContribute = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('ACADEMIC_ADMIN', 'EXAM_CREATOR')];
const canGovern = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN')];

const id = (value) => value == null ? '' : String(value);
const questionBankScopeFilter = async (user) => {
  const visibility = await resolveAcademicVisibility(user);
  if (visibility.all) return { tenantId: visibility.tenantId };
  const clauses = [
    ...(visibility.ids.courses?.length ? [{ courseId: { $in: visibility.ids.courses } }] : []),
    ...(visibility.ids['organization-units']?.length ? [{ organizationUnitId: { $in: visibility.ids['organization-units'] } }] : []),
    ...(hasRole(visibility.user, 'EXAM_CREATOR') ? [{ createdBy: visibility.user._id }] : []),
  ];
  return { tenantId: visibility.tenantId, ...(clauses.length ? { $or: clauses } : { _id: { $in: [] } }) };
};

const assertItemInScope = async (user, item, { requireOwner = false, allowAuthorFallback = true } = {}) => {
  const visibility = await resolveAcademicVisibility(user);
  if (visibility.all && (hasRole(visibility.user, 'TENANT_ADMIN') || hasRole(visibility.user, 'ACADEMIC_ADMIN'))) return visibility;
  if (requireOwner && hasRole(visibility.user, 'EXAM_CREATOR') && id(item.createdBy) !== id(visibility.user._id)) {
    const error = new Error('Only the author can revise this question bank item.'); error.status = 403; throw error;
  }
  const inScope = (item.courseId && visibility.ids.courses?.includes(id(item.courseId))) ||
    (item.organizationUnitId && visibility.ids['organization-units']?.includes(id(item.organizationUnitId)));
  if (!inScope && (!allowAuthorFallback || id(item.createdBy) !== id(visibility.user._id))) {
    const error = new Error('Question bank item is outside your academic scope.'); error.status = 403; throw error;
  }
  return visibility;
};

const FORWARD_TRANSITIONS = { DRAFT: ['REVIEWED', 'RETIRED'], REVIEWED: ['APPROVED', 'DRAFT', 'RETIRED'], APPROVED: ['RETIRED'], RETIRED: [] };

router.get('/items', ...canRead, async (req, res, next) => {
  try {
    const filter = await questionBankScopeFilter(req.user);
    if (req.query.courseId) filter.courseId = req.query.courseId;
    if (req.query.topic) filter.topic = new RegExp(String(req.query.topic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const requestedStatus = String(req.query.status || '').toUpperCase();
    if (['ACTIVE', 'ARCHIVED'].includes(requestedStatus)) filter.status = requestedStatus;
    const items = await QuestionBankItem.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    const versionIds = items.map((item) => item.currentVersionId).filter(Boolean);
    const versions = versionIds.length ? await QuestionVersion.find({ _id: { $in: versionIds }, tenantId: req.user.tenantId }).lean() : [];
    const versionById = new Map(versions.map((version) => [String(version._id), version]));
    const hydratedItems = items.map((item) => ({ ...item, currentVersion: item.currentVersionId ? versionById.get(String(item.currentVersionId)) || null : null }));

    // Every remaining filter (status already applied above) lives on the
    // current version, not the item itself, so it is applied post-hydration
    // — matching the pre-existing status-filter pattern this route already used.
    let result = requestedStatus && ['DRAFT', 'REVIEWED', 'APPROVED', 'RETIRED'].includes(requestedStatus)
      ? hydratedItems.filter((item) => item.currentVersion?.status === requestedStatus)
      : hydratedItems;
    const requestedCognitiveDemand = String(req.query.cognitiveDemand || '').toUpperCase();
    if (['LOT', 'MOT', 'HOT'].includes(requestedCognitiveDemand)) {
      result = result.filter((item) => item.currentVersion?.cognitiveDemand === requestedCognitiveDemand);
    }
    const requestedBloomLevel = String(req.query.bloomLevel || '').toUpperCase();
    if (BLOOM_LEVELS.includes(requestedBloomLevel)) {
      result = result.filter((item) => item.currentVersion?.bloomLevel === requestedBloomLevel);
    }
    if (req.query.difficulty) {
      const requestedDifficulty = String(req.query.difficulty).toLowerCase();
      result = result.filter((item) => String(item.currentVersion?.difficulty || '').toLowerCase() === requestedDifficulty);
    }
    if (req.query.questionType) {
      result = result.filter((item) => item.currentVersion?.questionType === req.query.questionType);
    }
    return res.json({ items: result });
  } catch (error) { return next(error); }
});

router.get('/items/:id/versions', ...canRead, async (req, res, next) => {
  try {
    const item = await QuestionBankItem.findOne({ _id: req.params.id, ...(await questionBankScopeFilter(req.user)) }).lean();
    if (!item) return res.status(404).json({ error: 'Question bank item not found.' });
    const versions = await QuestionVersion.find({ questionBankItemId: item._id, tenantId: req.user.tenantId }).sort({ version: -1 }).lean();
    return res.json({ item, versions });
  } catch (error) { return next(error); }
});

const CONTENT_FIELDS = ['questionText', 'questionType', 'questionFormat', 'options', 'matchingPairs', 'correctAnswer', 'passage', 'paragraphGroupId', 'codingFields', 'evaluationConfig', 'difficulty', 'bloomLevel', 'cognitiveDemand', 'learningOutcomes', 'provenance'];

// Creates a new bank item with its first DRAFT version — the "Save to
// Question Bank" action from the question editor.
router.post('/items', ...canContribute, async (req, res, next) => {
  try {
    const { courseId, organizationUnitId, topic, question } = req.body || {};
    if (!question?.questionText || !question?.questionType) return res.status(400).json({ error: 'A question with questionText and questionType is required.' });
    await assertItemInScope(req.user, { courseId, organizationUnitId, createdBy: req.user._id }, { allowAuthorFallback: false });
    if (hasRole(req.user, 'EXAM_CREATOR') && !courseId && !organizationUnitId) return res.status(422).json({ error: 'Exam Creator question-bank items require an authorized course or organization context.' });
    const item = await QuestionBankItem.create({ tenantId: req.user.tenantId, courseId: courseId || null, organizationUnitId: organizationUnitId || null, topic: topic || '', createdBy: req.user._id });
    const versionPayload = Object.fromEntries(CONTENT_FIELDS.map((field) => [field, question[field]]).filter(([, value]) => value !== undefined));
    const version = await QuestionVersion.create({ tenantId: req.user.tenantId, questionBankItemId: item._id, version: 1, ...versionPayload, createdBy: req.user._id });
    item.currentVersionId = version._id;
    await item.save();
    void recordQuestionVersionEmbedding({ tenantId: req.user.tenantId, questionVersionId: version._id, questionText: version.questionText, questionType: version.questionType, difficulty: version.difficulty, userId: req.user._id });
    // Strong positive quality signal (spec Part 14). Fire-and-forget.
    void recordCreatorDecision({
      tenantId: req.user.tenantId,
      outcome: 'SAVED_TO_BANK',
      userId: req.user._id,
      questionVersionId: version._id,
      question,
    }).catch(() => {});
    await logAuditEvent(AUDIT_ACTIONS.QUESTION_BANK_ITEM_CREATED, { userId: req.user._id, tenantId: req.user.tenantId, resourceType: 'QuestionBankItem', resourceId: item._id, method: req.method, path: req.path });
    return res.status(201).json({ item, version });
  } catch (error) { return next(error); }
});

// A new revision under an existing item (DRAFT). Does not touch
// currentVersionId — that only advances when a version is APPROVED, so an
// in-review edit never silently changes what's currently reusable.
router.post('/items/:id/versions', ...canContribute, async (req, res, next) => {
  try {
    const item = await QuestionBankItem.findOne({ _id: req.params.id, tenantId: req.user.tenantId }).lean();
    if (!item) return res.status(404).json({ error: 'Question bank item not found.' });
    await assertItemInScope(req.user, item, { requireOwner: true });
    const question = req.body?.question;
    if (!question?.questionText || !question?.questionType) return res.status(400).json({ error: 'A question with questionText and questionType is required.' });
    const latest = await QuestionVersion.findOne({ questionBankItemId: item._id, tenantId: req.user.tenantId }).sort({ version: -1 }).lean();
    const versionPayload = Object.fromEntries(CONTENT_FIELDS.map((field) => [field, question[field]]).filter(([, value]) => value !== undefined));
    const version = await QuestionVersion.create({ tenantId: req.user.tenantId, questionBankItemId: item._id, version: (latest?.version || 0) + 1, ...versionPayload, createdBy: req.user._id });
    void recordQuestionVersionEmbedding({ tenantId: req.user.tenantId, questionVersionId: version._id, questionText: version.questionText, questionType: version.questionType, difficulty: version.difficulty, userId: req.user._id });
    return res.status(201).json({ version });
  } catch (error) { return next(error); }
});

router.patch('/versions/:versionId/status', ...canGovern, async (req, res, next) => {
  try {
    const version = await QuestionVersion.findOne({ _id: req.params.versionId, tenantId: req.user.tenantId });
    if (!version) return res.status(404).json({ error: 'Question version not found.' });
    const item = await QuestionBankItem.findOne({ _id: version.questionBankItemId, tenantId: req.user.tenantId }).lean();
    await assertItemInScope(req.user, item);
    const nextStatus = String(req.body?.status || '').toUpperCase();
    const allowed = FORWARD_TRANSITIONS[version.status] || [];
    if (!allowed.includes(nextStatus)) return res.status(409).json({ error: `Cannot move a ${version.status} version to ${nextStatus}.` });
    version.status = nextStatus;
    version.reviewedBy = req.user._id;
    version.reviewedAt = new Date();
    await version.save();
    if (nextStatus === 'APPROVED') {
      await QuestionBankItem.updateOne({ _id: version.questionBankItemId, tenantId: req.user.tenantId }, { $set: { currentVersionId: version._id } });
    }
    await logAuditEvent(AUDIT_ACTIONS.QUESTION_BANK_VERSION_STATUS_CHANGED, { userId: req.user._id, tenantId: req.user.tenantId, resourceType: 'QuestionVersion', resourceId: version._id, method: req.method, path: req.path, status: nextStatus });
    return res.json({ version });
  } catch (error) { return next(error); }
});

router.patch('/items/:id/archive', ...canGovern, async (req, res, next) => {
  try {
    const existing = await QuestionBankItem.findOne({ _id: req.params.id, tenantId: req.user.tenantId }).lean();
    if (!existing) return res.status(404).json({ error: 'Question bank item not found.' });
    await assertItemInScope(req.user, existing);
    const item = await QuestionBankItem.findOneAndUpdate({ _id: existing._id, tenantId: req.user.tenantId }, { $set: { status: 'ARCHIVED' } }, { new: true });
    if (!item) return res.status(404).json({ error: 'Question bank item not found.' });
    return res.json({ item });
  } catch (error) { return next(error); }
});

export default router;
