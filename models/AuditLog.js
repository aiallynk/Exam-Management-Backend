import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    userEmail: {
      type: String,
      index: true,
    },
    userName: {
      type: String,
      index: true,
    },
    userRole: {
      type: String,
      index: true,
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      index: true,
    },
    tenantName: {
      type: String,
      index: true,
    },
    resourceType: {
      type: String,
      index: true,
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: {
      type: String,
      index: true,
    },
    userAgent: {
      type: String,
    },
    method: {
      type: String,
    },
    path: {
      type: String,
    },
    statusCode: {
      type: Number,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
AuditLogSchema.index({ userId: 1, timestamp: -1 });
AuditLogSchema.index({ tenantId: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ resourceType: 1, resourceId: 1, timestamp: -1 });
AuditLogSchema.index({ timestamp: -1 }); // For time-based queries

// Prevent updates to audit logs (immutable once created)
const blockAuditUpdates = function (next) {
  next(new Error('Audit logs are immutable once created.'));
};
AuditLogSchema.pre('updateOne', blockAuditUpdates);
AuditLogSchema.pre('updateMany', blockAuditUpdates);
AuditLogSchema.pre('findOneAndUpdate', blockAuditUpdates);
AuditLogSchema.pre('replaceOne', blockAuditUpdates);

// TTL index - optionally keep logs for 1 year (can be adjusted)
// AuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 31536000 });

export default mongoose.model('AuditLog', AuditLogSchema);
