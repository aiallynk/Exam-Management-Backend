import mongoose from 'mongoose';

const BackupHistorySchema = new mongoose.Schema(
  {
    backup_name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['full_system', 'company', 'tenant', 'pre_restore'],
      required: true,
      index: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
      index: true,
    },
    file_size: {
      type: Number,
      default: 0,
      min: 0,
    },
    storage_path: {
      type: String,
      required: true,
      trim: true,
    },
    file_path: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'RESTORED', 'DELETED'],
      default: 'IN_PROGRESS',
      index: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    restored_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    restored_at: {
      type: Date,
      default: null,
    },
    error_message: {
      type: String,
      trim: true,
      default: '',
    },
    source_backup_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BackupHistory',
      default: null,
    },
  },
  {
    collection: 'backup_history',
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

BackupHistorySchema.index({ type: 1, created_at: -1 });
BackupHistorySchema.index({ company_id: 1, created_at: -1 });

export default mongoose.model('BackupHistory', BackupHistorySchema);
