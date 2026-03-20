import mongoose from 'mongoose';

const AITokenUsageSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
      index: true,
    },
    prompt_tokens: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    completion_tokens: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    total_tokens: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    tokens_used: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    usage_count: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    question_count: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    feature: {
      type: String,
      required: true,
      trim: true,
      default: 'unknown',
      index: true,
    },
    feature_type: {
      type: String,
      required: true,
      trim: true,
      default: 'unknown',
      index: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    model: {
      type: String,
      trim: true,
      default: '',
    },
    cost_usd: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    request_status: {
      type: String,
      trim: true,
      uppercase: true,
      enum: ['SUCCESS', 'FAILED'],
      default: 'SUCCESS',
      index: true,
    },
    error_message: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },
  },
  {
    collection: 'ai_token_usage',
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false,
    },
  }
);

AITokenUsageSchema.index({ tenant_id: 1, created_at: -1 });
AITokenUsageSchema.index({ feature: 1, created_at: -1 });
AITokenUsageSchema.index({ feature_type: 1, created_at: -1 });
AITokenUsageSchema.index({ model: 1, created_at: -1 });
AITokenUsageSchema.index({ created_at: -1 });
AITokenUsageSchema.index({ request_status: 1, created_at: -1 });

export default mongoose.model('AITokenUsage', AITokenUsageSchema);
