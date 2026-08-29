import mongoose from 'mongoose';

// Content Library — the educator-facing domain (Blueprint section 7B).
// LibraryResource is the logical unit an educator thinks in (a textbook, a
// chapter, a past paper, a set of teacher notes); ContextSource/ContextChunk
// remain the technical asset/retrieval layer underneath it (Part K) — one
// LibraryResource may own one or many ContextSource files/URLs via
// ContextSource.libraryResourceId, and a multi-file upload resolves to one
// logical resource here rather than several unrelated rows. Nothing about
// ingestion/chunking/embedding is duplicated; this model only adds the
// educator-facing grouping/metadata layer on top of what already exists.
const LibraryResourceSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    resourceType: {
      type: String,
      enum: [
        'TEXTBOOK', 'BOOK', 'CHAPTER', 'SYLLABUS', 'CURRICULUM_DOCUMENT',
        'TEACHER_NOTES', 'STUDY_MATERIAL', 'LESSON_MATERIAL', 'WORKSHEET',
        'PAST_PAPER', 'MODEL_PAPER', 'MARKING_GUIDE', 'REFERENCE',
        'IMAGE_COLLECTION', 'OTHER',
      ],
      default: 'OTHER',
    },
    // A CHAPTER (or any sub-unit) resource may point back at its parent
    // textbook/book resource (Part L) — book/chapter structure without
    // requiring every chapter to be a separate top-level upload.
    parentResourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryResource', default: null, index: true },

    // Same 10-field academic scope shape ContextSource/utils/contentScope.js
    // already use — every field optional; a whole textbook may be scoped to
    // just a program+course, a chapter may add more.
    academicScope: { type: mongoose.Schema.Types.Mixed, default: {} },
    chapter: { type: String, trim: true, default: '' },
    unit: { type: String, trim: true, default: '' },
    topic: { type: String, trim: true, default: '' },

    // ACADEMIC_SHARED (not "SHARED") per the master brief's own naming for
    // this model specifically — kept distinct from ContextSource.visibility's
    // existing PRIVATE/COURSE/SHARED enum (unchanged, lower-level, already
    // shipped and tested) to avoid any risk to that already-working code.
    visibility: { type: String, enum: ['PRIVATE', 'COURSE', 'ACADEMIC_SHARED'], default: 'PRIVATE' },
    approvalStatus: { type: String, enum: ['DRAFT', 'READY', 'APPROVED', 'ARCHIVED'], default: 'DRAFT', index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    // Optional bibliographic metadata — never required.
    metadata: {
      publisher: { type: String, trim: true, default: '' },
      edition: { type: String, trim: true, default: '' },
      language: { type: String, trim: true, default: '' },
      isbn: { type: String, trim: true, default: '' },
      author: { type: String, trim: true, default: '' },
    },
  },
  { timestamps: true }
);

LibraryResourceSchema.index({ tenantId: 1, visibility: 1 });
LibraryResourceSchema.index({ tenantId: 1, createdBy: 1 });
LibraryResourceSchema.index({ tenantId: 1, parentResourceId: 1 });
LibraryResourceSchema.index({ tenantId: 1, resourceType: 1 });

export default mongoose.model('LibraryResource', LibraryResourceSchema);
