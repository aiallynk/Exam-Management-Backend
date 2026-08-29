import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const ExamSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
      immutable: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    instructions: {
      type: String,
      trim: true,
      default: '',
    },
    examType: {
      type: String,
      enum: ['ONLINE', 'OMR'],
      default: 'ONLINE',
      index: true,
    },
    // Independent of examType (which distinguishes ONLINE candidate-portal
    // delivery from OMR bubble-sheet delivery). deliveryMode instead
    // answers "does this assessment accept scanned subjective/mixed
    // answer scripts" (Master Phase 4 — see docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md
    // Part 13). Legacy exams default to ONLINE, preserving current
    // behavior exactly.
    deliveryMode: {
      type: String,
      enum: ['ONLINE', 'OFFLINE', 'HYBRID'],
      default: 'ONLINE',
      index: true,
    },
    duration: {
      type: Number,
      required: true,
      min: 1,
    },
    timingMode: {
      type: String,
      enum: ['overall', 'section_based'],
      default: 'overall',
    },
    allowDurationOverride: {
      type: Boolean,
      default: false,
    },
    // Controls whether AI/rule scores are immediately final or stay
    // provisional pending examiner (and optionally moderator) verification.
    // Default 'AUTOMATIC' preserves today's behavior for every existing exam.
    evaluationMode: {
      type: String,
      enum: ['AUTOMATIC', 'AI_OPTIONAL_REVIEW', 'AI_MANDATORY_REVIEW', 'MANUAL', 'HYBRID'],
      default: 'AUTOMATIC',
    },
    // Null (the default for every exam that predates and every exam that
    // doesn't opt into this) means candidate responses are never
    // auto-distributed among evaluators — assignment stays whatever an admin
    // does manually via /api/exams/:examId/evaluators. Set only when the
    // exam creator explicitly registers evaluators for automatic
    // distribution (see services/responseDistributionService.js).
    evaluatorDistributionStrategy: {
      type: String,
      enum: ['RANDOM_BALANCED', 'ROUND_ROBIN', 'WORKLOAD_BASED', null],
      default: null,
    },
    gracePeriod: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxAttempts: {
      type: Number,
      default: 1,
      min: 1,
    },
    showResultsImmediately: {
      type: Boolean,
      default: false,
    },
    resultsReleasedAt: {
      type: Date,
    },
    certificatesSentAt: {
      type: Date,
    },
    certificateTemplate: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    allowCertification: {
      type: Boolean,
      default: false,
    },
    passingPercentage: {
      type: Number,
      default: 60,
      min: 0,
      max: 100,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // V2 context is additive. Null/default values preserve all legacy exams.
    // creationMode records which Step 1 flow the creator took; it never
    // gates capability. Null covers every exam created before this field
    // existed and every exam created with an empty academicContext today —
    // both are legacy-compatible and behave exactly like QUICK.
    creationMode: { type: String, enum: ['QUICK', 'ACADEMIC'], default: null },
    assessmentPurpose: { type: String, enum: ['OF', 'FOR', 'AS'], default: 'OF', index: true },
    assessmentType: { type: String, trim: true, default: 'EXAM' },
    academicContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    frameworkId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentFramework', default: null },
    frameworkVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FrameworkVersion', default: null },
    rubricTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'RubricTemplate', default: null },
    // Immutable copy of the selected published rubric. Questions carry their
    // applicable criteria too, but this records the assessment-level source
    // template/version without relying on a mutable lookup later.
    rubricSnapshot: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    // Governance is resolved by the application and frozen with the assessment.
    resolvedSpecificationSnapshot: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    resolvedSpecificationAt: { type: Date, default: null, immutable: true },
    // Tenant field - Exam belongs to a tenant
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    subTenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubTenant',
      default: null,
      index: true,
    },
    // AI generation metadata
    aiGenerated: {
      type: Boolean,
      default: false,
    },
    aiInputSource: {
      type: String,
      enum: ['TOPIC_ONLY', 'DETAILED_CONTENT'],
    },
    aiMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    supportedLanguages: {
      type: [String],
      default: ['en'],
    },
    defaultLanguage: {
      type: String,
      default: 'en',
      trim: true,
    },
    allowMultiLanguage: {
      type: Boolean,
      default: false,
    },
    // Offline exam package fields
    offlinePackageVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    packageVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    packageStatus: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'READY', 'GENERATED', 'NOT_GENERATED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    packageGeneratedAt: {
      type: Date,
    },
    offlinePackageGeneratedAt: {
      type: Date,
    },
    packageLastGeneratedAt: {
      type: Date,
    },
    latestPackageUrl: {
      type: String,
      default: '',
      trim: true,
    },
    packageLastError: {
      type: String,
      default: '',
      trim: true,
    },
    offlinePackageEnabled: {
      type: Boolean,
      default: false,
    },
    questionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalMarks: {
      type: Number,
      default: 0,
      min: 0,
    },
    candidateCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    answerKey: {
      type: [String],
      default: [],
    },
    markingRules: {
      totalQuestions: {
        type: Number,
        default: 0,
        min: 0,
      },
      optionsPerQuestion: {
        type: Number,
        default: 4,
        min: 2,
      },
      marksPerQuestion: {
        type: Number,
        default: 1,
        min: 0,
      },
      negativeMarking: {
        type: Boolean,
        default: false,
      },
      negativeMarks: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    omrTemplateImage: {
      type: String,
      trim: true,
      default: '',
    },
    accessControl: {
      ipWhitelist: {
        type: [String],
        default: [],
      },
      geoRestrictions: {
        enabled: {
          type: Boolean,
          default: false,
        },
        allowedCountries: {
          type: [String],
          default: [],
        },
        allowedRegions: {
          type: [String],
          default: [],
        },
        allowUnknownLocation: {
          type: Boolean,
          default: true,
        },
      },
      secureBrowser: {
        enabled: {
          type: Boolean,
          default: true,
        },
        requireFullscreen: {
          type: Boolean,
          default: true,
        },
        blockClipboard: {
          type: Boolean,
          default: true,
        },
        blockRightClick: {
          type: Boolean,
          default: true,
        },
        blockKeyboardShortcuts: {
          type: Boolean,
          default: true,
        },
        blockTabSwitch: {
          type: Boolean,
          default: true,
        },
      },
    },
  },
  {
    timestamps: true,
  }
);

// Validate: Exam must belong to a tenant
ExamSchema.pre('save', function (next) {
  if (!this.tenantId) {
    return next(new Error('Exam must belong to a tenant'));
  }

  next();
});

// Generate uniqueId before validation
ExamSchema.pre('validate', async function (next) {
  if (!this.tenantId) {
    return next(new Error('tenantId is required before saving Exam'));
  }

  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Exam'),
        ID_PREFIXES.EXAM
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Indexes
ExamSchema.index({ tenantId: 1, createdAt: -1 });
ExamSchema.index({ createdBy: 1, createdAt: -1 });
ExamSchema.index({ tenantId: 1, isActive: 1 });
ExamSchema.index({ tenantId: 1, examType: 1, createdAt: -1 });
ExamSchema.index({ tenantId: 1, assessmentPurpose: 1, createdAt: -1 });
ExamSchema.index({ tenantId: 1, subTenantId: 1, createdAt: -1 });

export default mongoose.model('Exam', ExamSchema);
