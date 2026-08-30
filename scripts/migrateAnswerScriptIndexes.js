import mongoose from 'mongoose';
import config from '../config/env.js';
import ExamAttempt from '../models/ExamAttempt.js';
import AnswerSegment from '../models/AnswerSegment.js';
import AnswerAnnotation from '../models/AnswerAnnotation.js';

const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName });
  const duplicateAttempts = await ExamAttempt.aggregate([
    { $match: { sourceAnswerScriptId: { $type: 'objectId' } } },
    { $group: { _id: '$sourceAnswerScriptId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);
  if (duplicateAttempts.length) {
    throw new Error(`Cannot add the offline attempt idempotency index: ${duplicateAttempts.length} duplicate source script group(s) need manual review.`);
  }

  const operations = [
    [ExamAttempt.collection, { sourceAnswerScriptId: 1 }, {
      unique: true,
      partialFilterExpression: { sourceAnswerScriptId: { $type: 'objectId' } },
      name: 'sourceAnswerScriptId_1_unique',
    }],
    [AnswerSegment.collection, { tenantId: 1, answerScriptId: 1, segmentKey: 1 }, {
      unique: true,
      partialFilterExpression: { segmentKey: { $type: 'string' } },
      name: 'answer_script_segment_key_unique',
    }],
    [AnswerAnnotation.collection, { tenantId: 1, idempotencyKey: 1 }, {
      unique: true,
      name: 'answer_annotation_idempotency_unique',
    }],
  ];
  for (const [collection, keys, options] of operations) {
    if (dryRun) console.log(`[dry-run] Would create ${options.name}.`);
    else {
      await collection.createIndex(keys, options);
      console.log(`Created or verified ${options.name}.`);
    }
  }
  console.log(dryRun ? 'Answer-script index migration dry run complete.' : 'Answer-script index migration complete.');
};

run().catch((error) => {
  console.error('Answer-script index migration failed:', error.message);
  process.exitCode = 1;
}).finally(async () => mongoose.disconnect());

