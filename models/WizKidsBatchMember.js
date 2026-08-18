import mongoose from 'mongoose';

// WizKids Phase 3 — Batch / Grade membership join table.
//
// Links an existing User (no duplicate identity — master prompt §19/§42/§53:
// "This is membership metadata, not another authorization role system" /
// "Do not create another Candidate identity") to a WizKidsBatch with a role
// scoped to that membership. `role` deliberately reuses the existing global
// role vocabulary (EXAM_CREATOR / CANDIDATE) rather than inventing
// WizKids-specific persona roles.
const WizKidsBatchMemberSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WizKidsBatch',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['EXAM_CREATOR', 'CANDIDATE'],
      required: true,
    },
    // Soft-removal only. Historical membership is preserved when a member is
    // removed from a batch (master prompt §36/§45/§58 — never delete
    // historical data as part of ordinary membership management).
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    removedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    removedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// A user holds at most one ACTIVE-or-INACTIVE membership record per
// (batch, role) pair — re-adding a previously-removed member reactivates
// their existing record rather than creating a duplicate, so history is
// never fragmented across multiple rows for the same relationship.
WizKidsBatchMemberSchema.index({ batchId: 1, userId: 1, role: 1 }, { unique: true });
WizKidsBatchMemberSchema.index({ tenantId: 1, batchId: 1, status: 1 });
WizKidsBatchMemberSchema.index({ tenantId: 1, userId: 1, role: 1, status: 1 });

export default mongoose.model('WizKidsBatchMember', WizKidsBatchMemberSchema);
