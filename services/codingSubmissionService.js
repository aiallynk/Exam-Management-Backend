import Submission from '../models/Submission.js';
import { runJudge0Submission } from './judge0Service.js';
import { extractCodingFields, normalizeCodingLanguage } from '../utils/codingQuestions.js';

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeComparableOutput = (value) =>
  normalizeString(value)
    .replace(/\r/g, '')
    .trim()
    .replace(/\s+/g, ' ');

const resolveExecutionOutput = (execution = {}) =>
  normalizeString(
    execution.output ||
      execution.stdout ||
      execution.compileOutput ||
      execution.compile_output ||
      execution.stderr ||
      execution.error ||
      execution.message ||
      ''
  );

const normalizeCodeForComparison = (value) =>
  normalizeString(value)
    .replace(/\s+/g, '')
    .toLowerCase();

const buildBigrams = (value) => {
  const normalized = normalizeCodeForComparison(value);
  if (!normalized) return [];
  if (normalized.length < 2) return [normalized];

  const grams = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.push(normalized.slice(index, index + 2));
  }
  return grams;
};

const calculateSimilarityPercentage = (left, right) => {
  const leftCode = normalizeCodeForComparison(left);
  const rightCode = normalizeCodeForComparison(right);
  if (!leftCode || !rightCode) return 0;
  if (leftCode === rightCode) return 100;

  const leftBigrams = buildBigrams(leftCode);
  const rightBigrams = buildBigrams(rightCode);
  const rightBag = new Map();

  rightBigrams.forEach((gram) => {
    rightBag.set(gram, (rightBag.get(gram) || 0) + 1);
  });

  let matches = 0;
  leftBigrams.forEach((gram) => {
    const remaining = rightBag.get(gram) || 0;
    if (remaining > 0) {
      matches += 1;
      rightBag.set(gram, remaining - 1);
    }
  });

  const denominator = leftBigrams.length + rightBigrams.length;
  if (!denominator) return 0;

  return Number((((2 * matches) / denominator) * 100).toFixed(2));
};

const calculateTimeTakenSeconds = (attemptStartedAt) => {
  const startedAtMs = new Date(attemptStartedAt || 0).getTime();
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return 0;
  return Math.max(Math.floor((Date.now() - startedAtMs) / 1000), 0);
};

const findPlagiarismMatch = async ({ submissionId, examId, questionId, userId, code } = {}) => {
  if (!submissionId || !examId || !questionId || !userId || !normalizeString(code)) {
    return {
      flagged: false,
      similarity: 0,
      matchedSubmissionId: null,
      matchedUserId: null,
    };
  }

  const peers = await Submission.find({
    _id: { $ne: submissionId },
    examId,
    questionId,
    isDraft: false,
    userId: { $ne: userId },
  })
    .select('_id userId code')
    .lean();

  let bestMatch = {
    flagged: false,
    similarity: 0,
    matchedSubmissionId: null,
    matchedUserId: null,
  };

  peers.forEach((peer) => {
    const similarity = calculateSimilarityPercentage(code, peer?.code || '');
    if (similarity > bestMatch.similarity) {
      bestMatch = {
        flagged: similarity > 80,
        similarity,
        matchedSubmissionId: peer?._id || null,
        matchedUserId: peer?.userId || null,
      };
    }
  });

  return bestMatch;
};

