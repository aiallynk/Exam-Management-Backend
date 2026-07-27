import mongoose from 'mongoose';
import config from '../config/env.js';
import ExamParticipant from '../models/ExamParticipant.js';
import ExaminerAssignment from '../models/ExaminerAssignment.js';

const dryRun = process.argv.includes('--dry-run');

const hasKey = (index, expectedKey) =>
  JSON.stringify(index.key) === JSON.stringify(expectedKey);

const run = async () => {
  await mongoose.connect(config.mongodbUri, { dbName: 'exam_system' });

  const participantIndexes = await ExamParticipant.collection.indexes();
  const roleAwareKey = { examId: 1, userId: 1, examRole: 1 };
  const legacyUserExamIndexes = participantIndexes.filter((index) =>
    index.unique === true && hasKey(index, { examId: 1, userId: 1 })
  );

  if (!participantIndexes.some((index) => index.unique === true && hasKey(index, roleAwareKey))) {
    if (dryRun) {
      console.log('[dry-run] Would create the role-aware ExamParticipant unique index.');
    } else {
      await ExamParticipant.collection.createIndex(roleAwareKey, {
        unique: true,
        name: 'examId_1_userId_1_examRole_1',
      });
      console.log('Created role-aware ExamParticipant unique index.');
    }
  }

  for (const index of legacyUserExamIndexes) {
    if (dryRun) {
      console.log(`[dry-run] Would drop legacy unique index ${index.name}.`);
    } else {
      await ExamParticipant.collection.dropIndex(index.name);
      console.log(`Dropped legacy unique index ${index.name}.`);
    }
  }

  const duplicateActiveAssignments = await ExaminerAssignment.aggregate([
    { $match: { status: 'ACTIVE' } },
    {
      $group: {
        _id: { examId: '$examId', examinerId: '$examinerId', scopeType: '$scopeType' },
        assignmentIds: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);
  if (duplicateActiveAssignments.length) {
    throw new Error(`Cannot create active evaluator assignment uniqueness guard: ${duplicateActiveAssignments.length} duplicate active scope group(s) require review.`);
  }

  const assignmentIndexes = await ExaminerAssignment.collection.indexes();
  const activeScopeKey = { examId: 1, examinerId: 1, scopeType: 1 };
  const hasActiveScopeGuard = assignmentIndexes.some((index) =>
    index.unique === true &&
    hasKey(index, activeScopeKey) &&
    index.partialFilterExpression?.status === 'ACTIVE'
  );
  if (!hasActiveScopeGuard) {
    if (dryRun) {
      console.log('[dry-run] Would create the active evaluator assignment uniqueness guard.');
    } else {
      await ExaminerAssignment.collection.createIndex(activeScopeKey, {
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'active_evaluator_assignment_scope_unique',
      });
      console.log('Created active evaluator assignment uniqueness guard.');
    }
  }

  console.log(dryRun ? 'Evaluator assignment index migration dry run complete.' : 'Evaluator assignment index migration complete.');
};

run()
  .catch((error) => {
    console.error('Evaluator assignment index migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
