import { parseNumericAnswer } from '../utils/questionOptionSanitizer.js';
import Question from '../models/Question.js';
import Answer from '../models/Answer.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Exam from '../models/Exam.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import WizKidsPracticeCheck from '../models/WizKidsPracticeCheck.js';
import { resolveTenantFeature } from './tenantFeatureService.js';

// WizKids Phase 7 — Practice Mode.
//
// answer -> check -> feedback -> explanation -> next question (master
// prompt §30). This is deliberately NOT the standard exam-grading engine
// (the objective rule-engine embedded in routes/attempts.js's submit
// handler, which additionally handles negative marking, partial-credit
// modes, and per-option weighting — none of which Practice Mode needs;
// Practice needs a simple right/wrong + explanation). Reuses
// parseNumericAnswer, the one existing, exported numeric-text-parsing
// utility, for NUMBER questions rather than reimplementing that parsing.
//
// Normal exam attempts must never gain pre-submit answer disclosure (master
// prompt §30) — enforced by the three-part gate in checkPracticeAnswer():
// the attempt's exam must have productModule='WIZKIDS' AND its
// WizKidsExamConfig.mode must be 'PRACTICE' AND the tenant's
// WIZKIDS_PRACTICE capability must be effectively enabled. A standard exam
// attempt fails the very first check (no productModule='WIZKIDS' exam
// behind it) and is rejected before any question/answer data is even
// loaded.
export class WizKidsPracticeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsPracticeError';
    this.status = status;
  }
}

// Instant right/wrong feedback is only meaningful for objective question
// types with a single unambiguous correct value — subjective (ESSAY*,
// PARAGRAPH) and CODING questions go through the standard AI/human/judge0
// evaluation workflow instead, never this path.
export const PRACTICE_SUPPORTED_QUESTION_TYPES = Object.freeze([
  'MULTIPLE_CHOICE',
  'NUMBER',
  'SHORT_ANSWER',
  'FILL_IN_THE_BLANK',
  'MATCHING',
]);

const normalizeComparableText = (value) => String(value ?? '').trim().toLowerCase();

// Pure correctness function — no I/O, directly unit-testable. Returns
// true/false for a supported type, or null for a type Practice Mode does
// not (yet) support instant feedback for.
export const checkAnswerCorrectness = (question, submittedAnswer) => {
  const type = question?.questionType;

  if (type === 'NUMBER') {
    const expected = parseNumericAnswer(question.correctAnswer);
    const actual = parseNumericAnswer(submittedAnswer);
    if (expected === '' || actual === '') return false;
    return Number(expected) === Number(actual);
  }

  if (type === 'MULTIPLE_CHOICE' || type === 'SHORT_ANSWER' || type === 'FILL_IN_THE_BLANK') {
    return normalizeComparableText(question.correctAnswer) === normalizeComparableText(submittedAnswer);
  }

  if (type === 'MATCHING') {
    // Question.correctAnswer is stored as a JSON string for MATCHING
    // (see stringifyCorrectAnswerForQuestion in wizKidsQuestionBankService.js).
    try {
      const expectedPairs = JSON.parse(question.correctAnswer);
      const actualPairs = typeof submittedAnswer === 'string' ? JSON.parse(submittedAnswer) : submittedAnswer;
      return JSON.stringify(expectedPairs) === JSON.stringify(actualPairs);
    } catch {
      return false;
    }
  }

  return null;
};

// Pure decision function — no I/O, directly unit-testable. This is what
// turns master prompt §54 Phase 7's critical security test ("Standard exams
// must never successfully access or invoke the Practice answer-checking
// behavior") into an automated, provable guarantee rather than a manual QA
// claim: feed it a STANDARD-module exam and it is structurally impossible
// for the result to be `allowed: true`, regardless of what config or
// capability state is also passed in.
export const evaluatePracticeModeGate = ({ exam, config, practiceFeatureEnabled }) => {
  if (!exam || exam.productModule !== 'WIZKIDS') {
    return { allowed: false, reason: 'Practice answer-checking is only available for WizKids exams.' };
  }
  if (!config || config.mode !== 'PRACTICE') {
    return { allowed: false, reason: 'Practice answer-checking is only available in Practice mode.' };
  }
  if (!practiceFeatureEnabled) {
    return { allowed: false, reason: 'The WIZKIDS_PRACTICE capability is not enabled for this tenant.' };
  }
  return { allowed: true, reason: '' };
};

