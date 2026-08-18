import Answer from '../models/Answer.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import WizKidsAttemptState from '../models/WizKidsAttemptState.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import { sanitizeQuestionOptions } from '../utils/questionOptionSanitizer.js';
import { resolveTenantFeature } from './tenantFeatureService.js';

// WizKids Phase 8 — Speed Mode.
//
// Core ExamAttempt/Answer data continues to own the assessment itself.  This
// service owns only the runtime state that Standard Xamigo does not need:
// current-question timing, locks, and Speed navigation policy.
export class WizKidsSpeedError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsSpeedError';
    this.status = status;
  }
}

export const SPEED_MODE = 'SPEED';

export const evaluateSpeedModeGate = ({ exam, config, speedFeatureEnabled }) => {
  if (!exam || exam.productModule !== 'WIZKIDS') {
    return { allowed: false, reason: 'Speed Mode is only available for WizKids exams.' };
  }
  if (!config || config.mode !== SPEED_MODE) {
    return { allowed: false, reason: 'This WizKids exam is not configured for Speed Mode.' };
  }
  if (!speedFeatureEnabled) {
    return { allowed: false, reason: 'The WIZKIDS_SPEED_MODE capability is not enabled for this tenant.' };
  }
  return { allowed: true, reason: '' };
};

export const elapsedSeconds = (startedAt, now = new Date()) => {
  const startedAtMs = new Date(startedAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
};

export const recordedDurationSeconds = ({ startedAt, now = new Date(), questionTimerSeconds = null }) => {
  const elapsed = elapsedSeconds(startedAt, now);
  const limit = Number(questionTimerSeconds);
  return Number.isFinite(limit) && limit > 0 ? Math.min(elapsed, limit) : elapsed;
};

export const findNextUnlockedQuestionId = ({ questions, lockedQuestionIds, afterQuestionId = null }) => {
  const locked = new Set((lockedQuestionIds || []).map((id) => String(id)));
  const ordered = [...(questions || [])].sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  const afterIndex = afterQuestionId
    ? ordered.findIndex((question) => String(question._id) === String(afterQuestionId))
    : -1;
  const candidates = afterIndex >= 0 ? [...ordered.slice(afterIndex + 1), ...ordered.slice(0, afterIndex + 1)] : ordered;
  const next = candidates.find((question) => !locked.has(String(question._id)));
  return next?._id || null;
};

export const remainingQuestionSeconds = ({ questionStartedAt, questionTimerSeconds, now = new Date() }) => {
  const limit = Number(questionTimerSeconds);
  if (!Number.isFinite(limit) || limit <= 0 || !questionStartedAt) return null;
  return Math.max(0, limit - elapsedSeconds(questionStartedAt, now));
};

const normalizeSpeedAnswer = (questionType, value) => {
  if (value === undefined || value === null) return '';
  if (questionType === 'MATCHING' && typeof value === 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
};

const isLocked = (state, questionId) =>
  (state.lockedQuestionIds || []).some((id) => String(id) === String(questionId));

const getAttemptContext = async ({ tenantId, userId, attemptId }) => {
  const attempt = await ExamAttempt.findOne({ _id: attemptId, tenantId, userId }).lean();
  if (!attempt) throw new WizKidsSpeedError(404, 'Attempt not found.');
  if (attempt.isCompleted) throw new WizKidsSpeedError(400, 'This attempt has already been submitted.');

  const [exam, config] = await Promise.all([
    Exam.findOne({ _id: attempt.examId, tenantId }).select('productModule').lean(),
    WizKidsExamConfig.findOne({ tenantId, examId: attempt.examId }).select('mode autoAdvance allowBackNavigation questionTimerSeconds').lean(),
  ]);
  const feature =
    exam?.productModule === 'WIZKIDS' && config?.mode === SPEED_MODE
      ? await resolveTenantFeature(tenantId, 'WIZKIDS_SPEED_MODE')
      : null;
  const gate = evaluateSpeedModeGate({
    exam,
    config,
    speedFeatureEnabled: feature?.effectiveEnabled === true,
  });
  if (!gate.allowed) throw new WizKidsSpeedError(403, gate.reason);

  const questions = await Question.find({ questionPaperId: attempt.questionPaperId })
    .select('_id order questionText questionType questionFormat options matchingPairs imageUrl points sectionId')
    .sort({ order: 1, createdAt: 1 })
    .lean();
  if (!questions.length) throw new WizKidsSpeedError(400, 'A Speed Mode exam needs at least one question before it can start.');

  return { attempt, config, questions };
};

const candidateQuestion = (question) => {
  if (!question) return null;
  const sourcePairs = question.questionType === 'MATCHING' && Array.isArray(question.matchingPairs)
    ? question.matchingPairs
    : [];
  const matchingChoices = sourcePairs
    .map((pair) => pair?.right || pair?.match || pair?.answer || '')
    .filter(Boolean);
  return {
    _id: question._id,
    order: question.order,
    questionText: question.questionText,
    questionType: question.questionType,
    questionFormat: question.questionFormat,
    options: question.questionType === 'MATCHING' ? matchingChoices : sanitizeQuestionOptions(question.options),
    matchingPairs: question.questionType === 'MATCHING'
      ? sourcePairs.map((pair) => ({ left: pair?.left || pair?.term || pair?.prompt || '' }))
      : undefined,
    imageUrl: question.imageUrl || '',
    points: question.points,
    sectionId: question.sectionId || null,
  };
};

const completeCurrentQuestion = ({ state, now, outcome, lock = true }) => {
  if (!state.currentQuestionId || !state.questionStartedAt) return;
  const durationSeconds = recordedDurationSeconds({
    startedAt: state.questionStartedAt,
    now,
    questionTimerSeconds: state.questionTimerSeconds,
  });
  state.questionTimings.push({
    questionId: state.currentQuestionId,
    startedAt: state.questionStartedAt,
    endedAt: now,
    durationSeconds,
    outcome,
  });
  if (lock && !isLocked(state, state.currentQuestionId)) {
    state.lockedQuestionIds.push(state.currentQuestionId);
  }
  state.questionStartedAt = null;
};

const moveToNextQuestion = ({ state, questions, now, afterQuestionId = null }) => {
  const nextQuestionId = findNextUnlockedQuestionId({
    questions,
    lockedQuestionIds: state.lockedQuestionIds,
    afterQuestionId: afterQuestionId || state.currentQuestionId,
  });
  state.currentQuestionId = nextQuestionId;
  state.questionStartedAt = nextQuestionId ? now : null;
  if (!nextQuestionId) state.completedAt = now;
  return nextQuestionId;
};

const reconcileExpiredQuestionTimer = ({ state, questions, now }) => {
  const remaining = remainingQuestionSeconds({
    questionStartedAt: state.questionStartedAt,
    questionTimerSeconds: state.questionTimerSeconds,
    now,
  });
  if (remaining === null || remaining > 0 || !state.currentQuestionId || isLocked(state, state.currentQuestionId)) {
    return false;
  }

  const timedOutQuestionId = state.currentQuestionId;
  completeCurrentQuestion({ state, now, outcome: 'TIMED_OUT' });
  if (state.autoAdvance) {
    moveToNextQuestion({ state, questions, now, afterQuestionId: timedOutQuestionId });
  } else {
    state.currentQuestionId = null;
  }
  return true;
};

const toSpeedPayload = ({ state, questions, now = new Date() }) => {
  const currentQuestion = questions.find((question) => String(question._id) === String(state.currentQuestionId));
  return {
    state: {
      attemptId: state.attemptId,
      examId: state.examId,
      mode: state.mode,
      currentQuestionId: state.currentQuestionId,
      questionStartedAt: state.questionStartedAt,
      lockedQuestionIds: state.lockedQuestionIds,
      autoAdvance: state.autoAdvance,
      allowBackNavigation: state.allowBackNavigation,
      questionTimerSeconds: state.questionTimerSeconds,
      questionTimings: state.questionTimings,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      remainingQuestionSeconds: remainingQuestionSeconds({
        questionStartedAt: state.questionStartedAt,
        questionTimerSeconds: state.questionTimerSeconds,
        now,
      }),
      requiresAdvance: !state.completedAt && !state.currentQuestionId,
    },
    progress: {
      totalQuestions: questions.length,
      completedQuestions: state.lockedQuestionIds.length,
    },
    question: candidateQuestion(currentQuestion),
  };
};

const loadState = async ({ tenantId, attemptId }) =>
  WizKidsAttemptState.findOne({ tenantId, attemptId });

export const startSpeedAttempt = async ({ tenantId, userId, attemptId, now = new Date() }) => {
  const { attempt, config, questions } = await getAttemptContext({ tenantId, userId, attemptId });
  let state = await loadState({ tenantId, attemptId });

  if (!state) {
    const firstQuestionId = findNextUnlockedQuestionId({ questions, lockedQuestionIds: [] });
    try {
      state = await WizKidsAttemptState.create({
        tenantId,
        attemptId: attempt._id,
        examId: attempt.examId,
        mode: SPEED_MODE,
        currentQuestionId: firstQuestionId,
        questionStartedAt: now,
        autoAdvance: config.autoAdvance !== false,
        allowBackNavigation: config.allowBackNavigation === true,
        questionTimerSeconds: config.questionTimerSeconds || null,
        startedAt: now,
      });
    } catch (error) {
      // The unique attempt index makes two concurrent start clicks safe.  The
      // second request simply returns the state created by the first one.
      if (error?.code !== 11000) throw error;
      state = await loadState({ tenantId, attemptId });
    }
  }

  reconcileExpiredQuestionTimer({ state, questions, now });
  await state.save();
  return toSpeedPayload({ state, questions, now });
};

export const getSpeedAttemptState = async ({ tenantId, userId, attemptId, now = new Date() }) => {
  const { questions } = await getAttemptContext({ tenantId, userId, attemptId });
  const state = await loadState({ tenantId, attemptId });
  if (!state) throw new WizKidsSpeedError(404, 'Speed Mode has not been started for this attempt.');

  const changed = reconcileExpiredQuestionTimer({ state, questions, now });
  if (changed) await state.save();
  return toSpeedPayload({ state, questions, now });
};

export const submitSpeedAnswer = async ({ tenantId, userId, attemptId, questionId, submittedAnswer, now = new Date() }) => {
  const { attempt, questions } = await getAttemptContext({ tenantId, userId, attemptId });
  const state = await loadState({ tenantId, attemptId });
  if (!state) throw new WizKidsSpeedError(409, 'Start Speed Mode before submitting an answer.');

  const expired = reconcileExpiredQuestionTimer({ state, questions, now });
  if (expired) {
    await state.save();
    throw new WizKidsSpeedError(409, 'Time expired for the current question. Continue with the next question.');
  }
  if (state.completedAt) throw new WizKidsSpeedError(400, 'All Speed Mode questions are already complete.');
  if (!state.currentQuestionId || String(state.currentQuestionId) !== String(questionId)) {
    throw new WizKidsSpeedError(409, 'Answers can only be submitted for the active Speed Mode question.');
  }
  if (isLocked(state, questionId)) {
    throw new WizKidsSpeedError(409, 'This Speed Mode question is locked.');
  }

  const question = questions.find((item) => String(item._id) === String(questionId));
  if (!question) throw new WizKidsSpeedError(404, 'Question not found in this attempt.');

  const durationSeconds = recordedDurationSeconds({
    startedAt: state.questionStartedAt,
    now,
    questionTimerSeconds: state.questionTimerSeconds,
  });
  await Answer.updateOne(
    { attemptId: attempt._id, questionId },
    {
      $set: {
        answerText: normalizeSpeedAnswer(question.questionType, submittedAnswer),
        timeSpent: durationSeconds,
        pointsEarned: 0,
        aiEvaluation: null,
        needsReview: false,
        updatedAt: now,
      },
      $unset: { isCorrect: '' },
      $setOnInsert: { attemptId: attempt._id, questionId },
    },
    { upsert: true }
  );

  const answeredQuestionId = state.currentQuestionId;
  completeCurrentQuestion({ state, now, outcome: 'ANSWERED' });
  if (state.autoAdvance) {
    moveToNextQuestion({ state, questions, now, afterQuestionId: answeredQuestionId });
  } else {
    state.currentQuestionId = null;
  }
  await state.save();

  return {
    ...toSpeedPayload({ state, questions, now }),
    answer: { questionId, timeSpent: durationSeconds },
  };
};

export const advanceSpeedAttempt = async ({ tenantId, userId, attemptId, now = new Date() }) => {
  const { questions } = await getAttemptContext({ tenantId, userId, attemptId });
  const state = await loadState({ tenantId, attemptId });
  if (!state) throw new WizKidsSpeedError(409, 'Start Speed Mode before advancing.');

  reconcileExpiredQuestionTimer({ state, questions, now });
  if (state.completedAt) {
    await state.save();
    return toSpeedPayload({ state, questions, now });
  }
  if (state.autoAdvance) {
    throw new WizKidsSpeedError(400, 'This Speed Mode exam advances automatically after each answer.');
  }
  if (state.currentQuestionId && !isLocked(state, state.currentQuestionId)) {
    throw new WizKidsSpeedError(409, 'Answer the current question or wait for its timer before advancing.');
  }

  moveToNextQuestion({ state, questions, now });
  await state.save();
  return toSpeedPayload({ state, questions, now });
};

export const navigateSpeedAttempt = async ({ tenantId, userId, attemptId, questionId, now = new Date() }) => {
  const { questions } = await getAttemptContext({ tenantId, userId, attemptId });
  const state = await loadState({ tenantId, attemptId });
  if (!state) throw new WizKidsSpeedError(409, 'Start Speed Mode before navigating.');

  reconcileExpiredQuestionTimer({ state, questions, now });
  if (!state.allowBackNavigation) {
    await state.save();
    throw new WizKidsSpeedError(403, 'Back navigation is disabled for this Speed Mode exam.');
  }
  if (state.completedAt) {
    await state.save();
    throw new WizKidsSpeedError(400, 'All Speed Mode questions are already complete.');
  }
  const targetQuestion = questions.find((question) => String(question._id) === String(questionId));
  if (!targetQuestion) throw new WizKidsSpeedError(404, 'Question not found in this attempt.');
  if (isLocked(state, questionId)) throw new WizKidsSpeedError(409, 'This Speed Mode question is locked.');

  if (state.currentQuestionId && String(state.currentQuestionId) !== String(questionId) && !isLocked(state, state.currentQuestionId)) {
    completeCurrentQuestion({ state, now, outcome: 'SKIPPED', lock: false });
  }
  state.currentQuestionId = targetQuestion._id;
  state.questionStartedAt = now;
  await state.save();
  return toSpeedPayload({ state, questions, now });
};
