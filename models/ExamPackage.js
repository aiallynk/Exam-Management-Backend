import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamPackageSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
      immutable: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      required: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    packageHash: {
      type: String,
      required: true,
      trim: true,
    },
    encryptedData: {
      type: Buffer,
      required: true,
    },
    encryptionKeyHash: {
      type: String,
      required: true,
      trim: true,
    },
    size: {
      type: Number,
      required: true,
      min: 0, // Size in bytes
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Tenant field (inherited from exam)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
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

// Generate uniqueId before validation
ExamPackageSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('ExamPackage'),
        'PKG'
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Indexes
ExamPackageSchema.index({ examId: 1, version: 1 }, { unique: true });
ExamPackageSchema.index({ examId: 1, isActive: 1 });
ExamPackageSchema.index({ tenantId: 1 });
ExamPackageSchema.index({ expiresAt: 1 });

// Compound index for finding latest active package
ExamPackageSchema.index({ examId: 1, questionPaperId: 1, isActive: 1, version: -1 });

export default mongoose.model('ExamPackage', ExamPackageSchema);
