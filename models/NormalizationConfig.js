import mongoose from 'mongoose';

const NormalizationConfigSchema = new mongoose.Schema(
  {
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: function() {
        return !this.tenantId; // examId is required if tenantId is not set
      },
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: function() {
        return !this.examId; // tenantId is required if examId is not set
      },
    },
    formulaType: {
      type: String,
      enum: ['LINEAR', 'Z_SCORE', 'PERCENTILE_RANK', 'CUSTOM'],
      default: 'PERCENTILE_RANK',
      required: true,
    },
    customFormula: {
      type: String,
      trim: true,
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    shiftBased: {
      type: Boolean,
      default: false,
    },
    sessionBased: {
      type: Boolean,
      default: true,
    },
    parameters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    lastRecalculatedAt: {
      type: Date,
    },
    lastRecalculatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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

// Compound unique index: either examId or tenantId must be unique
NormalizationConfigSchema.index({ examId: 1 }, { unique: true, sparse: true });
NormalizationConfigSchema.index({ tenantId: 1 }, { unique: true, sparse: true });
NormalizationConfigSchema.index({ isLocked: 1 });

// Validation: must have either examId or tenantId, but not both
NormalizationConfigSchema.pre('validate', function(next) {
  if (!this.examId && !this.tenantId) {
    return next(new Error('Either examId or tenantId must be provided'));
  }
  if (this.examId && this.tenantId) {
    return next(new Error('Cannot have both examId and tenantId. Use examId for exam-level or tenantId for tenant-level normalization.'));
  }
  next();
});

export default mongoose.model('NormalizationConfig', NormalizationConfigSchema);
