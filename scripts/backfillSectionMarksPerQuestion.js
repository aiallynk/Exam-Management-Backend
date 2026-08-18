/**
 * Backfill Section.marksPerQuestion for sections created before this field
 * existed. Additive/safe: only touches sections missing the field, derives
 * a sensible value from the legacy `marks` (total) / `expectedQuestions`
 * snapshot, and never touches Question documents. Safe to re-run.
 *
 * Usage: node scripts/backfillSectionMarksPerQuestion.js [--dry-run]
 */
import { connect, disconnect } from '../utils/db.js';
import Section from '../models/Section.js';

const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  await connect();
  try {
    const sections = await Section.find({
      $or: [{ marksPerQuestion: { $exists: false } }, { marksPerQuestion: null }],
    }).select('_id name marks expectedQuestions');

    const summary = { scanned: sections.length, updated: 0 };

    for (const section of sections) {
      const marks = Number(section.marks) || 0;
      const expectedQuestions = Number(section.expectedQuestions) || 0;
      const derived = expectedQuestions > 0 ? Math.max(1, Math.round(marks / expectedQuestions)) : marks > 0 ? marks : 1;

      console.log(
        `[SECTION_MARKS_BACKFILL] section=${section._id} name="${section.name}" marks=${marks} expectedQuestions=${expectedQuestions} -> marksPerQuestion=${derived}`
      );

      if (!dryRun) {
        await Section.updateOne({ _id: section._id }, { $set: { marksPerQuestion: derived } });
      }
      summary.updated += 1;
    }

    console.log(
      `[SECTION_MARKS_BACKFILL] Summary scanned=${summary.scanned} updated=${summary.updated} dryRun=${dryRun}`
    );
  } finally {
    await disconnect();
  }
};

run().catch((error) => {
  console.error('[SECTION_MARKS_BACKFILL] Script failed:', error);
  process.exitCode = 1;
});
