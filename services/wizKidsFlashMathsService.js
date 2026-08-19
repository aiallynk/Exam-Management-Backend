import Answer from '../models/Answer.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import WizKidsFlashRound from '../models/WizKidsFlashRound.js';
import WizKidsFlashAttemptState from '../models/WizKidsFlashAttemptState.js';
import { createSeededRandom } from './wizKidsQuestionGeneratorService.js';
import { scoreWizKidsObjectiveAnswer, completeWizKidsObjectiveAttempt } from './wizKidsCompletionService.js';

export class WizKidsFlashMathsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsFlashMathsError';
    this.status = status;
  }
}

const randomInteger = (random, min, max) => Math.floor(random() * (max - min + 1)) + min;
const digitRange = (minimumDigits, maximumDigits) => ({
  minimum: minimumDigits === 1 ? 1 : 10 ** (minimumDigits - 1),
  maximum: 10 ** maximumDigits - 1,
});

export const generateFlashSequence = ({ config, seed }) => {
  const random = createSeededRandom(`FLASH_MATHS|${config.configVersion}|${seed}`);
  const range = digitRange(config.minimumDigits, config.maximumDigits);
  const operands = [randomInteger(random, range.minimum, range.maximum)];
  const operators = [];
  let total = operands[0];

  for (let index = 1; index < config.operandCount; index += 1) {
    let operator = config.operationMode === 'SUBTRACTION'
      ? '-'
      : config.operationMode === 'ADD_SUB_MIXED' && random() >= 0.5 ? '-' : '+';
    let operand;
    if (operator === '-' && config.negativeIntermediateAllowed !== true) {
      const maximumSafeOperand = Math.min(range.maximum, total);
      if (maximumSafeOperand < range.minimum) {
        operator = '+';
        operand = randomInteger(random, range.minimum, range.maximum);
      } else {
        operand = randomInteger(random, range.minimum, maximumSafeOperand);
      }
    } else {
      operand = randomInteger(random, range.minimum, range.maximum);
    }
    total = operator === '-' ? total - operand : total + operand;
    operators.push(operator);
    operands.push(operand);
  }

  return { operands, operators, answer: total };
};

const loadFlashExam = async ({ tenantId, examId }) => {
  const [exam, config] = await Promise.all([
    Exam.findOne({ _id: examId, tenantId, productModule: 'WIZKIDS' }).lean(),
    WizKidsExamConfig.findOne({ tenantId, examId }).lean(),
  ]);
  if (!exam || !config || config.interactionMode !== 'FLASH_MATHS') {
    throw new WizKidsFlashMathsError(403, 'This exam is not configured for Flash Maths.');
  }
  return { exam, config };
};

const fingerprintFlashSequence = (entry) => `${(entry.operands || []).join(',')}|${(entry.operators || []).join(',')}`;
const MAX_FLASH_SEQUENCE_RETRIES = 5;

