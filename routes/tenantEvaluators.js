import express from 'express';
import mongoose from 'mongoose';
import { body, validationResult } from 'express-validator';
import User from '../models/User.js';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenantFeature } from '../services/tenantFeatureService.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../utils/auditLogger.js';
import { addRole, removeRole, hasRole, isExamCreatorEligibleForEvaluator } from '../services/userRoleService.js';
import { getEligibleEvaluatorUserFilter } from '../services/evaluatorAssignmentService.js';

const router = express.Router();
// requireAuth already resolves the authenticated user's tenant. Re-resolving
// it through requireTenant caused malformed legacy tenant references to reach
// Mongoose as a CastError (400) before the evaluator list handler ran.
router.use(requireAuth, requireRole('TENANT_ADMIN'));
router.use((req, res, next) => {
  if (!mongoose.isValidObjectId(req.user?.tenantId)) {
    return res.status(403).json({ error: 'Tenant-scoped administrator access is required.' });
  }
  return next();
});
router.use(requireTenantFeature('EVALUATOR_REVIEW'));

const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  roles: Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role],
  status: user.status,
  evaluatorAccess: user.evaluatorAccess || {},
});

// The `status` field returned for an evaluator reflects their evaluator
// CAPABILITY (can they be assigned right now?), not their account status.
// It must account for expiry, not just the `enabled` flag — otherwise an
// evaluator whose access window has lapsed still looks assignable in every
// picker, and only fails with a 409 once someone tries to actually assign
// them, which reads like a false "one evaluator per exam" limit rather than
// the real cause (their access needs to be extended or re-enabled).
const evaluatorCapabilityStatus = (evaluatorAccess) => {
  if (!evaluatorAccess?.enabled) return 'INACTIVE';
  if (evaluatorAccess.accessExpiresAt && new Date(evaluatorAccess.accessExpiresAt) < new Date()) return 'EXPIRED';
  return 'ACTIVE';
};

const examCreatorRoleQuery = {
  $or: [{ role: 'EXAM_CREATOR' }, { roles: 'EXAM_CREATOR' }],
};

const evaluatorUserQuery = (tenantId, extra = {}) => ({
  ...extra,
  ...getEligibleEvaluatorUserFilter({ tenantId }),
});

router.get('/', async (req, res, next) => {
  try {
    const [users, eligibleUsers] = await Promise.all([
      User.find(evaluatorUserQuery(req.user.tenantId))
        .select('name email role roles status evaluatorAccess updatedAt').sort({ name: 1 }).lean(),
      User.find({ tenantId: req.user.tenantId, status: 'ACTIVE', ...examCreatorRoleQuery })
        .select('name email role roles status evaluatorAccess updatedAt').sort({ name: 1 }).lean(),
    ]);
    const ids = users.map((user) => user._id);
    const assignments = ids.length ? await ExaminerAssignment.aggregate([
      { $match: { examinerId: { $in: ids } } },
      { $group: {
        _id: '$examinerId',
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
      } },
    ]) : [];
    const counts = new Map(assignments.map((entry) => [String(entry._id), entry]));
    return res.json({
      evaluators: users.map((user) => ({ ...publicUser(user), assignmentCounts: counts.get(String(user._id)) || { total: 0, active: 0, completed: 0 }, status: evaluatorCapabilityStatus(user.evaluatorAccess) })),
      eligibleUsers: eligibleUsers.map(publicUser),
    });
  } catch (error) { return next(error); }
});

// Evaluator access is granted only to an existing active Exam Creator.  This
// keeps the creator's normal workspace as their primary login and prevents
// candidates or tenant administrators from entering the evaluator list.
router.post('/', [body('userId').isMongoId(), body('accessExpiresAt').optional({ nullable: true }).isISO8601()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!req.body.userId) return res.status(400).json({ error: 'Select an active Exam Creator to grant evaluator access.' });
    const expiry = req.body.accessExpiresAt ? new Date(req.body.accessExpiresAt) : null;
    if (expiry && expiry <= new Date()) return res.status(400).json({ error: 'accessExpiresAt must be in the future.' });

    const user = await User.findOne({ _id: req.body.userId, tenantId: req.user.tenantId });
    if (!user) return res.status(404).json({ error: 'User not found in this tenant.' });
    if (!isExamCreatorEligibleForEvaluator(user)) {
      return res.status(422).json({ error: 'Only an active Exam Creator can receive evaluator access.' });
    }

    const previousRoles = Array.isArray(user.roles) && user.roles.length ? [...user.roles] : [user.role];
    const { changed } = await addRole(user, 'EVALUATOR', { actorId: req.user._id, tenantId: req.user.tenantId, accessExpiresAt: expiry });
    const alreadyHadRole = !changed;

    await logAuditEvent(AUDIT_ACTIONS.EVALUATOR_ROLE_ASSIGNED, {
      userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId,
      resourceType: 'User', resourceId: user._id,
      details: { targetUserId: user._id, previousRole: user.role, previousRoles, newRole: user.role, newRoles: user.roles, alreadyHadRole, accessExpiresAt: expiry },
    });

    return res.status(200).json({
      evaluator: { ...publicUser(user), status: evaluatorCapabilityStatus(user.evaluatorAccess) },
      created: false,
      setupRequired: false,
    });
  } catch (error) { return next(error); }
});

