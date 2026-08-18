import mongoose from 'mongoose';
import WizKidsBatch from '../models/WizKidsBatch.js';
import WizKidsBatchMember from '../models/WizKidsBatchMember.js';
import User from '../models/User.js';
import { hasRole } from '../utils/userRoles.js';
import { resolvePlanLimits, resolveTenantSubscriptionContext } from '../middleware/planLimits.js';

// WizKids Phase 3 — Batch / Grade.
//
// Single source of truth for WizKidsBatch/WizKidsBatchMember CRUD. Mirrors
// the typed, status-carrying error convention already established by
// services/userRoleService.js's UserRoleError, so routes/wizKidsBatches.js
// can translate failures the same way routes/tenantAdmin.js already does.
export class WizKidsBatchError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsBatchError';
    this.status = status;
  }
}

export const VALID_MEMBER_ROLES = Object.freeze(['EXAM_CREATOR', 'CANDIDATE']);

export const normalizeBatchCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');

// Grade level is kept intentionally simple for the first version — a plain
// 1-7 integer, not a curriculum/board/education taxonomy (master prompt §20).
export const isValidGradeLevel = (value) => {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 1 && normalized <= 7;
};

export const resolveMaxWizKidsBatches = async (tenantId) => {
  const context = await resolveTenantSubscriptionContext(tenantId);
  const limits = resolvePlanLimits(context.planType, context.tenant);
  return limits.maxWizKidsBatches; // null = unlimited
};

export const createBatch = async ({ tenantId, name, code, gradeLevel, domainKeys = [], createdBy }) => {
  if (!tenantId) throw new WizKidsBatchError(400, 'tenantId is required.');
  if (!name || !String(name).trim()) throw new WizKidsBatchError(400, 'name is required.');

  if (!isValidGradeLevel(gradeLevel)) {
    throw new WizKidsBatchError(400, 'gradeLevel must be an integer between 1 and 7.');
  }
  const normalizedGrade = Number(gradeLevel);

  const normalizedCode = normalizeBatchCode(code) || normalizeBatchCode(name);
  if (!normalizedCode) throw new WizKidsBatchError(400, 'Unable to derive a valid batch code.');

  // Count-based limit — mirrors the existing maxCandidates/maxExamCreators
  // shape (a total, not a per-month window). ACTIVE batches only: an
  // inactive batch does not consume the tenant's quota.
  const [existingCount, maxBatches] = await Promise.all([
    WizKidsBatch.countDocuments({ tenantId, status: 'ACTIVE' }),
    resolveMaxWizKidsBatches(tenantId),
  ]);
  if (maxBatches !== null && existingCount >= maxBatches) {
    throw new WizKidsBatchError(403, `This tenant has reached its WizKids batch limit (${maxBatches}).`);
  }

  try {
    return await WizKidsBatch.create({
      tenantId,
      name: String(name).trim(),
      code: normalizedCode,
      gradeLevel: normalizedGrade,
      domainKeys: Array.isArray(domainKeys) ? domainKeys : [],
      createdBy,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new WizKidsBatchError(409, `A batch with code "${normalizedCode}" already exists for this tenant.`);
    }
    throw error;
  }
};

export const listBatches = async ({ tenantId, status }) => {
  const filter = { tenantId };
  if (status) filter.status = status;
  return WizKidsBatch.find(filter).sort({ createdAt: -1 }).lean();
};

// Tenant scope is built into the query itself (filter-in-query, not
// fetch-then-check) — see DOCS/WIZKIDS_INTEGRATION_ASSESSMENT.md §16 and
// master prompt §57's explicit preference for this pattern over
// findById-then-compare-tenant.
export const getBatchForTenant = async ({ tenantId, batchId }) => {
  if (!mongoose.isValidObjectId(batchId)) return null;
  return WizKidsBatch.findOne({ _id: batchId, tenantId }).lean();
};

export const updateBatch = async ({ tenantId, batchId, updates = {} }) => {
  const patch = {};

  if (updates.name !== undefined) {
    if (!String(updates.name).trim()) throw new WizKidsBatchError(400, 'name cannot be empty.');
    patch.name = String(updates.name).trim();
  }
  if (updates.gradeLevel !== undefined) {
    if (!isValidGradeLevel(updates.gradeLevel)) {
      throw new WizKidsBatchError(400, 'gradeLevel must be an integer between 1 and 7.');
    }
    patch.gradeLevel = Number(updates.gradeLevel);
  }
  if (updates.domainKeys !== undefined) {
    patch.domainKeys = Array.isArray(updates.domainKeys) ? updates.domainKeys : [];
  }

  try {
    const batch = await WizKidsBatch.findOneAndUpdate({ _id: batchId, tenantId }, { $set: patch }, { new: true });
    if (!batch) throw new WizKidsBatchError(404, 'Batch not found.');
    return batch;
  } catch (error) {
    if (error?.code === 11000) {
      throw new WizKidsBatchError(409, 'A batch with this code already exists for this tenant.');
    }
    throw error;
  }
};

// Inactive-batch handling: deactivating a batch never touches its
// membership records or historical data — it only blocks new membership
// assignment (enforced in addMember below), matching the platform-wide
// "disable access, preserve history" convention.
export const setBatchStatus = async ({ tenantId, batchId, status }) => {
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw new WizKidsBatchError(400, 'status must be ACTIVE or INACTIVE.');
  }
  const batch = await WizKidsBatch.findOneAndUpdate({ _id: batchId, tenantId }, { $set: { status } }, { new: true });
  if (!batch) throw new WizKidsBatchError(404, 'Batch not found.');
  return batch;
};

