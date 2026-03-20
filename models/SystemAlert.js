import mongoose from 'mongoose';

const { Schema } = mongoose;

const VALID_SEVERITIES = ['info', 'warning', 'critical'];
const VALID_CATEGORIES = ['user', 'exam', 'tenant', 'ai', 'backup', 'system'];

const SystemAlertSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    severity: {
      type: String,
      enum: VALID_SEVERITIES,
      required: true,
      default: 'info',
      index: true,
    },
    category: {
      type: String,
      enum: VALID_CATEGORIES,
      required: true,
      default: 'system',
      index: true,
    },
    entity_type: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    entity_id: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    is_read: {
      type: Boolean,
      default: false,
      index: true,
    },
    is_resolved: {
      type: Boolean,
      default: false,
      index: true,
    },
    dedupe_key: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    occurrence_count: {
      type: Number,
      default: 1,
      min: 1,
    },
    last_occurred_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    collection: 'system_alerts',
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

SystemAlertSchema.index({ severity: 1, created_at: -1 });
SystemAlertSchema.index({ category: 1, created_at: -1 });
SystemAlertSchema.index({ created_at: -1 });
SystemAlertSchema.index({ is_read: 1, is_resolved: 1, created_at: -1 });
SystemAlertSchema.index({ dedupe_key: 1, created_at: -1 });
SystemAlertSchema.index({ entity_type: 1, entity_id: 1, created_at: -1 });

export const SYSTEM_ALERT_SEVERITIES = Object.freeze(VALID_SEVERITIES);
export const SYSTEM_ALERT_CATEGORIES = Object.freeze(VALID_CATEGORIES);

export default mongoose.model('SystemAlert', SystemAlertSchema);
