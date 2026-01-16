import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const SectionSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false,
      sparse: true,
      immutable: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
    duration: {
      type: Number,
      required: true,
      min: 1, // minutes
    },
    marks: {
      type: Number,
      default: 0,
      min: 0,
    },
    negativeMarking: {
      type: Number,
      default: 0,
      min: 0,
    },
    navigationRule: {
      type: String,
      enum: ['FREE', 'LINEAR', 'ADMIN_CONFIGURED'],
      default: 'FREE',
    },
    instructions: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expectedQuestions: {
      type: Number,
      default: 25,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
SectionSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Section'),
        'SEC'
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

SectionSchema.index({ uniqueId: 1 });
SectionSchema.index({ questionPaperId: 1, order: 1 });
SectionSchema.index({ questionPaperId: 1, isActive: 1 });

export default mongoose.model('Section', SectionSchema);
