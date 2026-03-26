import mongoose from 'mongoose';
import {
  CREDIT_REQUEST_STATUSES,
  CREDIT_REQUEST_TYPES,
} from '../utils/creditSystem.js';

const { Schema } = mongoose;

const CreditRequestSchema = new Schema(
  {
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(CREDIT_REQUEST_TYPES),
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    requestedAmount: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: Object.values(CREDIT_REQUEST_STATUSES),
      default: CREDIT_REQUEST_STATUSES.PENDING,
      uppercase: true,
      trim: true,
      index: true,
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    reviewNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    unitPriceInr: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: 'credit_requests',
  }
);

CreditRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
CreditRequestSchema.index({ status: 1, type: 1, createdAt: -1 });
CreditRequestSchema.index({ requestedBy: 1, createdAt: -1 });

export default mongoose.model('CreditRequest', CreditRequestSchema);