export const createFlashRounds = async ({ tenantId, examId, questionPaperId, count, seedBase, createdBy }) => {
  const { exam, config } = await loadFlashExam({ tenantId, examId });
  const paper = await QuestionPaper.findOne({ _id: questionPaperId, examId: exam._id, isActive: true }).lean();
  if (!paper) throw new WizKidsFlashMathsError(404, 'Question paper not found for this Junior Exam.');
  const existingCount = await Question.countDocuments({ questionPaperId });
  const existingRounds = await WizKidsFlashRound.find({ questionPaperId }).select('operands operators').lean();
  const seenFingerprints = new Set(existingRounds.map(fingerprintFlashSequence));
  const created = [];
  for (let index = 0; index < count; index += 1) {
    let seed = `${seedBase}:${existingCount + index + 1}`;
    let generated = generateFlashSequence({ config: config.flashMaths, seed });
    // Guarantee (best-effort) that no two rounds in the same paper share an identical sequence:
    // retry with a bumped seed suffix a bounded number of times, then accept a rare residual
    // collision rather than fail the whole generation request.
    for (let retry = 1; retry < MAX_FLASH_SEQUENCE_RETRIES && seenFingerprints.has(fingerprintFlashSequence(generated)); retry += 1) {
      seed = `${seedBase}:${existingCount + index + 1}:retry${retry}`;
      generated = generateFlashSequence({ config: config.flashMaths, seed });
    }
    seenFingerprints.add(fingerprintFlashSequence(generated));
    // eslint-disable-next-line no-await-in-loop
    const question = await Question.create({
      questionPaperId,
      questionText: `Flash Maths Round ${existingCount + index + 1}`,
      questionType: 'NUMBER',
      correctAnswer: String(generated.answer),
      points: 1,
      order: existingCount + index,
      evaluationConfig: { flashMaths: { configVersion: config.flashMaths.configVersion } },
    });
    // eslint-disable-next-line no-await-in-loop
    const round = await WizKidsFlashRound.create({
      tenantId,
      examId,
      questionPaperId,
      questionId: question._id,
      configVersion: config.flashMaths.configVersion,
      seed,
      difficulty: config.flashMaths.difficulty,
      operationMode: config.flashMaths.operationMode,
      operands: generated.operands,
      operators: generated.operators,
      flashDurationMs: config.flashMaths.flashDurationMs,
      gapDurationMs: config.flashMaths.gapDurationMs,
      answerWindowMs: config.flashMaths.answerWindowMs,
      createdBy,
    });
    created.push({ question, roundId: round._id });
  }
  return created;
};

const loadAttemptContext = async ({ tenantId, userId, attemptId }) => {
  const attempt = await ExamAttempt.findOne({ _id: attemptId, tenantId, userId }).lean();
  if (!attempt) throw new WizKidsFlashMathsError(404, 'Attempt not found.');
  if (attempt.isCompleted) throw new WizKidsFlashMathsError(409, 'This attempt is already complete.');
  const { config } = await loadFlashExam({ tenantId, examId: attempt.examId });
  const rounds = await WizKidsFlashRound.find({ tenantId, examId: attempt.examId, questionPaperId: attempt.questionPaperId })
    .populate('questionId', '_id order points')
    .lean();
  rounds.sort((left, right) => Number(left.questionId?.order || 0) - Number(right.questionId?.order || 0));
  if (!rounds.length) throw new WizKidsFlashMathsError(400, 'This Flash Maths exam has no rounds.');
  return { attempt, config, rounds };
};

const findRound = (rounds, questionId) => rounds.find((round) => String(round.questionId?._id || round.questionId) === String(questionId));

