import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { validateObjectId } from '../middleware/validation.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import {
  createBatch,
  listBatches,
  getBatchForTenant,
  updateBatch,
  setBatchStatus,
  addMember,
  bulkAddCandidates,
  removeMember,
  listBatchMembers,
  WizKidsBatchError,
} from '../services/wizKidsBatchService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';

// WizKids Phase 3 — Batch / Grade.
//
// Full guard chain per master prompt §10: authenticate -> tenant active
// check -> role authorization -> requireTenantFeature(...) -> tenant
// resource scope -> business logic. Batch management is a Tenant Admin
// capability for this phase (master prompt §15) — Exam Creator-facing batch
// visibility is deferred until a Teacher UI actually needs it (§65: "Do not
// pre-create unused scaffolding").
const router = express.Router();
// Read-only batch discovery is shared with Exam Creators for test assignment
// and reporting. Mutating routes below remain Tenant-Admin-only.
router.get(
  '/for-creators',
  requireAuth,
  requireTenant,
  requireRole('TENANT_ADMIN', 'EXAM_CREATOR'),
  requireTenantFeature('WIZKIDS'),
  async (req, res, next) => {
    try {
      const batches = await listBatches({ tenantId: req.user.tenantId, status: req.query.status });
      return res.json({ batches });
    } catch (error) {
      return respondToBatchError(error, res, next);
    }
  }
);
router.use(requireAuth, requireTenant, requireRole('TENANT_ADMIN'), requireTenantFeature('WIZKIDS'));

const respondToBatchError = (error, res, next) => {
  if (error instanceof WizKidsBatchError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
};

router.get('/', async (req, res, next) => {
  try {
    const batches = await listBatches({ tenantId: req.user.tenantId, status: req.query.status });
    return res.json({ batches });
  } catch (error) {
    return respondToBatchError(error, res, next);
  }
});

router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('name is required.'),
    body('gradeLevel').isInt({ min: 1, max: 7 }).withMessage('gradeLevel must be between 1 and 7.'),
    body('domainKeys').optional().isArray(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const batch = await createBatch({
        tenantId: req.user.tenantId,
        name: req.body.name,
        code: req.body.code,
        gradeLevel: req.body.gradeLevel,
        domainKeys: req.body.domainKeys,
        createdBy: req.user._id,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_BATCH_CREATED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsBatch',
        resourceId: batch._id,
        details: { name: batch.name, code: batch.code, gradeLevel: batch.gradeLevel, domainKeys: batch.domainKeys },
      });

      return res.status(201).json({ batch });
    } catch (error) {
      return respondToBatchError(error, res, next);
    }
  }
);

router.get('/:batchId', validateObjectId('batchId'), async (req, res, next) => {
  try {
    const batch = await getBatchForTenant({ tenantId: req.user.tenantId, batchId: req.params.batchId });
    if (!batch) return res.status(404).json({ error: 'Batch not found.' });
    return res.json({ batch });
  } catch (error) {
    return respondToBatchError(error, res, next);
  }
});

router.put('/:batchId', validateObjectId('batchId'), async (req, res, next) => {
  try {
    const before = await getBatchForTenant({ tenantId: req.user.tenantId, batchId: req.params.batchId });
    const batch = await updateBatch({
      tenantId: req.user.tenantId,
      batchId: req.params.batchId,
      updates: { name: req.body.name, gradeLevel: req.body.gradeLevel, domainKeys: req.body.domainKeys },
    });

    await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_BATCH_UPDATED, {
      userId: req.user._id,
      userRole: req.user.role,
      tenantId: req.user.tenantId,
      resourceType: 'WizKidsBatch',
      resourceId: batch._id,
      details: { before, after: batch },
    });

    return res.json({ batch });
  } catch (error) {
    return respondToBatchError(error, res, next);
  }
});

router.patch(
  '/:batchId/status',
  validateObjectId('batchId'),
  [body('status').isIn(['ACTIVE', 'INACTIVE'])],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const before = await getBatchForTenant({ tenantId: req.user.tenantId, batchId: req.params.batchId });
      const batch = await setBatchStatus({
        tenantId: req.user.tenantId,
        batchId: req.params.batchId,
        status: req.body.status,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_BATCH_STATUS_CHANGED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsBatch',
        resourceId: batch._id,
        details: { before: before?.status, after: batch.status },
      });

      return res.json({ batch });
    } catch (error) {
      return respondToBatchError(error, res, next);
    }
  }
);

router.get('/:batchId/members', validateObjectId('batchId'), async (req, res, next) => {
  try {
    const batch = await getBatchForTenant({ tenantId: req.user.tenantId, batchId: req.params.batchId });
    if (!batch) return res.status(404).json({ error: 'Batch not found.' });
    const members = await listBatchMembers({
      tenantId: req.user.tenantId,
      batchId: req.params.batchId,
      role: req.query.role,
      status: req.query.status || 'ACTIVE',
    });
    return res.json({ members });
  } catch (error) {
    return respondToBatchError(error, res, next);
  }
});

router.post(
  '/:batchId/members',
  validateObjectId('batchId'),
  [body('userId').isMongoId(), body('role').isIn(['EXAM_CREATOR', 'CANDIDATE'])],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const member = await addMember({
        tenantId: req.user.tenantId,
        batchId: req.params.batchId,
        userId: req.body.userId,
        role: req.body.role,
        assignedBy: req.user._id,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_BATCH_MEMBER_ADDED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsBatchMember',
        resourceId: member._id,
        details: { batchId: req.params.batchId, memberUserId: req.body.userId, role: req.body.role },
      });

      return res.status(201).json({ member });
    } catch (error) {
      return respondToBatchError(error, res, next);
    }
  }
);

router.post(
  '/:batchId/members/bulk-candidates',
  validateObjectId('batchId'),
  [body('userIds').isArray({ min: 1 })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const results = await bulkAddCandidates({
        tenantId: req.user.tenantId,
        batchId: req.params.batchId,
        userIds: req.body.userIds,
        assignedBy: req.user._id,
      });

      const addedCount = results.filter((result) => result.status === 'added').length;
      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_BATCH_MEMBER_ADDED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsBatchMember',
        resourceId: req.params.batchId,
        details: { batchId: req.params.batchId, bulk: true, requested: req.body.userIds.length, added: addedCount, results },
      });

      return res.json({ results });
    } catch (error) {
      return respondToBatchError(error, res, next);
    }
  }
);

router.delete(
  '/:batchId/members/:userId/:role',
  validateObjectId('batchId'),
  validateObjectId('userId'),
  async (req, res, next) => {
    try {
      const role = String(req.params.role || '').toUpperCase();
      if (!['EXAM_CREATOR', 'CANDIDATE'].includes(role)) {
        return res.status(400).json({ error: 'role must be EXAM_CREATOR or CANDIDATE.' });
      }

      const member = await removeMember({
        tenantId: req.user.tenantId,
        batchId: req.params.batchId,
        userId: req.params.userId,
        role,
        removedBy: req.user._id,
      });

      await logAuditEvent(AUDIT_ACTIONS.WIZKIDS_BATCH_MEMBER_REMOVED, {
        userId: req.user._id,
        userRole: req.user.role,
        tenantId: req.user.tenantId,
        resourceType: 'WizKidsBatchMember',
        resourceId: member._id,
        details: { batchId: req.params.batchId, memberUserId: req.params.userId, role },
      });

      return res.json({ member });
    } catch (error) {
      return respondToBatchError(error, res, next);
    }
  }
);

export default router;
