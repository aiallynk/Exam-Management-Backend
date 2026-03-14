import Answer from '../models/Answer.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import {
  evaluateCodingQuestionSubmission,
  normalizeCodingAnswerForStorage,
  parseCodingAnswerPayload,
  saveCodingDraftRecord,
  saveCodingSubmissionRecord,
} from '../services/codingSubmissionService.js';
import { resolveJudge0LanguageId, runJudge0Submission } from '../services/judge0Service.js';
import { extractCodingFields, normalizeCodingLanguage } from '../utils/codingQuestions.js';

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

export const runCode = async (req, res, next) => {
  try {
    const { language, code, input = '', questionId, timeLimit, memoryLimit } = req.body || {};
    const rawLanguage = normalizeString(language);
    const sourceCode = normalizeString(code);
    if (!sourceCode || !rawLanguage) {
      return res.status(400).json({
        success: false,
        message: 'Code and language are required',
      });
    }
    const selectedLanguage = normalizeCodingLanguage(rawLanguage);
    if (!selectedLanguage) {
      return res.status(400).json({
        success: false,
        message: 'Unsupported language',
      });
    }

    let evaluationQuestion = null;
    let executionTimeLimit = timeLimit;
    let executionMemoryLimit = memoryLimit;

    if (questionId) {
      evaluationQuestion = await Question.findById(questionId);
      if (!evaluationQuestion) {
        return res.status(404).json({ error: 'Question not found.' });
      }
      if (evaluationQuestion.questionType === 'CODING') {
        const codingFields = extractCodingFields(evaluationQuestion);
        if (
          codingFields.languages.length &&
          !codingFields.languages.includes(selectedLanguage)
        ) {
          return res.status(400).json({ error: 'Selected language is not allowed for this question.' });
        }
      }
    }

    let languageId = null;
    try {
      languageId = await resolveJudge0LanguageId(selectedLanguage);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'Unsupported language',
      });
    }

    const execution = await runJudge0Submission({
      language: selectedLanguage,
      languageId,
      code: sourceCode,
      input,
      timeLimit: executionTimeLimit,
      memoryLimit: executionMemoryLimit,
    });

    return res.json({
      output: execution.output,
      error: execution.error || null,
      status: execution.status,
      time: execution.time,
      memory: execution.memory,
    });
  } catch (error) {
    console.error('Compiler error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Code execution failed',
    });
  }
};

export const autosaveCode = async (req, res, next) => {
  try {
    const { attemptId, questionId, code, language, input = '' } = req.body || {};
    if (!attemptId || !questionId) {
      return res.status(400).json({ error: 'Attempt ID and question ID are required.' });
    }

    const attempt = await ExamAttempt.findById(attemptId);
    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found.' });
    }

    if (attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden - You can only autosave code for your own attempt.' });
    }

    if (attempt.isCompleted) {
      return res.status(400).json({ error: 'Attempt already submitted.' });
    }

    const question = await Question.findOne({
      _id: questionId,
      questionPaperId: attempt.questionPaperId,
    });
    if (!question) {
      return res.status(404).json({ error: 'Coding question not found for this attempt.' });
    }
    if (question.questionType !== 'CODING') {
      return res.status(400).json({ error: 'This question is not a coding question.' });
    }

    const selectedLanguage = normalizeCodingLanguage(language);
    const codingFields = extractCodingFields(question);
    if (selectedLanguage && codingFields.languages.length && !codingFields.languages.includes(selectedLanguage)) {
      return res.status(400).json({ error: 'Selected language is not allowed for this question.' });
    }

    const normalizedCode = normalizeString(code);
    const normalizedInput = normalizeString(input);

    const submission = await saveCodingDraftRecord({
      attemptId: attempt._id,
      userId: req.user._id,
      examId: attempt.examId,
      questionId: question._id,
      code: normalizedCode,
      language: selectedLanguage || codingFields.languages[0],
      input: normalizedInput,
      attemptStartedAt: attempt.startTime,
    });

    const existingAnswerPayload = parseCodingAnswerPayload(
      (await Answer.findOne({ attemptId: attempt._id, questionId: question._id }).select('answerText'))?.answerText
    );
    const answerPayload = {
      ...existingAnswerPayload,
      input: normalizedInput,
      language: selectedLanguage || existingAnswerPayload.language || codingFields.languages[0],
      code: normalizedCode,
      drafts: {
        ...(existingAnswerPayload.drafts && typeof existingAnswerPayload.drafts === 'object'
          ? existingAnswerPayload.drafts
          : {}),
        [selectedLanguage || existingAnswerPayload.language || codingFields.languages[0]]: normalizedCode,
      },
    };

    await Answer.findOneAndUpdate(
      { attemptId: attempt._id, questionId: question._id },
      {
        $set: {
          answerText: normalizeCodingAnswerForStorage(answerPayload),
          submissionId: submission._id,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          attemptId: attempt._id,
          questionId: question._id,
        },
      },
      {
        upsert: true,
      }
    );

    return res.json({
      saved: true,
      savedAt: submission?.draftSavedAt || submission?.updatedAt || new Date().toISOString(),
      submissionId: submission?._id || null,
    });
  } catch (error) {
    next(error);
  }
};