export const buildCandidateFlashState = ({ state, rounds, config, now = new Date() }) => {
  const current = findRound(rounds, state.currentQuestionId);
  const completedCount = state.submittedQuestionIds.length;
  if (!current) {
    return { completed: true, progress: { completed: completedCount, total: rounds.length } };
  }
  const currentQuestionId = current.questionId._id;
  // Once the active round has been answered, hold here (do not compute reveal/answer timing for
  // it again) until the candidate explicitly advances via advanceFlashRound — this is what
  // enforces "no auto-next" for Flash Maths in both Practice and Test mode.
  const alreadyAnswered = (state.submittedQuestionIds || []).some((id) => String(id) === String(currentQuestionId));
  if (alreadyAnswered) {
    const timing = [...(state.roundTimings || [])].reverse().find((entry) => String(entry.questionId) === String(currentQuestionId));
    return {
      completed: false,
      phase: 'ANSWERED',
      round: {
        questionId: currentQuestionId,
        currentItem: null,
        operandCount: current.operands.length,
      },
      feedback: timing ? { isCorrect: timing.isCorrect === true, timedOut: timing.timedOut === true } : null,
      progress: { completed: completedCount, total: rounds.length },
      isLastRound: completedCount >= rounds.length,
      assessmentPurpose: config.mode,
    };
  }
  const startedAt = new Date(state.roundStartedAt);
  const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
  const revealCycleMs = current.flashDurationMs + current.gapDurationMs;
  const revealIndex = Math.min(current.operands.length - 1, Math.floor(elapsedMs / revealCycleMs));
  const cycleElapsedMs = elapsedMs % revealCycleMs;
  const showingValue = cycleElapsedMs < current.flashDurationMs;
  const answerOpensAt = new Date(startedAt.getTime() + current.operands.length * revealCycleMs);
  const answerClosesAt = new Date(answerOpensAt.getTime() + current.answerWindowMs);
  const answerOpen = now >= answerOpensAt;
  const item = answerOpen || !showingValue ? null : {
    value: current.operands[revealIndex],
    operator: revealIndex === 0 ? null : current.operators[revealIndex - 1],
    index: revealIndex,
  };
  return {
    completed: false,
    phase: answerOpen ? 'ANSWER' : 'REVEAL',
    round: {
      questionId: currentQuestionId,
      currentItem: item,
      operandCount: current.operands.length,
      flashDurationMs: current.flashDurationMs,
      gapDurationMs: current.gapDurationMs,
      answerOpensAt,
      answerClosesAt,
    },
    progress: { completed: completedCount, total: rounds.length },
    assessmentPurpose: config.mode,
  };
};