export const parseCodingAnswerPayload = (value) => {
  if (!value && value !== 0) return {};

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  const raw = normalizeString(value);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const resolveCodingAnswerDraft = (rawValue, question = {}) => {
  const payload = parseCodingAnswerPayload(rawValue);
  const codingFields = extractCodingFields(question);
  const defaultLanguage = codingFields.languages[0] || 'python';
  const selectedLanguage = normalizeCodingLanguage(payload.language) || defaultLanguage;
  const drafts =
    payload.drafts && typeof payload.drafts === 'object' && !Array.isArray(payload.drafts)
      ? payload.drafts
      : payload.codeByLanguage && typeof payload.codeByLanguage === 'object' && !Array.isArray(payload.codeByLanguage)
        ? payload.codeByLanguage
        : {};
  const code =
    normalizeString(payload.code) ||
    normalizeString(drafts[selectedLanguage]) ||
    normalizeString(codingFields.starterCode?.[selectedLanguage]);

  return {
    language: selectedLanguage,
    code,
    input: normalizeString(payload.input),
    drafts,
  };
};

export const normalizeCodingAnswerForStorage = (value) => {
  const payload = parseCodingAnswerPayload(value);
  return JSON.stringify(payload && typeof payload === 'object' ? payload : {});
};

export const evaluateCodingQuestionSubmission = async ({
  question,
  code,
  language,
  input = '',
} = {}) => {
  if (!question) {
    throw new Error('Question is required for coding evaluation.');
  }

  const codingFields = extractCodingFields(question);
  const selectedLanguage = normalizeCodingLanguage(language) || codingFields.languages[0];
  if (!selectedLanguage || !codingFields.languages.includes(selectedLanguage)) {
    throw new Error('Selected language is not allowed for this question.');
  }

  const sourceCode = normalizeString(code);
  if (!sourceCode) {
    throw new Error('Code is required.');
  }

  if (!Array.isArray(codingFields.testCases) || codingFields.testCases.length === 0) {
    throw new Error('This coding question does not have test cases configured.');
  }

  const perCaseResults = [];
  let visibleCaseCount = 0;
  let hiddenCaseCount = 0;
  let executionTimeMs = 0;
  let maxMemoryKb = 0;

  for (const [index, testCase] of codingFields.testCases.entries()) {
    const execution = await runJudge0Submission({
      language: selectedLanguage,
      code: sourceCode,
      input: normalizeString(testCase.input),
      expectedOutput: normalizeString(testCase.expectedOutput),
      timeLimit: codingFields.timeLimit,
      memoryLimit: codingFields.memoryLimit,
    });

    const rawOutput = resolveExecutionOutput(execution);
    const actualOutput = normalizeComparableOutput(rawOutput);
    const expectedOutput = normalizeComparableOutput(testCase.expectedOutput);
    const passed = !execution.error && actualOutput === expectedOutput;
    const hidden = Boolean(testCase.hidden);

    if (hidden) {
      hiddenCaseCount += 1;
    } else {
      visibleCaseCount += 1;
    }

    const caseExecutionTimeMs = Math.max(Math.round((Number(execution.time) || 0) * 1000), 0);
    executionTimeMs += caseExecutionTimeMs;
    maxMemoryKb = Math.max(maxMemoryKb, Math.max(Number(execution.memory) || 0, 0));

    if (!passed) {
      console.log('[Coding Evaluation] Test case failed', {
        questionId: question?._id?.toString?.() || question?._id || null,
        testCaseIndex: index + 1,
        expected: expectedOutput,
        actual: actualOutput,
      });
    }

    perCaseResults.push({
      index,
      label: hidden ? `Hidden Test Case ${hiddenCaseCount}` : `Test Case ${visibleCaseCount}`,
      hidden,
      input: hidden ? '' : normalizeString(testCase.input),
      expectedOutput: hidden ? '' : normalizeString(testCase.expectedOutput),
      actualOutput: normalizeString(rawOutput),
      error: normalizeString(execution.error),
      passed,
      status: execution.status,
      time: Number(execution.time) || 0,
      executionTimeMs: caseExecutionTimeMs,
      memory: Number(execution.memory) || 0,
      isSample: Boolean(testCase.isSample) && !hidden,
    });
  }

  const total = perCaseResults.length;
  const passed = perCaseResults.filter((item) => item.passed).length;
  const failed = total - passed;
  const score = total > 0 ? Math.round((passed / total) * 100) : 0;
  const questionPoints = Number(question.points) || 0;
  const pointsEarned = Number(((questionPoints * score) / 100).toFixed(2));
  const lastCase = perCaseResults[perCaseResults.length - 1] || null;
  const details = perCaseResults.map((item, idx) => ({
    testCase: idx + 1,
    status: item.passed ? 'passed' : 'failed',
  }));

  return {
    total,
    passed,
    failed,
    details,
    score,
    pointsEarned,
    output: normalizeString(lastCase?.actualOutput),
    error: normalizeString(lastCase?.error),
    executionTimeMs,
    maxMemoryKb,
    result: {
      total,
      passed,
      failed,
      details,
      score,
      executionTimeMs,
      maxMemoryKb,
      testCases: perCaseResults,
    },
  };
};

export const saveCodingDraftRecord = async ({
  attemptId,
  userId,
  examId,
  questionId,
  code,
  language,
  input = '',
  attemptStartedAt,
} = {}) => {
  if (!attemptId || !userId || !examId || !questionId) {
    throw new Error('Attempt, user, exam, and question identifiers are required.');
  }

  const existingSubmission = await Submission.findOne({
    attemptId,
    questionId,
  });

  if (existingSubmission && existingSubmission.isDraft === false) {
    return Submission.findByIdAndUpdate(
      existingSubmission._id,
      {
        $set: {
          draftSavedAt: new Date(),
          timeTaken: calculateTimeTakenSeconds(attemptStartedAt),
          result: {
            ...(existingSubmission.result && typeof existingSubmission.result === 'object'
              ? existingSubmission.result
              : {}),
            draft: {
              code: normalizeString(code),
              language: normalizeCodingLanguage(language) || normalizeString(language).toLowerCase(),
              input: normalizeString(input),
              savedAt: new Date().toISOString(),
            },
          },
        },
      },
      {
        new: true,
      }
    );
  }

  return Submission.findOneAndUpdate(
    {
      attemptId,
      questionId,
    },
    {
      $set: {
        userId,
        examId,
        code: normalizeString(code),
        language: normalizeCodingLanguage(language) || normalizeString(language).toLowerCase(),
        isDraft: true,
        draftSavedAt: new Date(),
        timeTaken: calculateTimeTakenSeconds(attemptStartedAt),
        result: {
          ...(existingSubmission?.result && typeof existingSubmission.result === 'object'
            ? existingSubmission.result
            : {}),
          draft: {
            code: normalizeString(code),
            language: normalizeCodingLanguage(language) || normalizeString(language).toLowerCase(),
            input: normalizeString(input),
            savedAt: new Date().toISOString(),
          },
        },
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

export const saveCodingSubmissionRecord = async ({
  attemptId,
  userId,
  examId,
  questionId,
  code,
  language,
  evaluation,
  attemptStartedAt,
} = {}) => {
  if (!attemptId || !userId || !examId || !questionId) {
    throw new Error('Attempt, user, exam, and question identifiers are required.');
  }

  let submission = await Submission.findOneAndUpdate(
    {
      attemptId,
      questionId,
    },
    {
      $set: {
        userId,
        examId,
        code: normalizeString(code),
        language: normalizeCodingLanguage(language) || normalizeString(language).toLowerCase(),
        isDraft: false,
        draftSavedAt: new Date(),
        score: Number(evaluation?.score) || 0,
        result: evaluation?.result || {},
        output: normalizeString(evaluation?.output),
        error: normalizeString(evaluation?.error),
        total: Number(evaluation?.total) || 0,
        passed: Number(evaluation?.passed) || 0,
        failed: Number(evaluation?.failed) || 0,
        timeTaken: calculateTimeTakenSeconds(attemptStartedAt),
        executionTimeMs: Math.max(Number(evaluation?.executionTimeMs) || 0, 0),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );

  const plagiarism = await findPlagiarismMatch({
    submissionId: submission._id,
    examId,
    questionId,
    userId,
    code,
  });

  if (
    Boolean(submission?.plagiarism?.flagged) !== plagiarism.flagged ||
    Number(submission?.plagiarism?.similarity || 0) !== Number(plagiarism.similarity || 0) ||
    String(submission?.plagiarism?.matchedSubmissionId || '') !== String(plagiarism.matchedSubmissionId || '') ||
    String(submission?.plagiarism?.matchedUserId || '') !== String(plagiarism.matchedUserId || '')
  ) {
    submission = await Submission.findByIdAndUpdate(
      submission._id,
      {
        $set: {
          plagiarism,
        },
      },
      {
        new: true,
      }
    );
  }

  return submission;
};