export const submitCode = async (req, res, next) => {
  try {
    const { attemptId, questionId, code, language, input = '' } = req.body || {};
    if (!attemptId || !questionId) {
      return res.status(400).json({ error: 'Attempt ID and question ID are required.' });
    }

    const attempt = await ExamAttempt.findById(attemptId);
    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found.' });
    }

    if (attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden - You can only submit code for your own attempt.' });
    }

    if (attempt.isCompleted) {
      return res.status(400).json({ error: 'Attempt already submitted.' });
    }

    const question = await Question.findOne({
      _id: questionId,
      questionPaperId: attempt.questionPaperId,
    });
    if (!question) {
      return res.status(404).json({ error: 'Coding question not found for this attempt.' });
    }
    if (question.questionType !== 'CODING') {
      return res.status(400).json({ error: 'This question is not a coding question.' });
    }

    const evaluation = await evaluateCodingQuestionSubmission({
      question,
      code,
      language,
      input,
    });

    const submission = await saveCodingSubmissionRecord({
      attemptId: attempt._id,
      userId: req.user._id,
      examId: attempt.examId,
      questionId: question._id,
      code,
      language,
      evaluation,
      attemptStartedAt: attempt.startTime,
    });

    const existingAnswerPayload = parseCodingAnswerPayload(
      (await Answer.findOne({ attemptId: attempt._id, questionId: question._id }).select('answerText'))?.answerText
    );

    const answerPayload = {
      ...existingAnswerPayload,
      input: normalizeString(input),
      language,
      code: normalizeString(code),
      lastSubmission: {
        score: evaluation.score,
        passed: evaluation.passed,
        failed: evaluation.failed,
        plagiarism: submission?.plagiarism || {
          flagged: false,
          similarity: 0,
        },
      },
    };

    await Answer.findOneAndUpdate(
      { attemptId: attempt._id, questionId: question._id },
      {
        $set: {
          answerText: normalizeCodingAnswerForStorage(answerPayload),
          isCorrect: evaluation.failed === 0 && evaluation.total > 0,
          pointsEarned: evaluation.pointsEarned,
          aiEvaluation: {
            type: 'CODING',
            score: evaluation.score,
            passed: evaluation.passed,
            failed: evaluation.failed,
            plagiarism: submission?.plagiarism || {
              flagged: false,
              similarity: 0,
            },
          },
          codingResult: evaluation.result,
          submissionId: submission._id,
          needsReview: false,
        },
        $setOnInsert: {
          attemptId: attempt._id,
          questionId: question._id,
        },
      },
      {
        upsert: true,
      }
    );

    return res.json({
      total: evaluation.total,
      passed: evaluation.passed,
      failed: evaluation.failed,
      score: evaluation.score,
      pointsEarned: evaluation.pointsEarned,
      output: evaluation.output,
      error: evaluation.error || null,
      result: evaluation.result,
      submissionId: submission._id,
      plagiarism: submission?.plagiarism || {
        flagged: false,
        similarity: 0,
      },
      executionTimeMs: evaluation.executionTimeMs,
    });
  } catch (error) {
    next(error);
  }
};
