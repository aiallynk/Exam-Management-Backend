import mongoose from 'mongoose';

// Source-Grounded AI Question Generation — one chunk of extracted text from
// a ContextSource, plus its embedding vector. Retrieval is deliberately
// in-app (cosine similarity computed in Node over a bounded, pre-filtered
// set — see services/contextRetrievalService.js) rather than an Atlas
// Vector Search index: a generation call only ever ranks chunks belonging
// to <=10 tenant-selected sources, never a global corpus, so a dedicated
// vector index would add infrastructure without a benefit at this scale.
const ContextChunkSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    contextSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ContextSet',
      required: true,
      index: true,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ContextSource',
      required: true,
      index: true,
    },
    chunkIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    text: {
      type: String,
      required: true,
    },
    charCount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Plain array, not a typed vector — no Atlas Search index depends on
    // this field's shape, so a plain [Number] keeps this portable across
    // any Mongo deployment.
    embedding: {
      type: [Number],
      required: true,
    },
    embeddingModel: {
      type: String,
      required: true,
      trim: true,
      default: 'text-embedding-3-small',
    },
  },
  {
    timestamps: true,
  }
);

// Covers the retrieval query directly: { tenantId, sourceId: { $in: [...] } }.
ContextChunkSchema.index({ tenantId: 1, sourceId: 1, chunkIndex: 1 }, { unique: true });
ContextChunkSchema.index({ tenantId: 1, contextSetId: 1 });

export default mongoose.model('ContextChunk', ContextChunkSchema);