export const getOrStartFlashAttempt = async ({ tenantId, userId, attemptId, now = new Date() }) => {
  const context = await loadAttemptContext({ tenantId, userId, attemptId });
  const firstQuestionId = context.rounds[0].questionId._id;
  const state = await WizKidsFlashAttemptState.findOneAndUpdate(
    { tenantId, attemptId },
    { $setOnInsert: { examId: context.attempt.examId, currentQuestionId: firstQuestionId, roundStartedAt: now, startedAt: now } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return buildCandidateFlashState({ state: state.toObject(), rounds: context.rounds, config: context.config, now });
};

export const isFlashQuestionSubmitted = (state, questionId) =>
  (state?.submittedQuestionIds || []).some((id) => String(id) === String(questionId));

export const submitFlashAnswer = async ({ tenantId, userId, attemptId, questionId, answer, now = new Date() }) => {
  const context = await loadAttemptContext({ tenantId, userId, attemptId });
  const state = await WizKidsFlashAttemptState.findOne({ tenantId, attemptId });
  if (!state) throw new WizKidsFlashMathsError(409, 'Start the Flash Maths attempt before answering.');
  if (isFlashQuestionSubmitted(state, questionId)) {
    return { duplicate: true, ...buildCandidateFlashState({ state: state.toObject(), rounds: context.rounds, config: context.config, now }) };
  }
  if (String(state.currentQuestionId) !== String(questionId)) {
    throw new WizKidsFlashMathsError(409, 'This is not the active Flash Maths round.');
  }
  const round = findRound(context.rounds, questionId);
  if (!round) throw new WizKidsFlashMathsError(404, 'Flash Maths round not found.');
  const answerOpenedAt = new Date(new Date(state.roundStartedAt).getTime() + round.operands.length * (round.flashDurationMs + round.gapDurationMs));
  if (now < answerOpenedAt) throw new WizKidsFlashMathsError(409, 'The answer window is not open yet.');
  const answerClosesAt = new Date(answerOpenedAt.getTime() + round.answerWindowMs);
  const timedOut = now > answerClosesAt;
  const question = await Question.findOne({ _id: questionId, questionPaperId: context.attempt.questionPaperId }).lean();
  if (!question) throw new WizKidsFlashMathsError(404, 'Question not found.');
  const submittedAnswer = timedOut ? '' : String(answer ?? '');
  const score = scoreWizKidsObjectiveAnswer({ question, answer: submittedAnswer });
  const responseTimeMs = Math.max(0, Math.min(round.answerWindowMs, now.getTime() - answerOpenedAt.getTime()));
  const persistedAnswer = await Answer.findOneAndUpdate(
    { attemptId, questionId },
    { $setOnInsert: { answerText: submittedAnswer, isCorrect: score.isCorrect, pointsEarned: score.isCorrect ? Number(question.points || 0) : 0, timeSpent: Math.ceil(responseTimeMs / 1000), needsReview: false, evaluationStatus: 'AUTO_EVALUATED', finalScoreSource: 'RULE_ENGINE' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // Record the answer only. Advancing to the next round (or completing the attempt) is a
  // separate, explicit step — see advanceFlashRound — so the candidate always sees this round's
  // feedback and must click "Next" themselves, in both Practice and Test mode.
  const updatedState = await WizKidsFlashAttemptState.findOneAndUpdate(
    { _id: state._id, tenantId, currentQuestionId: questionId, submittedQuestionIds: { $ne: questionId } },
    {
      $push: {
        submittedQuestionIds: questionId,
        roundTimings: { questionId, startedAt: state.roundStartedAt, answerOpenedAt, submittedAt: now, responseTimeMs: Math.max(0, Number(persistedAnswer.timeSpent || 0) * 1000), isCorrect: persistedAnswer.isCorrect === true, timedOut },
      },
    },
    { new: true }
  );
  if (!updatedState) {
    const latestState = await WizKidsFlashAttemptState.findOne({ tenantId, attemptId });
    return { duplicate: true, ...buildCandidateFlashState({ state: latestState.toObject(), rounds: context.rounds, config: context.config, now }) };
  }
  return buildCandidateFlashState({ state: updatedState.toObject(), rounds: context.rounds, config: context.config, now });
};

export const advanceFlashRound = async ({ tenantId, userId, attemptId, now = new Date() }) => {
  const context = await loadAttemptContext({ tenantId, userId, attemptId });
  const state = await WizKidsFlashAttemptState.findOne({ tenantId, attemptId });
  if (!state) throw new WizKidsFlashMathsError(409, 'Start the Flash Maths attempt before advancing.');
  const currentQuestionId = state.currentQuestionId;
  if (!currentQuestionId) {
    // Already fully advanced (attempt is complete) — return current state rather than erroring,
    // so a repeated/late "Next" click is harmless.
    return buildCandidateFlashState({ state: state.toObject(), rounds: context.rounds, config: context.config, now });
  }
  const isAnswered = (state.submittedQuestionIds || []).some((id) => String(id) === String(currentQuestionId));
  if (!isAnswered) {
    throw new WizKidsFlashMathsError(409, 'Answer the current Flash Maths round before moving on.');
  }
  const currentIndex = context.rounds.findIndex((entry) => String(entry.questionId._id) === String(currentQuestionId));
  const nextRound = context.rounds[currentIndex + 1] || null;
  const updatedState = await WizKidsFlashAttemptState.findOneAndUpdate(
    { _id: state._id, tenantId, currentQuestionId },
    {
      $set: {
        currentQuestionId: nextRound?.questionId?._id || null,
        roundStartedAt: nextRound ? now : null,
        ...(!nextRound ? { completedAt: now } : {}),
      },
    },
    { new: true }
  );
  const finalState = updatedState || (await WizKidsFlashAttemptState.findOne({ tenantId, attemptId }));
  return buildCandidateFlashState({ state: finalState.toObject(), rounds: context.rounds, config: context.config, now });
};

export const completeFlashAttempt = async ({ tenantId, userId, attemptId, now = new Date() }) => {
  const state = await WizKidsFlashAttemptState.findOne({ tenantId, attemptId }).lean();
  if (!state?.completedAt) throw new WizKidsFlashMathsError(409, 'Complete every Flash Maths round first.');
  return completeWizKidsObjectiveAttempt({ tenantId, userId, attemptId, expectedMode: ['TEST', 'PRACTICE'], expectedInteractionMode: 'FLASH_MATHS', now });
};
