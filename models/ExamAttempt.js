import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamAttemptSchema = new mongoose.Schema(
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
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamSession',
      required: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Tenant field (inherited from exam, but stored for performance)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
    },
    startTime: {
      type: Date,
      required: true,
      default: Date.now,
    },
    submitTime: {
      type: Date,
    },
    submittedAt: {
      type: Date,
    },
    submitMeta: {
      submissionSource: {
        type: String,
        trim: true,
      },
      violationType: {
        type: String,
        trim: true,
      },
      submittedAtClient: {
        type: Date,
      },
      totalRemainingSeconds: {
        type: Number,
        min: 0,
      },
      currentSectionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Section',
      },
      clientSubmissionId: {
        type: String,
        trim: true,
      },
      finalizedAfterViolation: {
        type: Boolean,
        default: false,
      },
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    isDisqualified: {
      type: Boolean,
      default: false,
    },
    disqualifyReason: {
      type: String,
      trim: true,
    },
    disqualifyStatus: {
      type: String,
      trim: true,
    },
    examSnapshot: {
      title: { type: String, trim: true },
      description: { type: String, trim: true },
    },
    tabSwitchCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    scoreSummary: {
      totalScore: {
        type: Number,
        default: 0,
        min: 0,
      },
      maxScore: {
        type: Number,
        default: 0,
        min: 0,
      },
      percentage: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      computedAt: {
        type: Date,
      },
    },
    normalizedScore: {
      type: Number,
    },
    percentile: {
      type: Number,
      min: 0,
      max: 100,
    },
    sessionPercentile: {
      type: Number,
      min: 0,
      max: 100,
    },
    currentSectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
    },
    navigationRule: {
      type: String,
      enum: ['FREE', 'NO_FREE'],
      default: 'FREE',
    },
    sectionStateUpdatedAt: {
      type: Date,
      default: Date.now,
    },
    sectionTimers: {
      type: Map,
      of: {
        startTime: { type: Date },
        endTime: { type: Date },
        isLocked: { type: Boolean, default: false },
        timeSpent: { type: Number, default: 0 }, // seconds
        durationSeconds: { type: Number, min: 0, default: 0 },
        remainingSeconds: { type: Number, min: 0, default: 0 },
        isActive: { type: Boolean, default: false },
        isCompleted: { type: Boolean, default: false },
        startedAt: { type: Date },
        lastResumedAt: { type: Date },
        completedAt: { type: Date },
      },
      default: new Map(),
    },
    reAttemptAllowed: {
      type: Boolean,
      default: false,
    },
    reAttemptReason: {
      type: String,
      trim: true,
    },
    reAttemptAllowedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reAttemptAllowedAt: {
      type: Date,
    },
    isResumed: {
      type: Boolean,
      default: false,
    },
    resumeReason: {
      type: String,
      trim: true,
    },
    resumeAllowedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    resumeAllowedAt: {
      type: Date,
    },
    deviceInfo: {
      ipAddress: { type: String },
      userAgent: { type: String },
      deviceId: { type: String },
      browserSessionId: { type: String },
    },
    suspiciousActivity: {
      type: Boolean,
      default: false,
    },
    suspiciousActivityFlags: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    proctoringViolations: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    violationCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    violationLogs: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    examStatus: {
      type: String,
      enum: ['FAIR', 'SUSPICIOUS', 'CHEATING'],
      default: 'FAIR',
    },
    adminFlags: {
      status: {
        type: String,
        enum: ['VALID', 'SUSPICIOUS', 'INVALID'],
        default: null,
      },
      flaggedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      flaggedAt: {
        type: Date,
      },
      reason: {
        type: String,
        trim: true,
      },
    },
    adminNotes: [{
      note: {
        type: String,
        required: true,
        trim: true,
      },
      addedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      addedAt: {
        type: Date,
        default: Date.now,
      },
    }],
    // Master Phase 4 — set only when this ExamAttempt was materialized
    // from a scanned answer script rather than a candidate typing online.
    // Distinct from offlineMode below, which is the pre-existing
    // PWA-offline-continuity flag for an ONLINE attempt that lost
    // connectivity — not related to scanned paper evaluation.
    sourceAnswerScriptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AnswerScript',
      default: null,
    },
    // Offline exam attempt fields
    offlineMode: {
      type: Boolean,
      default: false,
    },
    packageVersion: {
      type: Number,
    },
    packageHash: {
      type: String,
      trim: true,
    },
    deviceFingerprint: {
      type: String,
      trim: true,
    },
    offlineStartTime: {
      type: Date,
    },
    offlineSubmitTime: {
      type: Date,
    },
    violationEvents: [{
      type: {
        type: String,
        enum: ['SCREENSHOT', 'BACKGROUND', 'SCREEN_LOCK', 'APP_KILL', 'SPLIT_SCREEN', 'COPY_PASTE', 'OTHER'],
        required: true,
      },
      timestamp: {
        type: Date,
        required: true,
      },
      details: {
        type: String,
        trim: true,
      },
    }],
    timestampDrift: {
      type: Number,
      default: 0, // Difference in milliseconds between device time and server time
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
ExamAttemptSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('ExamAttempt'),
        ID_PREFIXES.ATTEMPT
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Validate: Attempt tenantId will be inherited from exam
// Allow null initially - will be populated from exam
ExamAttemptSchema.pre('save', function (next) {
  // tenantId can be null initially - will be set from exam
  next();
});

// Single field indexes
ExamAttemptSchema.index({ userId: 1, createdAt: -1 });
ExamAttemptSchema.index({ tenantId: 1 });

// Compound indexes for common query patterns
// For checking max attempts: { userId, examId, isCompleted }
ExamAttemptSchema.index({ userId: 1, examId: 1, isCompleted: 1 });

// For finding active attempts: { userId, sessionId, isCompleted }
ExamAttemptSchema.index({ userId: 1, sessionId: 1, isCompleted: 1 });

// For tenant-scoped queries: { tenantId, createdAt }
ExamAttemptSchema.index({ tenantId: 1, createdAt: -1 });
ExamAttemptSchema.index({ tenantId: 1, userId: 1 });

// For results queries: { examId, isCompleted, isDisqualified }
ExamAttemptSchema.index({ examId: 1, isCompleted: 1, isDisqualified: 1 });

// For session queries: { sessionId, isCompleted }
ExamAttemptSchema.index({ sessionId: 1, isCompleted: 1 });

export default mongoose.model('ExamAttempt', ExamAttemptSchema);

