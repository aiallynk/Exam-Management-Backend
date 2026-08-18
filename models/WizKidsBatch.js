import mongoose from 'mongoose';

// WizKids Phase 3 — Batch / Grade.
//
// A flat, per-tenant grouping of WizKids Teachers (EXAM_CREATOR) and
// Students (CANDIDATE), e.g. "Grade 5 - Batch A" or "Saturday Vedic Maths
// Batch". Deliberately modelled as an isolated, WizKids-owned entity rather
// than repurposing SubTenant — SubTenant already represents "Department"
// for tenants using that feature, and has no grade/age semantics
// (see DOCS/WIZKIDS_INTEGRATION_ASSESSMENT.md §23, and master prompt §19:
// "Do not repurpose SubTenant... Create an isolated WizKidsBatch").
const WizKidsBatchSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    // Kept intentionally simple for the first version — a plain 1-7 integer,
    // not a curriculum/board/education taxonomy (master prompt §20).
    gradeLevel: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
    // Which WizKids domains this batch studies (content scoping, independent
    // of the platform-wide WIZKIDS_* tenant capability flags in
    // services/tenantFeatureService.js — a batch can only be assigned a
    // domain the tenant has actually been entitled to and enabled).
    domainKeys: {
      type: [String],
      enum: ['MENTAL_MATHS', 'VEDIC_MATHS', 'SUPER_MATHS', 'LOGIC', 'OLYMPIAD'],
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

WizKidsBatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
WizKidsBatchSchema.index({ tenantId: 1, name: 1 });
WizKidsBatchSchema.index({ tenantId: 1, code: 1 }, { unique: true });
WizKidsBatchSchema.index({ tenantId: 1, gradeLevel: 1 });

export default mongoose.model('WizKidsBatch', WizKidsBatchSchema);
