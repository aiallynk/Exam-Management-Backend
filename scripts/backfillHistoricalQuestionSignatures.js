import mongoose from 'mongoose';
import config from '../config/env.js';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Exam from '../models/Exam.js';
import {
  canonicalizeQuestionText,
  computeExactSignature,
  buildCanonicalQuestionRepresentation,
  registerAndCheckNovelty,
} from '../services/noveltyService.js';

// Source-Grounded AI Question Generation — idempotent backfill of
// privacy-safe novelty signatures for questions that existed before this
// feature (master prompt §29). Additive only: sets legacySignature /
// legacySignatureComputedAt and never touches questionText/options/etc.
// Historical questions have no source/chunk provenance to reconstruct, so
// only an EXACT (lexical) signature is computed — no NEAR/BLUEPRINT
// layers, which need the fuller candidate shape this feature produces at
// generation time. This still lets future generation runs detect an
// exact rephrase-free duplicate of pre-existing exam content.
//
// Safe to re-run: skips any Question that already has legacySignature.
// Batched via a cursor (500/page) so this never loads the whole
// collection into memory. Mirrors scripts/migrateEvaluatorAssignmentIndexes.js's
// --dry-run / connect-then-disconnect conventions.

const dryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

const run = async () => {
  await mongoose.connect(config.mongodbUri, { dbName: 'exam_system' });

  const filter = { legacySignature: { $exists: false } };
  const eligibleCount = await Question.countDocuments(filter);
  console.log(`${eligibleCount} question(s) without a legacySignature found.`);

  if (dryRun) {
    console.log('[dry-run] No changes made. Re-run without --dry-run to backfill.');
    return;
  }

  // tenantId is resolved per-question via its QuestionPaper -> Exam chain
  // (Question has no direct tenantId field — see models/Question.js) so
  // the TENANT-scope novelty reservation is scoped correctly, matching
  // every other tenant-isolation query in this feature.
  const questionPaperTenantCache = new Map();

  const resolveTenantIdForQuestionPaper = async (questionPaperId) => {
    const key = String(questionPaperId);
    if (questionPaperTenantCache.has(key)) return questionPaperTenantCache.get(key);
    const questionPaper = await QuestionPaper.findById(questionPaperId).select('examId').lean();
    let tenantId = null;
    if (questionPaper?.examId) {
      const exam = await Exam.findById(questionPaper.examId).select('tenantId').lean();
      tenantId = exam?.tenantId || null;
    }
    questionPaperTenantCache.set(key, tenantId);
    return tenantId;
  };

  let processed = 0;
  let registered = 0;
  let skippedNoTenant = 0;

  const cursor = Question.find(filter).select('questionPaperId questionText options correctAnswer questionType').cursor({ batchSize: BATCH_SIZE });

  for await (const question of cursor) {
    const tenantId = await resolveTenantIdForQuestionPaper(question.questionPaperId);
    const canonicalRepresentation = buildCanonicalQuestionRepresentation({
      questionText: question.questionText,
      options: question.options,
      correctAnswer: question.correctAnswer,
      questionType: question.questionType,
    });
    const signature = computeExactSignature(canonicalRepresentation);

    if (tenantId) {
      const reservation = await registerAndCheckNovelty({
        scope: 'TENANT',
        tenantId,
        layer: 'EXACT',
        signature,
        generationRunId: null,
      });
      if (reservation.novel) registered += 1;
    } else {
      skippedNoTenant += 1;
    }

    await Question.updateOne(
      { _id: question._id },
      { $set: { legacySignature: signature, legacySignatureComputedAt: new Date() } }
    );
    processed += 1;
    if (processed % BATCH_SIZE === 0) {
      console.log(`Processed ${processed}/${eligibleCount}...`);
    }
  }

  console.log(
    `Backfill complete. Processed ${processed} question(s); registered ${registered} tenant-scope novelty signature(s); ` +
      `${skippedNoTenant} question(s) had no resolvable tenant (orphaned QuestionPaper/Exam) and were signed but not registered.`
  );
};

run()
  .catch((error) => {
    console.error('Historical question signature backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
