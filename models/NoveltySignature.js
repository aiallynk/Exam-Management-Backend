import mongoose from 'mongoose';

// Source-Grounded AI Question Generation — the novelty/anti-duplication
// ledger. One collection with a `scope` discriminator (not two separate
// Tenant/Global collections): the atomic-reservation guarantee below
// needs exactly one unique index per signature value, and a GLOBAL row
// never carries tenantId or any raw text anyway, so splitting further
// buys no additional privacy.
//
// PRIVACY CONTRACT: GLOBAL-scope rows store ONLY an HMAC-keyed signature
// (see services/noveltyService.js — keyed with NOVELTY_SIGNATURE_SECRET,
// never derivable back to plaintext without that server secret). They
// never carry tenantId, questionId-resolvable-to-another-tenant's-content,
// or any source/question text. Cross-tenant novelty comparison therefore
// never requires exposing one tenant's raw question or source text to
// another tenant — only signature collisions are ever visible, and a
// collision reveals nothing about the colliding tenant's content.
//
// CONCURRENCY CONTRACT: the compound unique index { scope, layer,
// signature } IS the atomic reservation mechanism. Registering a
// signature is a plain `NoveltySignature.create(...)` — it either
// succeeds (this exact signature is now claimed / "novel") or throws a
// duplicate-key (E11000) error (not novel). There is no read-then-write
// step anywhere in this flow, so two concurrent generation requests
// (same or different tenants) racing on the same signature can never
// both "win".
const NoveltySignatureSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['TENANT', 'GLOBAL'],
      required: true,
    },
    // Always null when scope === 'GLOBAL' — enforced in noveltyService,
    // not just by convention, since this field is the privacy boundary.
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
      index: true,
    },
    layer: {
      type: String,
      enum: ['EXACT', 'NEAR', 'BLUEPRINT'],
      required: true,
    },
    // Hex HMAC-SHA256 digest. Never raw/plaintext content.
    signature: {
      type: String,
      required: true,
    },
    generationRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AIGenerationRun',
      default: null,
    },
    // Set once the candidate question is actually persisted as a real
    // Question — a reservation created during generation but never
    // followed by a saved question still blocks the signature (by
    // design: it was genuinely produced once, so it is not "novel" a
    // second time even if the first attempt was discarded downstream).
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// The atomic reservation index — see CONCURRENCY CONTRACT above.
NoveltySignatureSchema.index({ scope: 1, layer: 1, signature: 1 }, { unique: true });
// TENANT-scope rows only (GLOBAL rows have tenantId: null). A partialFilter
// expression cannot use $ne / $not (MongoDB rejects it — "Expression not
// supported in partial index: $not"); `{ $type: 'objectId' }` selects
// exactly the non-null tenant rows and is an allowed partial-filter
// operator.
NoveltySignatureSchema.index(
  { tenantId: 1, layer: 1, createdAt: -1 },
  { partialFilterExpression: { tenantId: { $type: 'objectId' } } }
);

export default mongoose.model('NoveltySignature', NoveltySignatureSchema);
