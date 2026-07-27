/**
 * Migration: backfill User.roles[] and safely correct evaluator accounts
 * that were created with role='CANDIDATE' before EVALUATOR existed as a
 * real role.
 *
 * This is intentionally conservative and additive:
 *
 *   1. Every user missing `roles` gets roles = [role]. Pure backfill, no
 *      behaviour change (this is also what the User model's pre-save hook
 *      does automatically the next time a document is saved — this step
 *      just does it in bulk up front).
 *
 *   2. Every user with evaluatorAccess.enabled=true that doesn't have
 *      EVALUATOR in roles gets it ADDED. Their primary `role` is preserved
 *      unless step 3 applies.
 *
 *   3. A user is only reclassified from primary CANDIDATE to primary
 *      EVALUATOR when ALL of the following hold:
 *        - role is currently CANDIDATE
 *        - evaluatorAccess.enabled is true
 *        - they have at least one ExaminerAssignment (evidence they were
 *          actually used as an evaluator)
 *        - they have ZERO ExamAttempt documents (no genuine candidate
 *          history to disturb)
 *      Everyone else with evaluatorAccess.enabled=true but ambiguous
 *      evidence (e.g. no assignment yet, or has real attempts) keeps their
 *      current primary role and is only reported, never destructively
 *      converted.
 *
 * Never touches ExamAttempt, Answer, ExaminerAssignment, or published
 * results — only User.role / User.roles.
 *
 * Usage:
 *   node scripts/migrateEvaluatorRoles.js            # dry run (default) — reports only, writes nothing
 *   node scripts/migrateEvaluatorRoles.js --apply     # writes the changes described above
 */

import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect } from '../utils/db.js';
import User from '../models/User.js';
import ExaminerAssignment from '../models/ExaminerAssignment.js';
import ExamAttempt from '../models/ExamAttempt.js';

const APPLY = process.argv.includes('--apply');

async function run() {
  console.log(`\n🚀 Evaluator role migration — ${APPLY ? 'APPLY (writes will be saved)' : 'DRY RUN (no writes)'}\n`);

  await connect();
  console.log('✅ Connected to database\n');

  const report = {
    usersInspected: 0,
    usersBackfilled: 0,
    usersGivenAdditionalEvaluatorRole: [],
    usersConvertedToEvaluatorPrimary: [],
    ambiguousUsers: [],
    failures: [],
  };

  try {
    // --- Step 1: backfill roles[] for every user missing it ---
    const missingRoles = await User.find({ $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }] });
    report.usersInspected += missingRoles.length;
    for (const user of missingRoles) {
      try {
        report.usersBackfilled += 1;
        if (APPLY) {
          user.roles = [user.role];
          await user.save();
        }
      } catch (error) {
        report.failures.push({ userId: String(user._id), email: user.email, step: 'backfill', error: error.message });
      }
    }
    console.log(`Step 1 — roles[] backfill: ${missingRoles.length} user(s) ${APPLY ? 'updated' : 'would be updated'}.`);

    // --- Step 2 & 3: evaluatorAccess.enabled users missing EVALUATOR in roles ---
    const evaluatorAccessUsers = await User.find({ 'evaluatorAccess.enabled': true });
    console.log(`Step 2/3 — inspecting ${evaluatorAccessUsers.length} user(s) with evaluatorAccess.enabled=true.`);

    for (const user of evaluatorAccessUsers) {
      report.usersInspected += 1;
      try {
        const currentRoles = new Set(Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role]);
        if (currentRoles.has('EVALUATOR')) {
          continue; // already correct
        }

        const [assignmentCount, attemptCount] = await Promise.all([
          ExaminerAssignment.countDocuments({ examinerId: user._id }),
          ExamAttempt.countDocuments({ userId: user._id }),
        ]);

        const conclusiveEvaluatorEvidence = user.role === 'CANDIDATE' && assignmentCount > 0 && attemptCount === 0;

        if (conclusiveEvaluatorEvidence) {
          report.usersConvertedToEvaluatorPrimary.push({
            userId: String(user._id),
            email: user.email,
            previousRole: user.role,
            previousRoles: Array.from(currentRoles),
            newRole: 'EVALUATOR',
            newRoles: ['EVALUATOR'],
            reason: `role was CANDIDATE with ${assignmentCount} examiner assignment(s) and 0 candidate attempts — evaluator-creation artifact, not a genuine candidate account`,
          });
          if (APPLY) {
            user.role = 'EVALUATOR';
            user.roles = ['EVALUATOR'];
            await user.save();
          }
          continue;
        }

        currentRoles.add('EVALUATOR');
        const entry = {
          userId: String(user._id),
          email: user.email,
          role: user.role,
          previousRoles: Array.from(new Set(Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role])),
          newRoles: Array.from(currentRoles),
          assignmentCount,
          attemptCount,
        };

        if (user.role === 'CANDIDATE') {
          entry.reason = attemptCount > 0
            ? 'has genuine candidate attempt history — kept CANDIDATE as primary, added EVALUATOR'
            : 'evaluatorAccess enabled but no examiner assignment evidence yet — ambiguous, kept CANDIDATE as primary, added EVALUATOR, flagged for admin review';
          report.ambiguousUsers.push(entry);
        } else {
          entry.reason = `existing ${user.role} granted additional EVALUATOR capability`;
          report.usersGivenAdditionalEvaluatorRole.push(entry);
        }

        if (APPLY) {
          user.roles = Array.from(currentRoles);
          await user.save();
        }
      } catch (error) {
        report.failures.push({ userId: String(user._id), email: user.email, step: 'evaluator-role', error: error.message });
      }
    }

    console.log('\n📊 Report');
    console.log(`  Users inspected: ${report.usersInspected}`);
    console.log(`  Users backfilled (roles[] added): ${report.usersBackfilled}`);
    console.log(`  Users given additional EVALUATOR role (non-CANDIDATE primary): ${report.usersGivenAdditionalEvaluatorRole.length}`);
    console.log(`  Users converted CANDIDATE -> EVALUATOR primary (conclusive evidence): ${report.usersConvertedToEvaluatorPrimary.length}`);
    console.log(`  Ambiguous CANDIDATE+evaluatorAccess users (flagged, not converted): ${report.ambiguousUsers.length}`);
    console.log(`  Failures: ${report.failures.length}`);

    if (report.usersConvertedToEvaluatorPrimary.length) {
      console.log('\n  Converted to EVALUATOR primary:');
      report.usersConvertedToEvaluatorPrimary.forEach((u) => console.log(`    - ${u.email} (${u.userId}): ${u.reason}`));
    }
    if (report.ambiguousUsers.length) {
      console.log('\n  Ambiguous — needs admin review:');
      report.ambiguousUsers.forEach((u) => console.log(`    - ${u.email} (${u.userId}): ${u.reason}`));
    }
    if (report.failures.length) {
      console.log('\n  Failures:');
      report.failures.forEach((f) => console.log(`    - ${f.email} (${f.userId}) at ${f.step}: ${f.error}`));
    }

    if (!APPLY) {
      console.log('\n⚠️  Dry run only — no documents were written. Re-run with --apply to persist these changes.');
    } else {
      console.log('\n✅ Changes written.');
    }

    return report;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

// Compares resolved absolute paths rather than raw strings — a plain
// `import.meta.url === file://${process.argv[1]}` check silently never
// matches on this project's path (it contains a space, which
// import.meta.url percent-encodes and argv[1] does not), so the script
// would exit 0 having done nothing.
const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default run;
