import Answer from '../models/Answer.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import WizKidsAttemptState from '../models/WizKidsAttemptState.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import { parseNumericAnswer } from '../utils/questionOptionSanitizer.js';
import { resolveTenantFeature } from './tenantFeatureService.js';

// WizKids completion deliberately stays outside the generic /exams/submit
// handler.  NUMBER and short-answer items are deterministic in WizKids; the
// generic handler treats those types as semantic and may invoke AI grading.
// This service finalizes only fully objective PRACTICE/SPEED attempts.
export class WizKidsCompletionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsCompletionError';
    this.status = status;
  }
}

const MODE_CAPABILITY = Object.freeze({ PRACTICE: 'WIZKIDS_PRACTICE', SPEED: 'WIZKIDS_SPEED_MODE' });
const DOMAIN_CAPABILITY = Object.freeze({
  MENTAL_MATHS: 'WIZKIDS_MENTAL_MATHS',
  VEDIC_MATHS: 'WIZKIDS_VEDIC_MATHS',
  SUPER_MATHS: 'WIZKIDS_SUPER_MATHS',
  LOGIC: 'WIZKIDS_LOGIC',
  OLYMPIAD: 'WIZKIDS_OLYMPIAD',
});
const OBJECTIVE_TYPES = new Set(['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'NUMBER', 'SHORT_ANSWER', 'FILL_IN_THE_BLANK', 'MATCHING']);
const normalizeText = (value) => String(value ?? '').trim().toLowerCase();

export const scoreWizKidsObjectiveAnswer = ({ question, answer }) => {
  if (!OBJECTIVE_TYPES.has(question?.questionType)) return { isCorrect: false, supported: false };
  if (question.questionType === 'NUMBER') {
    const expected = parseNumericAnswer(question.correctAnswer);
    const received = parseNumericAnswer(answer);
    return { supported: true, isCorrect: expected !== '' && received !== '' && Number(expected) === Number(received) };
  }
  if (question.questionType === 'MATCHING') {
    try {
      const expected = typeof question.correctAnswer === 'string' ? JSON.parse(question.correctAnswer) : question.correctAnswer;
      const received = typeof answer === 'string' ? JSON.parse(answer) : answer;
      return { supported: true, isCorrect: JSON.stringify(expected) === JSON.stringify(received) };
    } catch {
      return { supported: true, isCorrect: false };
    }
  }
  return { supported: true, isCorrect: normalizeText(question.correctAnswer) === normalizeText(answer) };
};

const assertCompletableAttempt = async ({ tenantId, userId, attemptId, expectedMode, expectedInteractionMode = 'STANDARD' }) => {
  const attempt = await ExamAttempt.findOne({ _id: attemptId, tenantId, userId }).lean();
  if (!attempt) throw new WizKidsCompletionError(404, 'Attempt not found.');
  if (attempt.isCompleted) return { attempt, alreadyCompleted: true };

  const [exam, config] = await Promise.all([
    Exam.findOne({ _id: attempt.examId, tenantId, productModule: 'WIZKIDS' }).select('_id productModule').lean(),
    WizKidsExamConfig.findOne({ tenantId, examId: attempt.examId }).select('mode domains interactionMode').lean(),
  ]);
  const expectedModes = Array.isArray(expectedMode) ? expectedMode : [expectedMode];
  if (!exam || !config || !expectedModes.includes(config.mode)) {
    throw new WizKidsCompletionError(403, `This completion endpoint is only available for WizKids ${expectedModes.join(', ')} attempts.`);
  }
  const expectedInteractionModes = Array.isArray(expectedInteractionMode) ? expectedInteractionMode : [expectedInteractionMode];
  if (!expectedInteractionModes.includes(String(config.interactionMode || 'STANDARD'))) {
    throw new WizKidsCompletionError(403, `This completion endpoint is only available for ${expectedInteractionModes.join(', ')} WizKids interactions.`);
  }
  const requiredCapabilities = new Set(['WIZKIDS']);
  if (MODE_CAPABILITY[config.mode]) requiredCapabilities.add(MODE_CAPABILITY[config.mode]);
  for (const domain of config.domains || []) {
    if (DOMAIN_CAPABILITY[domain]) requiredCapabilities.add(DOMAIN_CAPABILITY[domain]);
  }
  for (const capability of requiredCapabilities) {
    // eslint-disable-next-line no-await-in-loop
    const feature = await resolveTenantFeature(tenantId, capability);
    if (!feature?.effectiveEnabled) {
      throw new WizKidsCompletionError(403, `The ${capability} capability is not enabled for this tenant.`);
    }
  }
  if (config.mode === 'SPEED') {
    const state = await WizKidsAttemptState.findOne({ tenantId, attemptId, mode: 'SPEED' }).select('completedAt').lean();
    if (!state?.completedAt) throw new WizKidsCompletionError(409, 'Finish every Speed Mode question before completing the attempt.');
  }
  return { attempt, config, alreadyCompleted: false };
};

export const completeWizKidsObjectiveAttempt = async ({ tenantId, userId, attemptId, expectedMode, expectedInteractionMode = 'STANDARD', answers = null, now = new Date() }) => {
  const context = await assertCompletableAttempt({ tenantId, userId, attemptId, expectedMode, expectedInteractionMode });
  if (context.alreadyCompleted) return { attempt: context.attempt, alreadyCompleted: true };

  const questions = await Question.find({ questionPaperId: context.attempt.questionPaperId })
    .select('_id questionType correctAnswer points')
    .sort({ order: 1 })
    .lean();
  if (!questions.length) throw new WizKidsCompletionError(400, 'This WizKids attempt has no questions to complete.');
  const unsupported = questions.find((question) => !OBJECTIVE_TYPES.has(question.questionType));
  if (unsupported) {
    throw new WizKidsCompletionError(400, `Question type ${unsupported.questionType} cannot be deterministically completed in ${expectedMode} mode.`);
  }
  // The dedicated WizKids players save progress before completion.  Accepting
  // the same answer-map shape here is a defensive compatibility layer for a
  // direct call to the generic submit route, so that route can never fall
  // through to semantic/AI grading for a WizKids arithmetic test.
  if (answers && typeof answers === 'object') {
    const suppliedWrites = questions
      .filter((question) => Object.prototype.hasOwnProperty.call(answers, String(question._id)))
      .map((question) => {
        const raw = answers[String(question._id)];
        const answerText = question.questionType === 'MATCHING' && raw && typeof raw === 'object'
          ? JSON.stringify(raw)
          : String(raw ?? '');
        return {
          updateOne: {
            filter: { attemptId, questionId: question._id },
            update: {
              $set: { answerText, updatedAt: now },
              $setOnInsert: { attemptId, questionId: question._id, timeSpent: 0 },
            },
            upsert: true,
          },
        };
      });
    if (suppliedWrites.length) await Answer.bulkWrite(suppliedWrites, { ordered: false });
  }
  const answerDocs = await Answer.find({ attemptId, questionId: { $in: questions.map((question) => question._id) } })
    .select('_id questionId answerText timeSpent')
    .lean();
  const answerByQuestionId = new Map(answerDocs.map((answer) => [String(answer.questionId), answer]));
  let totalScore = 0;
  let maxScore = 0;
  const writes = questions.map((question) => {
    const existing = answerByQuestionId.get(String(question._id));
    const result = scoreWizKidsObjectiveAnswer({ question, answer: existing?.answerText || '' });
    const points = Number(question.points) || 0;
    maxScore += points;
    if (result.isCorrect) totalScore += points;
    return {
      updateOne: {
        filter: { attemptId, questionId: question._id },
        update: {
          $set: {
            answerText: existing?.answerText || '',
            isCorrect: result.isCorrect,
            pointsEarned: result.isCorrect ? points : 0,
            needsReview: false,
            evaluationStatus: 'AUTO_EVALUATED',
            finalScoreSource: 'RULE_ENGINE',
            updatedAt: now,
          },
          $setOnInsert: { attemptId, questionId: question._id, timeSpent: 0 },
        },
        upsert: true,
      },
    };
  });
  await Answer.bulkWrite(writes, { ordered: false });
  const percentage = maxScore ? Number(((totalScore / maxScore) * 100).toFixed(2)) : 0;
  const finalized = await ExamAttempt.findOneAndUpdate(
    { _id: attemptId, tenantId, userId, isCompleted: false },
    {
      $set: {
        isCompleted: true,
        submitTime: now,
        submittedAt: now,
        lastActivity: now,
        scoreSummary: { totalScore, maxScore, percentage, computedAt: now },
        submitMeta: { submissionSource: `wizkids_${context.config.mode.toLowerCase()}`, submittedAtClient: now },
      },
    },
    { new: true }
  ).lean();
  if (!finalized) {
    const existing = await ExamAttempt.findOne({ _id: attemptId, tenantId, userId }).lean();
    return { attempt: existing, alreadyCompleted: true };
  }
  return { attempt: finalized, alreadyCompleted: false, score: { totalScore, maxScore, percentage } };
};
