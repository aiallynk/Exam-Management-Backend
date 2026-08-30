import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

/**
 * ExamParticipant Model
 * 
 * Universal exam-context role system that replaces education-biased role assumptions.
 * A single user can have different roles for different exams:
 * - CREATOR: Created the exam
 * - CANDIDATE: Can attempt the exam
 * - EVALUATOR: Can review/evaluate attempts
 * 
 * This enables the platform to support:
 * - Hiring platforms (candidate takes exam)
 * - Corporate assessments (employee takes exam)
 * - Government exams (citizen takes exam)
 * - Certifications (applicant takes exam)
 * - Education (student takes exam)
 * 
 * All use the same universal model.
 */
const ExamParticipantSchema = new mongoose.Schema(
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
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    examRole: {
      type: String,
      enum: ['CREATOR', 'CANDIDATE', 'EVALUATOR', 'MODERATOR'],
      required: true,
    },
    permissions: {
      CREATE_SESSION: {
        type: Boolean,
        default: false,
      },
      VIEW_RESULTS: {
        type: Boolean,
        default: false,
      },
      ATTEMPT_EXAM: {
        type: Boolean,
        default: false,
      },
      REVIEW_ANSWERS: {
        type: Boolean,
        default: false,
      },
      MODERATE_EVALUATIONS: {
        type: Boolean,
        default: false,
      },
    },
    assignedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Tenant field (inherited from exam for performance)
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
    },
    // Frozen at exam-roster assignment for offline script mapping integrity.
    candidateIdentitySnapshot: {
      displayName: { type: String, trim: true, default: '' },
      rollNumber: { type: String, trim: true, default: '' },
      externalStudentId: { type: String, trim: true, default: '' },
      enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment', default: null },
      academicSectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSection', default: null },
      capturedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  }
);

// Generate uniqueId before validation
ExamParticipantSchema.pre('validate', async function (next) {
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('ExamParticipant'),
        'EP' // Exam Participant prefix
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Set default permissions based on examRole
ExamParticipantSchema.pre('save', function (next) {
  // Set permissions based on role if not explicitly set
  if (this.isNew || this.isModified('examRole')) {
    switch (this.examRole) {
      case 'CREATOR':
        // Creators can do everything
        this.permissions.CREATE_SESSION = true;
        this.permissions.VIEW_RESULTS = true;
        this.permissions.ATTEMPT_EXAM = false; // Creators typically don't take their own exams
        this.permissions.REVIEW_ANSWERS = true;
        break;
      case 'CANDIDATE':
        // Candidates can attempt and view their own results
        this.permissions.CREATE_SESSION = false;
        this.permissions.VIEW_RESULTS = true; // Can view own results
        this.permissions.ATTEMPT_EXAM = true;
        this.permissions.REVIEW_ANSWERS = false; // Can only review own answers
        break;
      case 'EVALUATOR':
        // Evaluators can review and view results
        this.permissions.CREATE_SESSION = false;
        this.permissions.VIEW_RESULTS = true;
        this.permissions.ATTEMPT_EXAM = false;
        this.permissions.REVIEW_ANSWERS = true;
        this.permissions.MODERATE_EVALUATIONS = false;
        break;
      case 'MODERATOR':
        // Moderators review flagged/examiner-scored evaluations and results
        this.permissions.CREATE_SESSION = false;
        this.permissions.VIEW_RESULTS = true;
        this.permissions.ATTEMPT_EXAM = false;
        this.permissions.REVIEW_ANSWERS = true;
        this.permissions.MODERATE_EVALUATIONS = true;
        break;
    }
  }
  next();
});

// Validate: Participant tenantId will be inherited from exam
// Allow null initially - will be populated from exam
ExamParticipantSchema.pre('save', function (next) {
  // tenantId can be null initially - will be set from exam
  next();
});

// Compound unique index: one user can have only one role per exam
ExamParticipantSchema.index({ examId: 1, userId: 1, examRole: 1 }, { unique: true });

// Single field indexes
ExamParticipantSchema.index({ userId: 1, examRole: 1 });
ExamParticipantSchema.index({ examId: 1, examRole: 1 });

// Compound indexes for common queries
ExamParticipantSchema.index({ userId: 1, examRole: 1, createdAt: -1 });
ExamParticipantSchema.index({ examId: 1, examRole: 1, createdAt: -1 });
ExamParticipantSchema.index({ tenantId: 1, examRole: 1 });

export default mongoose.model('ExamParticipant', ExamParticipantSchema);