router.get('/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne(evaluatorUserQuery(req.user.tenantId, { _id: req.params.userId })).select('name email role roles status evaluatorAccess').lean();
    if (!user) return res.status(404).json({ error: 'Evaluator not found in this tenant.' });
    const assignments = await ExaminerAssignment.find({ examinerId: user._id, tenantId: req.user.tenantId }).select('examId status scopeType accessExpiresAt').lean();
    return res.json({ evaluator: { ...publicUser(user), status: evaluatorCapabilityStatus(user.evaluatorAccess) }, assignments });
  } catch (error) { return next(error); }
});

router.patch('/:userId', [body('accessExpiresAt').optional({ nullable: true }).isISO8601(), body('enabled').optional().isBoolean()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const user = await User.findOne(evaluatorUserQuery(req.user.tenantId, { _id: req.params.userId }));
    if (!user) return res.status(404).json({ error: 'Evaluator not found in this tenant.' });
    const previous = { ...(user.evaluatorAccess?.toObject?.() || user.evaluatorAccess || {}) };
    if (req.body.accessExpiresAt !== undefined) user.evaluatorAccess.accessExpiresAt = req.body.accessExpiresAt ? new Date(req.body.accessExpiresAt) : null;
    if (req.body.enabled !== undefined) user.evaluatorAccess.enabled = req.body.enabled;
    // Re-enabling access on a user who lost the EVALUATOR role some other
    // way (shouldn't normally happen, but keep the role and the flag in
    // sync rather than granting a flag with no role behind it).
    if (req.body.enabled === true && !hasRole(user, 'EVALUATOR')) {
      const roles = new Set(Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role]);
      roles.add('EVALUATOR');
      user.roles = Array.from(roles);
    }
    await user.save();
    await logAuditEvent(req.body.accessExpiresAt !== undefined ? AUDIT_ACTIONS.EVALUATOR_ACCESS_EXPIRY_CHANGED : AUDIT_ACTIONS.EVALUATOR_CAPABILITY_ASSIGNED, { userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId, resourceType: 'User', resourceId: user._id, details: { targetUserId: user._id, previous, current: user.evaluatorAccess } });
    return res.json({ evaluator: { ...publicUser(user), status: evaluatorCapabilityStatus(user.evaluatorAccess) } });
  } catch (error) { return next(error); }
});

router.delete('/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne(evaluatorUserQuery(req.user.tenantId, { _id: req.params.userId }));
    if (!user) return res.status(404).json({ error: 'Evaluator not found in this tenant.' });
    const activeAssignments = await ExaminerAssignment.countDocuments({ tenantId: req.user.tenantId, examinerId: user._id, status: 'ACTIVE' });
    if (activeAssignments) return res.status(409).json({ error: 'Reassign or revoke active assignments before removing evaluator capability.', activeAssignments });

    const previousRoles = Array.isArray(user.roles) && user.roles.length ? [...user.roles] : [user.role];
    const { blocked } = await removeRole(user, 'EVALUATOR', { actorId: req.user._id });
    if (blocked) {
      // EVALUATOR is this user's only/primary role — removing it would leave
      // the account with no role at all, so we only disable the capability
      // flag (removeRole already did this internally when it blocks) and
      // keep the role itself, matching "preserve the user" — a disabled
      // evaluatorAccess.enabled already denies workspace entry via
      // requireEvaluatorAccess().
      user.evaluatorAccess.enabled = false;
      user.evaluatorAccess.removedAt = new Date();
      user.evaluatorAccess.removedBy = req.user._id;
      await user.save();
    }

    await logAuditEvent(AUDIT_ACTIONS.EVALUATOR_ROLE_REMOVED, {
      userId: req.user._id, userRole: req.user.role, tenantId: req.user.tenantId,
      resourceType: 'User', resourceId: user._id,
      details: { targetUserId: user._id, previousRoles, newRoles: user.roles, primaryRolePreserved: blocked },
    });
    return res.json({ message: 'Evaluator capability removed; historical records were preserved.' });
  } catch (error) { return next(error); }
});

export default router;
