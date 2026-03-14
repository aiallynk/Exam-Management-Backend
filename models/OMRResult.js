import mongoose from 'mongoose';

const OMRResultSchema = new mongoose.Schema(
  {
    exam_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      index: true,
    },
    exam_code: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    candidate_roll: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    rollNumber: {
      type: String,
      trim: true,
      index: true,
    },
    student_roll_no: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },
    student_name: {
      type: String,
      trim: true,
      default: '',
    },
    omrSheetId: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },
    detected_answers: {
      type: [String],
      default: [],
    },
    detectedAnswers: {
      type: [String],
      default: [],
    },
    correct_answers: {
      type: [String],
      default: [],
    },
    total_questions: {
      type: Number,
      required: true,
      min: 0,
    },
    correct_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCorrect: {
      type: Number,
      default: 0,
      min: 0,
    },
    wrong_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWrong: {
      type: Number,
      default: 0,
      min: 0,
    },
    skipped_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalUnattempted: {
      type: Number,
      default: 0,
      min: 0,
    },
    invalid_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    negative_marks: {
      type: Number,
      default: 0,
      min: 0,
    },
    final_score: {
      type: Number,
      default: 0,
    },
    score: {
      type: Number,
      default: 0,
    },
    confidenceScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    manualReviewRequired: {
      type: Boolean,
      default: false,
      index: true,
    },
    status: {
      type: String,
      enum: ['PROCESSED', 'ERROR', 'INVALID', 'MANUAL_REVIEW', 'LOW_CONFIDENCE'],
      default: 'PROCESSED',
      index: true,
    },
    processed_at: {
      type: Date,
      default: Date.now,
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    evaluatedAt: {
      type: Date,
      default: Date.now,
    },
    paper_code: {
      type: String,
      trim: true,
      default: '',
    },
    qr_payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    candidate_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    candidate_matched: {
      type: Boolean,
      default: false,
      index: true,
    },
    preprocessing_meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    source_file: {
      type: String,
      default: '',
    },
    scanned_image_path: {
      type: String,
      default: '',
    },
    preview_url: {
      type: String,
      default: '',
    },
    sheet_index: {
      type: Number,
      default: 0,
      min: 0,
    },
    error_message: {
      type: String,
      default: '',
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

OMRResultSchema.index({ exam_id: 1, candidate_roll: 1 });
OMRResultSchema.index({ tenant_id: 1, exam_id: 1, processed_at: -1 });
OMRResultSchema.index({ examId: 1, rollNumber: 1 });
OMRResultSchema.index({ examId: 1, omrSheetId: 1 });
OMRResultSchema.index({ exam_code: 1, student_roll_no: 1 });
OMRResultSchema.index({ tenant_id: 1, exam_code: 1, processed_at: -1 });

export default mongoose.model('OMRResult', OMRResultSchema);
