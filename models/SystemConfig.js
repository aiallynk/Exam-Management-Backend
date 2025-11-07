import mongoose from 'mongoose';

const SystemConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      unique: true,
      required: true,
      index: true,
      trim: true,
    },
    value: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: 'updatedAt',
    },
  }
);

export default mongoose.model('SystemConfig', SystemConfigSchema);