const assertUserEligibleForMembership = async ({ tenantId, userId, role }) => {
  if (!VALID_MEMBER_ROLES.includes(role)) {
    throw new WizKidsBatchError(400, `role must be one of ${VALID_MEMBER_ROLES.join(', ')}.`);
  }
  const user = await User.findOne({ _id: userId, tenantId }).select('_id role roles status').lean();
  if (!user) throw new WizKidsBatchError(404, 'User not found in this tenant.');
  if (user.status !== 'ACTIVE') throw new WizKidsBatchError(400, 'Only active users can be added to a batch.');
  if (!hasRole(user, role)) throw new WizKidsBatchError(400, `User does not hold the ${role} role.`);
  return user;
};

// Duplicate-membership prevention: an ACTIVE (batch, user, role) triple is
// rejected outright; a previously-removed (INACTIVE) membership is
// reactivated in place rather than creating a second row, so history for
// that relationship never fragments. The unique index on
// {batchId, userId, role} is the final backstop against a race between two
// concurrent adds.
export const addMember = async ({ tenantId, batchId, userId, role, assignedBy }) => {
  const batch = await getBatchForTenant({ tenantId, batchId });
  if (!batch) throw new WizKidsBatchError(404, 'Batch not found.');
  if (batch.status !== 'ACTIVE') {
    throw new WizKidsBatchError(400, 'Cannot add members to an inactive batch.');
  }
  await assertUserEligibleForMembership({ tenantId, userId, role });

  const existing = await WizKidsBatchMember.findOne({ batchId, userId, role });
  if (existing) {
    if (existing.status === 'ACTIVE') {
      throw new WizKidsBatchError(409, 'This user is already an active member of this batch in this role.');
    }
    existing.status = 'ACTIVE';
    existing.assignedBy = assignedBy;
    existing.assignedAt = new Date();
    existing.removedBy = null;
    existing.removedAt = null;
    await existing.save();
    return existing;
  }

  try {
    return await WizKidsBatchMember.create({ tenantId, batchId, userId, role, assignedBy });
  } catch (error) {
    if (error?.code === 11000) {
      throw new WizKidsBatchError(409, 'This user is already a member of this batch in this role.');
    }
    throw error;
  }
};

// Bulk Candidate assignment (master prompt §54 Phase 3 acceptance list).
// Partial-success by design — one ineligible/duplicate user in the batch
// must not block the rest, mirroring the existing bulk-import convention
// used elsewhere in the app (see routes/questions.js import endpoint).
export const bulkAddCandidates = async ({ tenantId, batchId, userIds = [], assignedBy }) => {
  const results = [];
  for (const userId of userIds) {
    try {
      const member = await addMember({ tenantId, batchId, userId, role: 'CANDIDATE', assignedBy });
      results.push({ userId, status: 'added', memberId: member._id });
    } catch (error) {
      results.push({ userId, status: 'skipped', reason: error.message });
    }
  }
  return results;
};

export const removeMember = async ({ tenantId, batchId, userId, role, removedBy }) => {
  const member = await WizKidsBatchMember.findOne({ tenantId, batchId, userId, role, status: 'ACTIVE' });
  if (!member) throw new WizKidsBatchError(404, 'Active membership not found.');
  member.status = 'INACTIVE';
  member.removedBy = removedBy;
  member.removedAt = new Date();
  await member.save();
  return member;
};

export const listBatchMembers = async ({ tenantId, batchId, role, status = 'ACTIVE' }) => {
  const filter = { tenantId, batchId };
  if (role) filter.role = role;
  if (status) filter.status = status;
  return WizKidsBatchMember.find(filter)
    .populate('userId', 'name email role roles status')
    .sort({ createdAt: -1 })
    .lean();
};