const assertPracticeModeAvailable = async ({ tenantId, examId }) => {
  const exam = await Exam.findOne({ _id: examId, tenantId }).select('productModule').lean();
  // Short-circuit before any further DB round trip when the exam is not
  // even WizKids — a standard exam attempt is rejected immediately, before
  // any question or answer content is touched.
  const config =
    exam?.productModule === 'WIZKIDS'
      ? await WizKidsExamConfig.findOne({ tenantId, examId }).select('mode').lean()
      : null;
  const feature =
    exam?.productModule === 'WIZKIDS' && config?.mode === 'PRACTICE'
      ? await resolveTenantFeature(tenantId, 'WIZKIDS_PRACTICE')
      : null;

  const gate = evaluatePracticeModeGate({
    exam,
    config,
    practiceFeatureEnabled: feature?.effectiveEnabled === true,
  });
  if (!gate.allowed) {
    throw new WizKidsPracticeError(403, gate.reason);
  }
};

export const checkPracticeAnswer = async ({ tenantId, userId, attemptId, questionId, submittedAnswer }) => {
  // Ownership + tenant scope built into the query itself — a candidate can
  // only check answers against their own attempt (master prompt §57).
  const attempt = await ExamAttempt.findOne({ _id: attemptId, tenantId, userId }).lean();
  if (!attempt) throw new WizKidsPracticeError(404, 'Attempt not found.');
  if (attempt.isCompleted) {
    throw new WizKidsPracticeError(400, 'This attempt has already been submitted.');
  }

  await assertPracticeModeAvailable({ tenantId, examId: attempt.examId });

  const question = await Question.findOne({ _id: questionId, questionPaperId: attempt.questionPaperId }).lean();
  if (!question) throw new WizKidsPracticeError(404, 'Question not found in this attempt.');
  if (!PRACTICE_SUPPORTED_QUESTION_TYPES.includes(question.questionType)) {
    throw new WizKidsPracticeError(400, `Instant feedback is not available for question type ${question.questionType}.`);
  }

  const isCorrect = checkAnswerCorrectness(question, submittedAnswer);
  const explanation = question.evaluationConfig?.wizKidsExplanation || '';

  // Practice is still an ExamAttempt. Persist the most recent answer through
  // the existing canonical Answer collection so a completed practice attempt
  // can reuse normal result/analytics infrastructure; the append-only check
  // collection below retains every retry and feedback event.
  const normalizedAnswer =
    question.questionType === 'MATCHING' && typeof submittedAnswer === 'object'
      ? JSON.stringify(submittedAnswer)
      : String(submittedAnswer ?? '');
  await Answer.updateOne(
    { attemptId, questionId },
    {
      $set: {
        answerText: normalizedAnswer,
        isCorrect,
        pointsEarned: isCorrect ? Number(question.points) || 0 : 0,
        needsReview: false,
        updatedAt: new Date(),
      },
      $setOnInsert: { attemptId, questionId },
    },
    { upsert: true }
  );

  const check = await WizKidsPracticeCheck.create({
    tenantId,
    attemptId,
    examId: attempt.examId,
    questionId,
    userId,
    submittedAnswer,
    isCorrect,
    explanation,
  });

  return {
    isCorrect,
    correctAnswer: question.correctAnswer,
    explanation,
    solution: question.evaluationConfig?.wizKidsSolution || '',
    checkId: check._id,
  };
};

export const getAttemptPracticeHistory = async ({ tenantId, userId, attemptId }) => {
  const attempt = await ExamAttempt.findOne({ _id: attemptId, tenantId, userId }).select('_id').lean();
  if (!attempt) throw new WizKidsPracticeError(404, 'Attempt not found.');

  return WizKidsPracticeCheck.find({ tenantId, attemptId }).sort({ checkedAt: -1 }).lean();
};
