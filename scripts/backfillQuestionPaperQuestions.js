import { connect, disconnect } from '../utils/db.js';
import Exam from '../models/Exam.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import Section from '../models/Section.js';
import {
  queueExamPackageRegeneration,
  waitForExamPackageRegenerationDrain,
} from '../services/examPackageRegenerationService.js';

const parseArgs = (argv) => {
  const args = {
    dryRun: false,
    noRegenerate: false,
    examId: '',
    tenantId: '',
    timeoutMs: 10 * 60 * 1000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--no-regenerate') {
      args.noRegenerate = true;
      continue;
    }
    if (token === '--examId') {
      args.examId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--examId=')) {
      args.examId = token.split('=').slice(1).join('=').trim();
      continue;
    }
    if (token === '--tenantId') {
      args.tenantId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--tenantId=')) {
      args.tenantId = token.split('=').slice(1).join('=').trim();
      continue;
    }
    if (token === '--timeoutMs') {
      const parsed = Number.parseInt(String(argv[i + 1] || '').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.timeoutMs = parsed;
      }
      i += 1;
      continue;
    }
    if (token.startsWith('--timeoutMs=')) {
      const parsed = Number.parseInt(token.split('=').slice(1).join('=').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.timeoutMs = parsed;
      }
    }
  }

  return args;
};

const stringifyId = (value) => String(value || '').trim();

const buildStarterQuestion = ({ questionPaper, sectionId, nextOrder }) => {
  const setName = String(questionPaper?.setName || 'Question Paper').trim();
  return {
    questionPaperId: questionPaper._id,
    questionText: `Starter question for ${setName}.`,
    questionType: 'MULTIPLE_CHOICE',
    questionFormat: 'MCQ',
    options: ['Option A', 'Option B', 'Option C', 'Option D'],
    correctAnswer: 'Option A',
    points: 1,
    order: Number.isFinite(Number(nextOrder)) ? Number(nextOrder) : 0,
    ...(sectionId ? { sectionId } : {}),
  };
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const shouldRegenerate = !args.noRegenerate && !args.dryRun;

  await connect();

  try {
    const questionPaperFilter = { isActive: true };
    if (args.examId) {
      questionPaperFilter.examId = args.examId;
    }

    const questionPapers = await QuestionPaper.find(questionPaperFilter)
      .select('_id examId setName createdBy')
      .sort({ createdAt: 1 });

    const summary = {
      scanned: 0,
      filteredByTenant: 0,
      skippedMissingExam: 0,
      skippedMissingTenant: 0,
      alreadyHasQuestions: 0,
      inserted: 0,
      failedInserts: 0,
      affectedExams: 0,
    };

    const examCache = new Map();
    const regenerationOwners = new Map();

    for (const questionPaper of questionPapers) {
      summary.scanned += 1;
      const examId = stringifyId(questionPaper.examId);
      if (!examId) {
        summary.skippedMissingExam += 1;
        continue;
      }

      let exam = examCache.get(examId);
      if (!exam) {
        exam = await Exam.findById(examId).select('_id tenantId createdBy title');
        examCache.set(examId, exam || null);
      }

      if (!exam?._id) {
        summary.skippedMissingExam += 1;
        console.warn(
          `[QUESTION_BACKFILL] Skipping question paper ${questionPaper._id}: exam ${examId} not found`
        );
        continue;
      }

      const examTenantId = stringifyId(exam.tenantId);
      if (!examTenantId) {
        summary.skippedMissingTenant += 1;
        console.warn(
          `[QUESTION_BACKFILL] Skipping question paper ${questionPaper._id}: exam ${examId} has no tenantId`
        );
        continue;
      }

      if (args.tenantId && examTenantId !== args.tenantId) {
        summary.filteredByTenant += 1;
        continue;
      }

      const questionCount = await Question.countDocuments({
        questionPaperId: questionPaper._id,
      });

      console.log(
        `[QUESTION_BACKFILL] questionPaper=${questionPaper._id} set="${questionPaper.setName}" exam=${examId} tenant=${examTenantId} questionCount=${questionCount}`
      );

      if (questionCount > 0) {
        summary.alreadyHasQuestions += 1;
        continue;
      }

      const firstActiveSection = await Section.findOne({
        questionPaperId: questionPaper._id,
        isActive: true,
      })
        .sort({ order: 1 })
        .select('_id');

      const maxOrderQuestion = await Question.findOne({
        questionPaperId: questionPaper._id,
      })
        .sort({ order: -1 })
        .select('order')
        .lean();

      const nextOrder = Number(maxOrderQuestion?.order ?? -1) + 1;
      const questionPayload = buildStarterQuestion({
        questionPaper,
        sectionId: firstActiveSection?._id || null,
        nextOrder,
      });

      if (args.dryRun) {
        console.log(
          `[QUESTION_BACKFILL][DRY_RUN] Would insert starter question for questionPaper=${questionPaper._id} section=${stringifyId(firstActiveSection?._id) || 'none'}`
        );
        summary.inserted += 1;
      } else {
        try {
          const insertedQuestion = await Question.create(questionPayload);
          summary.inserted += 1;
          console.log(
            `[QUESTION_BACKFILL] Inserted question ${insertedQuestion._id} for questionPaper=${questionPaper._id}`
          );

          const ownerUserId =
            stringifyId(questionPaper.createdBy) || stringifyId(exam.createdBy);
          if (ownerUserId) {
            regenerationOwners.set(examId, ownerUserId);
          }
        } catch (error) {
          summary.failedInserts += 1;
          console.error(
            `[QUESTION_BACKFILL] Failed insert for questionPaper=${questionPaper._id}: ${error.message}`
          );
        }
      }
    }

    summary.affectedExams = regenerationOwners.size;

    if (shouldRegenerate && regenerationOwners.size > 0) {
      let queued = 0;
      let skipped = 0;

      for (const [examId, userId] of regenerationOwners.entries()) {
        const result = queueExamPackageRegeneration({
          examId,
          userId,
          reason: 'QUESTION_PAPER_QUESTION_BACKFILL',
          forceRegenerate: true,
        });
        if (result.queued) {
          queued += 1;
        } else {
          skipped += 1;
        }
      }

      console.log(
        `[QUESTION_BACKFILL] Regeneration queued queued=${queued} skipped=${skipped}`
      );

      const drain = await waitForExamPackageRegenerationDrain({
        timeoutMs: args.timeoutMs,
        pollIntervalMs: 250,
      });
      console.log(
        `[QUESTION_BACKFILL] Regeneration drain status drained=${drain.drained} inFlight=${drain.inFlight} pending=${drain.pending}`
      );
      if (!drain.drained) {
        process.exitCode = 1;
      }
    }

    console.log(
      `[QUESTION_BACKFILL] Summary scanned=${summary.scanned} filteredByTenant=${summary.filteredByTenant} skippedMissingExam=${summary.skippedMissingExam} skippedMissingTenant=${summary.skippedMissingTenant} alreadyHasQuestions=${summary.alreadyHasQuestions} inserted=${summary.inserted} failedInserts=${summary.failedInserts} affectedExams=${summary.affectedExams} dryRun=${args.dryRun}`
    );
  } finally {
    await disconnect();
  }
};

run().catch((error) => {
  console.error('[QUESTION_BACKFILL] Script failed:', error);
  process.exitCode = 1;
});
