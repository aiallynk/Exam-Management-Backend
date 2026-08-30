import mongoose from 'mongoose';

// The organization hierarchy (Tenant -> ... -> Department) is deliberately
// separate from the academic hierarchy (Program -> Curriculum -> Period ->
// Course) — see docs/XAMIGO_V2_ARCHITECTURE_CONVERGENCE_MAP.md Part "ORGANIZATION MODEL".
// A Tenant remains the commercial/security boundary; everything below is
// self-referential inside one tenant so a university/college/department
// tree (or a school-group/branch tree, or a training-centre tree) can be
// modeled without forking schema per institution shape.
const OrganizationUnitSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  parentOrganizationUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationUnit', default: null },
  type: {
    type: String,
    required: true,
    // SCHOOL_GROUP and TRAINING_ORGANIZATION are root-only concepts (the
    // platform-provisioned institution identity — see routes/superAdmin.js's
    // tenant-creation flow); the rest can appear at any depth a tenant admin
    // builds under that root.
    enum: ['SCHOOL_GROUP', 'TRAINING_ORGANIZATION', 'UNIVERSITY', 'COLLEGE', 'INSTITUTE', 'SCHOOL', 'BRANCH', 'CAMPUS', 'FACULTY', 'DEPARTMENT', 'CENTRE', 'OTHER'],
  },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, trim: true, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, minimize: false });

OrganizationUnitSchema.index({ tenantId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $ne: '' } } });
OrganizationUnitSchema.index({ tenantId: 1, parentOrganizationUnitId: 1, name: 1 });

export default mongoose.model('OrganizationUnit', OrganizationUnitSchema);
