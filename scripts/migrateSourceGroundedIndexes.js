import mongoose from 'mongoose';
import config from '../config/env.js';
import ContextSet from '../models/ContextSet.js';
import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import AIGenerationRun from '../models/AIGenerationRun.js';
import NoveltySignature from '../models/NoveltySignature.js';

// Source-Grounded AI Question Generation — idempotently ensures every
// index (including the partial-unique ones Mongoose autoIndex may not
// have created yet in an environment where autoIndex is disabled, which
// is typical in production) exists for the five new collections this
// feature introduces. Safe to re-run; creates nothing that already
// exists. Mirrors scripts/migrateEvaluatorAssignmentIndexes.js exactly.

const dryRun = process.argv.includes('--dry-run');

const hasKey = (index, expectedKey) => JSON.stringify(index.key) === JSON.stringify(expectedKey);

const ensureIndex = async (Model, key, options) => {
  const existingIndexes = await Model.collection.indexes();
  const alreadyExists = existingIndexes.some(
    (index) =>
      hasKey(index, key) &&
      Boolean(index.unique) === Boolean(options.unique) &&
      JSON.stringify(index.partialFilterExpression || null) ===
        JSON.stringify(options.partialFilterExpression || null)
  );
  if (alreadyExists) {
    console.log(`[skip] ${Model.modelName} index ${options.name} already exists.`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] Would create ${Model.modelName} index ${options.name}.`);
    return;
  }
  await Model.collection.createIndex(key, options);
  console.log(`Created ${Model.modelName} index ${options.name}.`);
};

const run = async () => {
  await mongoose.connect(config.mongodbUri, { dbName: 'exam_system' });

  await ensureIndex(
    ContextSet,
    { tenantId: 1, createdBy: 1, createdAt: -1 },
    { name: 'tenantId_1_createdBy_1_createdAt_-1' }
  );
  await ensureIndex(ContextSet, { tenantId: 1, examId: 1 }, { name: 'tenantId_1_examId_1' });

  await ensureIndex(ContextSource, { tenantId: 1, contextSetId: 1 }, { name: 'tenantId_1_contextSetId_1' });
  await ensureIndex(ContextSource, { tenantId: 1, status: 1 }, { name: 'tenantId_1_status_1' });
  await ensureIndex(
    ContextSource,
    { contextSetId: 1, snapshotHash: 1 },
    {
      unique: true,
      partialFilterExpression: { snapshotHash: { $type: 'string', $ne: '' } },
      name: 'contextSetId_1_snapshotHash_1_partial_unique',
    }
  );

  await ensureIndex(
    ContextChunk,
    { tenantId: 1, sourceId: 1, chunkIndex: 1 },
    { unique: true, name: 'tenantId_1_sourceId_1_chunkIndex_1_unique' }
  );
  await ensureIndex(ContextChunk, { tenantId: 1, contextSetId: 1 }, { name: 'tenantId_1_contextSetId_1' });

  await ensureIndex(
    AIGenerationRun,
    { tenantId: 1, createdAt: -1 },
    { name: 'tenantId_1_createdAt_-1' }
  );
  await ensureIndex(
    AIGenerationRun,
    { tenantId: 1, generationMode: 1, createdAt: -1 },
    { name: 'tenantId_1_generationMode_1_createdAt_-1' }
  );

  await ensureIndex(
    NoveltySignature,
    { scope: 1, layer: 1, signature: 1 },
    { unique: true, name: 'scope_1_layer_1_signature_1_unique' }
  );
  await ensureIndex(
    NoveltySignature,
    { tenantId: 1, layer: 1, createdAt: -1 },
    { partialFilterExpression: { tenantId: { $ne: null } }, name: 'tenantId_1_layer_1_createdAt_-1_partial' }
  );

  console.log(dryRun ? 'Source-Grounded index migration dry run complete.' : 'Source-Grounded index migration complete.');
};

run()
  .catch((error) => {
    console.error('Source-Grounded index migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
