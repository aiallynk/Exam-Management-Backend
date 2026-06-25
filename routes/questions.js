import express from 'express';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Exam from '../models/Exam.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { checkQuestionLimit } from '../middleware/planLimits.js';
import { isFreePlan } from '../config/planLimits.js';
import { sendPlanRestriction, validateFreePlanQuestionPayload, resolveExamPlanContext } from '../middleware/planRestrictions.js';
import { body, validationResult } from 'express-validator';
import { parseCSV, validateQuestionCSV } from '../utils/csv.js';
import { syncExamQuestionCount } from '../utils/planUsage.js';
import {
  normalizeQuestionCorrectAnswer,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';
import {
  ensureQuestionImageAvailability,
  ensureQuestionsImageAvailability,
} from '../services/questionImportImageService.js';
import {
  normalizeQuestionFormat,
  normalizeQuestionTypeForStorage,
} from '../utils/questionTypes.js';
import { trackAIUsageEvent } from '../services/aiTokenUsageService.js';
import {
  extractCodingFields,
  hasCodingConfiguration,
} from '../utils/codingQuestions.js';
import { queueExamPackageRegeneration } from '../services/examPackageRegenerationService.js';

const router = express.Router();

const queueExamPackageRegenerationForContentChange = async ({
  examId,
  userId,
  reason,
  questionPaperId,
}) => {
  try {
    const exam = await Exam.findById(examId).select('_id examType');
    if (!exam?._id || exam.examType === 'OMR') {
      return;
    }

    queueExamPackageRegeneration({
      examId: exam._id,
      userId,
      reason,
      forceRegenerate: true,
      questionPaperIds: questionPaperId ? [questionPaperId] : null,
    });
  } catch (error) {
    console.error(
      `[Package Regeneration] Failed to enqueue for exam ${examId}:`,
      error?.message || error
    );
  }
};

const prepareImportedQuestionCount = (req, res, next) => {
  try {
    const importSourceType = String(req.body?.importSourceType || '').trim().toUpperCase();
    const skipExamQuestionLimitForCsv = importSourceType === 'CSV';
    const importedQuestions = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (importedQuestions) {
      const flattenedImportedQuestions = flattenQuestionPayloadList(importedQuestions);
      req.planLimitContext = {
        ...(req.planLimitContext || {}),
        parsedImportedQuestions: flattenedImportedQuestions,
        questionsToAdd: flattenedImportedQuestions.length,
        skipExamQuestionLimit: skipExamQuestionLimitForCsv,
      };
      return next();
    }

    const csvContent = req.body?.csvContent;
    if (typeof csvContent !== 'string' || !csvContent.trim()) {
      return res.status(400).json({
        error: 'Questions or CSV content and question paper ID are required',
      });
    }

    const records = parseCSV(csvContent);
    req.planLimitContext = {
      ...(req.planLimitContext || {}),
      parsedCsvRecords: records,
      questionsToAdd: records.length,
      skipExamQuestionLimit: true,
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

const prepareCreateQuestionCount = (req, res, next) => {
  try {
    const isContextGroupPayload = isContextQuestionGroupPayload(req.body || {});
    const expandedCreateQuestions = flattenQuestionPayloadList([req.body || {}]);
    req.planLimitContext = {
      ...(req.planLimitContext || {}),
      expandedCreateQuestions,
      questionsToAdd: isContextGroupPayload ? expandedCreateQuestions.length : 1,
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

const normalizeCorrectAnswerForStorage = (questionType, value, options = []) => {
  const normalizedQuestionType = typeof questionType === 'string' ? questionType.trim().toUpperCase() : '';
  const normalizedOptions = sanitizeQuestionOptions(options);
  const normalizedAnswer = normalizeQuestionCorrectAnswer({
    questionType: normalizedQuestionType,
    correctAnswer: value,
    options: normalizedOptions,
  });

  if (normalizedQuestionType === 'MULTIPLE_OPTIONS') {
    return Array.isArray(normalizedAnswer) && normalizedAnswer.length ? JSON.stringify(normalizedAnswer) : '';
  }

  if (normalizedAnswer === undefined || normalizedAnswer === null) {
    return '';
  }
  return normalizedAnswer;
};

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeQuestionTypeAlias = (value) => {
  const normalized = normalizeString(value).toUpperCase();
  if (normalized === 'CODE') return 'CODING';
  return normalized;
};

const normalizeQuestionFormatAlias = (value) => {
  const normalized = normalizeString(value).toUpperCase();
  if (normalized === 'CODE') return 'CODING';
  if (normalized === 'SHORT_ANSWER' || normalized === 'SHORT ANSWER') return '';
  return normalized;
};

const parseOptionsInput = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return raw.split(/[,;|\n]/).map((item) => item.trim()).filter(Boolean);
  }
};

const normalizeImportQuestionTypeToken = (value) => {
  const normalized = normalizeQuestionTypeAlias(value);
  if (['MULTI_SELECT_MCQ', 'MULTI_SELECT', 'MULTISELECT'].includes(normalized)) {
    return 'MULTIPLE_OPTIONS';
  }
  if (normalized === 'MCQ' || normalized === 'IMAGE_BASED') return 'MULTIPLE_CHOICE';
  if (normalized === 'CODE') return 'CODING';
  return normalized;
};

const normalizeImportQuestionFormatToken = (value) => {
  const normalized = normalizeQuestionFormatAlias(value);
  if (normalized === 'IMAGE_BASED') return 'IMAGE';
  return normalized;
};

const resolveImportRecordValueByAliases = (record, aliases = []) => {
  if (!record || typeof record !== 'object') return undefined;
  const keys = Object.keys(record);
  const directLookup = keys.reduce((acc, key) => {
    const lowered = normalizeString(key).toLowerCase();
    if (lowered && !acc[lowered]) acc[lowered] = key;
    return acc;
  }, {});
  const normalizedLookup = keys.reduce((acc, key) => {
    const normalized = normalizeString(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized && !acc[normalized]) acc[normalized] = key;
    return acc;
  }, {});

  for (const alias of aliases) {
    const loweredAlias = normalizeString(alias).toLowerCase();
    const directKey = directLookup[loweredAlias];
    if (directKey && record[directKey] !== undefined && record[directKey] !== null) {
      return record[directKey];
    }

    const normalizedAlias = normalizeString(alias).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedKey = normalizedLookup[normalizedAlias];
    if (normalizedKey && record[normalizedKey] !== undefined && record[normalizedKey] !== null) {
      return record[normalizedKey];
    }
  }

  return undefined;
};

const normalizeImportedOptionsForImport = (value) => {
  if (Array.isArray(value)) {
    return sanitizeQuestionOptions(value);
  }

  if (value && typeof value === 'object') {
    const options = [];
    const pushOption = (candidate) => {
      if (candidate === undefined || candidate === null) return;
      if (Array.isArray(candidate)) {
        candidate.forEach((entry) => {
          const normalized = normalizeString(entry);
          if (normalized) options.push(normalized);
        });
        return;
      }
      const normalized = normalizeString(candidate);
      if (!normalized) return;
      options.push(normalized);
    };

    Object.entries(value).forEach(([key, candidate]) => {
      const normalizedKey = normalizeString(key).toLowerCase().replace(/[^a-z0-9]/g, '');
      const isOptionKey =
        normalizedKey === 'options' ||
        normalizedKey === 'choices' ||
        normalizedKey.startsWith('option') ||
        normalizedKey.startsWith('choice') ||
        ['a', 'b', 'c', 'd', 'e', 'f', 'opt1', 'opt2', 'opt3', 'opt4', 'opt5', 'opt6'].includes(normalizedKey);

      if (!isOptionKey) return;

      if (normalizedKey === 'options' || normalizedKey === 'choices') {
        const parsedOptions = parseOptionsInput(candidate);
        if (Array.isArray(parsedOptions)) {
          parsedOptions.forEach((entry) => pushOption(entry));
        } else {
          pushOption(candidate);
        }
        return;
      }

      pushOption(candidate);
    });

    return sanitizeQuestionOptions(options);
  }

  const parsedOptions = parseOptionsInput(value);
  return Array.isArray(parsedOptions) ? sanitizeQuestionOptions(parsedOptions) : [];
};

const mapImportAnswerTokenToOption = (token, options = []) => {
  const normalizedToken = normalizeString(token);
  if (!normalizedToken) return '';

  const upperToken = normalizedToken.toUpperCase();
  if (/^[A-Z]$/.test(upperToken)) {
    const optionIndex = upperToken.charCodeAt(0) - 65;
    if (optionIndex >= 0 && optionIndex < options.length) {
      return options[optionIndex];
    }
  }

  if (/^\d+$/.test(normalizedToken)) {
    const optionIndex = Number(normalizedToken) - 1;
    if (optionIndex >= 0 && optionIndex < options.length) {
      return options[optionIndex];
    }
  }

  const matchedOption = options.find(
    (option) => normalizeString(option).toLowerCase() === normalizedToken.toLowerCase()
  );
  return matchedOption || normalizedToken;
};

const normalizeImportedCorrectAnswerForImport = ({
  questionType,
  correctAnswer,
  options = [],
}) => {
  const normalizedQuestionType = normalizeString(questionType).toUpperCase();
  const safeOptions = Array.isArray(options) ? sanitizeQuestionOptions(options) : [];

  if (normalizedQuestionType === 'TRUE_FALSE') {
    const normalized = normalizeString(correctAnswer).toLowerCase();
    return normalized.startsWith('f') ? 'False' : 'True';
  }

  if (normalizedQuestionType === 'MULTIPLE_OPTIONS') {
    const tokens = Array.isArray(correctAnswer)
      ? correctAnswer
      : (() => {
          const normalized = normalizeString(correctAnswer);
          if (!normalized) return [];
          try {
            const parsed = JSON.parse(normalized);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // Fall through to split-based parsing.
          }
          return normalized
            .split(/[,;|\n]/)
            .map((item) => item.trim())
            .filter(Boolean);
        })();

    return Array.from(
      new Set(tokens.map((token) => mapImportAnswerTokenToOption(token, safeOptions)).filter(Boolean))
    );
  }

  return mapImportAnswerTokenToOption(correctAnswer, safeOptions);
};

const prepareImportedQuestionRecordForInsert = (record = {}, index = 0) => {
  const questionText = normalizeString(
    resolveImportRecordValueByAliases(record, ['questionText', 'question', 'prompt', 'title', 'q']) ||
      record.questionText ||
      record.question ||
      record.title
  );
  const rawQuestionFormat =
    resolveImportRecordValueByAliases(record, [
      'questionFormat',
      'question_type',
      'question type',
      'questionType',
      'type',
    ]) ||
    record.questionFormat ||
    record.question_type ||
    record.type;
  const questionFormat =
    normalizeImportQuestionFormatToken(rawQuestionFormat) ||
    normalizeQuestionFormat(record) ||
    'MCQ';
  const options = normalizeImportedOptionsForImport(record);
  const rawCorrectAnswer =
    resolveImportRecordValueByAliases(record, [
      'correctAnswer',
      'correct_answer',
      'correct answer',
      'answer',
      'answers',
      'correct',
    ]) ??
    record.correctAnswer ??
    record.correct_answer ??
    '';
  const rawPoints =
    resolveImportRecordValueByAliases(record, ['points', 'marks', 'score', 'max_marks']) ??
    record.points ??
    record.max_marks;
  const normalizedQuestionType = normalizeQuestionTypeForStorage({
    ...record,
    questionText,
    questionType: normalizeImportQuestionTypeToken(
      resolveImportRecordValueByAliases(record, ['questionType', 'question_type', 'question type', 'type']) ||
        record.questionType ||
        record.type
    ),
    questionFormat,
    question_type: questionFormat,
    options,
    correctAnswer: rawCorrectAnswer,
  });
  const questionType = normalizeImportQuestionTypeToken(normalizedQuestionType) || 'SHORT_ANSWER';
  const normalizedCorrectAnswer = normalizeImportedCorrectAnswerForImport({
    questionType,
    correctAnswer: rawCorrectAnswer,
    options,
  });
  const parsedPoints = Number(rawPoints);
  const points = Number.isFinite(parsedPoints) && parsedPoints > 0 ? parsedPoints : 1;

  return {
    ...record,
    questionText,
    questionType,
    questionFormat,
    question_type: questionFormat,
    options,
    correctAnswer: normalizedCorrectAnswer,
    points,
    max_marks: points,
    order: Number.isFinite(Number(record.order)) ? Number(record.order) : index,
  };
};

const validatePreparedImportQuestion = (record = {}) => {
  const validationErrors = [];
  const questionText = normalizeString(record.questionText);
  const questionType = normalizeString(record.questionType).toUpperCase();
  const options = Array.isArray(record.options) ? sanitizeQuestionOptions(record.options) : [];

  if (!questionText) {
    validationErrors.push('Question text is required');
  }

  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS'].includes(questionType) && options.length < 2) {
    validationErrors.push('At least two options are required');
  }

  if (questionType === 'TRUE_FALSE') {
    const normalizedAnswer = normalizeString(record.correctAnswer);
    if (!['True', 'False'].includes(normalizedAnswer)) {
      validationErrors.push('Correct answer must be True or False');
    }
  }

  if (questionType === 'MULTIPLE_OPTIONS') {
    const normalizedAnswers = normalizeQuestionCorrectAnswer({
      questionType: 'MULTIPLE_OPTIONS',
      correctAnswer: record.correctAnswer,
      options,
    });
    if (!Array.isArray(normalizedAnswers) || normalizedAnswers.length === 0) {
      validationErrors.push('At least one correct answer is required');
    }
  }

  if (questionType === 'MULTIPLE_CHOICE' && !normalizeString(record.correctAnswer)) {
    validationErrors.push('Correct answer is required');
  }

  return validationErrors;
};

const CONTEXT_GROUP_FORMATS = new Set(['PARAGRAPH', 'SCENARIO']);

const createContextGroupId = (format = 'paragraph') =>
  `${normalizeString(format).toLowerCase() || 'paragraph'}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const resolveContextQuestionFormat = (payload = {}) => {
  const explicitFormat = normalizeQuestionFormatAlias(
    payload.questionFormat || payload.question_type || payload.type
  );
  if (CONTEXT_GROUP_FORMATS.has(explicitFormat)) {
    return explicitFormat;
  }

  const explicitType = normalizeQuestionTypeAlias(payload.questionType || payload.type);
  if (explicitType === 'PARAGRAPH') {
    return explicitFormat === 'SCENARIO' ? 'SCENARIO' : 'PARAGRAPH';
  }

  const inferredFormat = normalizeQuestionFormat(payload);
  return CONTEXT_GROUP_FORMATS.has(inferredFormat) ? inferredFormat : '';
};

const isContextQuestionGroupPayload = (payload = {}) =>
  Array.isArray(payload?.questions) && CONTEXT_GROUP_FORMATS.has(resolveContextQuestionFormat(payload));

const expandContextQuestionGroupPayload = (payload = {}, options = {}) => {
  const { baseOrder = 0 } = options;

  if (!isContextQuestionGroupPayload(payload)) {
    return [payload];
  }

  const format = resolveContextQuestionFormat(payload) || 'PARAGRAPH';
  const safeSubQuestions = Array.isArray(payload.questions)
    ? payload.questions.filter((item) => item && typeof item === 'object')
    : [];
  const sharedPassage = normalizeString(
    payload.passage || payload.context || payload.scenario || payload.paragraph
  );
  const sharedGroupId =
    normalizeString(payload.paragraphGroupId || payload.paragraph_group_id) || createContextGroupId(format);
  const inheritedType = normalizeQuestionTypeAlias(payload.questionType || payload.type);
  const inheritedPoints = payload.points ?? payload.max_marks;

  return safeSubQuestions.map((subQuestion, index) => {
    const expanded = {
      ...payload,
      ...subQuestion,
      questionText: normalizeString(
        subQuestion.questionText ||
          subQuestion.question ||
          subQuestion.prompt ||
          subQuestion.title ||
          payload.questionText ||
          payload.question ||
          payload.title
      ),
      question:
        subQuestion.question ||
        subQuestion.questionText ||
        payload.question ||
        payload.questionText ||
        '',
      questionType: normalizeQuestionTypeAlias(
        subQuestion.questionType || subQuestion.type || inheritedType
      ),
      type: normalizeQuestionTypeAlias(subQuestion.type || subQuestion.questionType || inheritedType),
      questionFormat: format,
      question_type: format,
      options:
        parseOptionsInput(subQuestion.options) ??
        parseOptionsInput(payload.options) ??
        subQuestion.options ??
        payload.options,
      correctAnswer:
        subQuestion.correctAnswer ??
        subQuestion.correct_answer ??
        subQuestion.answer ??
        payload.correctAnswer ??
        payload.correct_answer ??
        '',
      points:
        subQuestion.points ??
        subQuestion.max_marks ??
        inheritedPoints,
      max_marks:
        subQuestion.max_marks ??
        subQuestion.points ??
        inheritedPoints,
      passage: normalizeString(subQuestion.passage || subQuestion.context || sharedPassage),
      paragraphGroupId: normalizeString(
        subQuestion.paragraphGroupId || subQuestion.paragraph_group_id || sharedGroupId
      ),
      order:
        Number.isFinite(Number(subQuestion.order)) ? Number(subQuestion.order) : baseOrder + index,
    };

    delete expanded.questions;
    return expanded;
  });
};

const flattenQuestionPayloadList = (payloadList = []) => {
  const safePayloadList = Array.isArray(payloadList) ? payloadList : [];
  const flattened = [];
  let runningOrder = 0;

  safePayloadList.forEach((payload) => {
    const baseOrder = Number.isFinite(Number(payload?.order))
      ? Number(payload.order)
      : runningOrder;
    const expandedPayloads = expandContextQuestionGroupPayload(payload, { baseOrder });
    const safeExpandedPayloads = Array.isArray(expandedPayloads) ? expandedPayloads : [];

    safeExpandedPayloads.forEach((expandedPayload) => {
      const resolvedOrder = Number.isFinite(Number(expandedPayload?.order))
        ? Number(expandedPayload.order)
        : runningOrder;
      flattened.push({
        ...expandedPayload,
        order: resolvedOrder,
      });
      runningOrder = Math.max(runningOrder, resolvedOrder + 1);
    });
  });

  return flattened;
};

const resolveQuestionTypeTokenForExamResponse = (question = {}) => {
  const normalizedType = normalizeString(question.questionType).toUpperCase();
  const normalizedFormat = normalizeString(
    question.questionFormat || question.question_type
  ).toUpperCase();

  if (normalizedType === 'CODING') return 'coding';
  if (normalizedType === 'ESSAY') return 'essay';
  if (normalizedType === 'ESSAY_LETTER') return 'essay_letter';
  if (normalizedType === 'ESSAY_STORY') return 'essay_story';
  if (normalizedType === 'MULTIPLE_OPTIONS') return 'multi_select_mcq';
  if (normalizedType === 'TRUE_FALSE') return 'true_false';
  if (normalizedType === 'NUMBER') return 'numeric';
  if (normalizedType === 'SHORT_ANSWER') return 'short_answer';
  if (normalizedType === 'PARAGRAPH' || normalizedFormat === 'PARAGRAPH') return 'paragraph';
  if (normalizedFormat === 'SCENARIO') return 'scenario';
  if (normalizedFormat === 'IMAGE' || normalizedFormat === 'IMAGE_BASED') return 'image_based';
  if (normalizedType === 'MULTIPLE_CHOICE') return 'mcq';

  return 'short_answer';
};

const validateCodingQuestionPayload = (payload = {}) => {
  const explicitType = normalizeQuestionTypeAlias(payload.questionType || payload.type);
  const explicitFormat = normalizeQuestionFormatAlias(
    payload.questionFormat || payload.question_type || payload.type
  );
  const normalizedType = normalizeQuestionTypeForStorage(payload);
  const normalizedFormat = normalizeQuestionFormat(payload);
  const hasExplicitNonCoding =
    (explicitType && explicitType !== 'CODING') ||
    (explicitFormat && explicitFormat !== 'CODING');
  const isCoding =
    normalizedType === 'CODING' ||
    normalizedFormat === 'CODING' ||
    (!hasExplicitNonCoding && hasCodingConfiguration(payload));

  if (!isCoding) {
    return null;
  }

  const questionPrompt = normalizeString(payload.questionText || payload.question || payload.title);
  const title = normalizeString(payload.title || questionPrompt);
  const description = normalizeString(
    payload.description || payload.problemStatement || payload.prompt || questionPrompt
  );
  const codingFields = extractCodingFields(payload);

  if (!questionPrompt) {
    return 'Coding question prompt is required.';
  }
  if (!title) {
    return 'Coding question title is required.';
  }
  if (!description) {
    return 'Coding question description is required.';
  }
  if (!codingFields.languages.length) {
    return 'At least one coding language is required.';
  }
  if (!codingFields.testCases.length) {
    return 'At least one coding test case is required.';
  }
  if (!codingFields.testCases.some((testCase) => !testCase.hidden)) {
    return 'At least one visible coding test case is required.';
  }

  return null;
};

const isCodingQuestionPayload = (payload = {}) => {
  const explicitType = normalizeQuestionTypeAlias(payload.questionType || payload.type);
  const explicitFormat = normalizeQuestionFormatAlias(
    payload.questionFormat || payload.question_type || payload.type
  );

  if (explicitType) {
    return explicitType === 'CODING';
  }

  if (explicitFormat) {
    return explicitFormat === 'CODING';
  }

  return (
    normalizeQuestionTypeForStorage(payload) === 'CODING' ||
    normalizeQuestionFormat(payload) === 'CODING'
  );
};

const isDataImageSource = (value) => /^data:/i.test(String(value || '').trim());

const createQuestionWithManagedImage = async ({
  examId,
  questionPaperId,
  questionText,
  questionPrompt,
  title,
  description,
  instructions,
  difficulty,
  category,
  questionType,
  type,
  options,
  correctAnswer,
  points,
  max_marks,
  order,
  sectionId,
  passage,
  paragraphGroupId,
  questionFormat,
  question_type,
  imageUrl,
  image_path,
  image,
  imageBase64,
  image_base64,
  generatedImage,
  generated_image,
  languages,
  language,
  starterCode,
  testCases,
  sample_input,
  sample_output,
  timeLimit,
  memoryLimit,
  codingFields,
}) => {
  const inlineImage = typeof image === 'string' ? image.trim() : '';
  const normalizedImageUrlCandidate =
    imageUrl ||
    image_path ||
    (!isDataImageSource(inlineImage) ? inlineImage : '');
  const normalizedImageBase64Candidate =
    imageBase64 ||
    image_base64 ||
    (isDataImageSource(inlineImage) ? inlineImage : '');
  const normalizedStorageQuestionType = normalizeQuestionTypeForStorage({
    questionType: normalizeQuestionTypeAlias(questionType || type),
    questionFormat: normalizeQuestionFormatAlias(questionFormat),
    question_type: normalizeQuestionFormatAlias(question_type || type),
    type,
    options,
    correctAnswer,
    passage,
    paragraphGroupId,
    imageUrl,
    image_path,
    image,
    imageBase64,
    image_base64,
    generatedImage,
    generated_image,
  });
  const normalizedQuestionFormat =
    normalizeQuestionFormat({
      questionType: normalizeQuestionTypeAlias(questionType || type),
      questionFormat: normalizeQuestionFormatAlias(questionFormat),
      question_type: normalizeQuestionFormatAlias(question_type || type),
      type,
      questionText: questionText || questionPrompt,
      passage,
      paragraphGroupId,
      imageUrl,
      image_path,
      image,
      imageBase64,
      image_base64,
      generatedImage,
      generated_image,
      title,
      description,
      category,
      languages: languages ?? language,
      language,
      starterCode,
      testCases,
      sample_input,
      sample_output,
      timeLimit,
      memoryLimit,
      codingFields,
    }) || undefined;
  const normalizedQuestionText = normalizeString(questionText || questionPrompt || title);
  const normalizedTitle = normalizeString(title || normalizedQuestionText);
  const normalizedDescription = normalizeString(description || normalizedQuestionText);
  const normalizedDifficulty = normalizeString(difficulty);
  const normalizedCategory = normalizeString(category);
  const normalizedCodingFields = extractCodingFields({
    difficulty,
    category,
    languages: languages ?? language,
    language,
    starterCode,
    testCases,
    sample_input,
    sample_output,
    timeLimit,
    memoryLimit,
    codingFields,
  });

  const question = new Question({
    questionPaperId,
    questionText: normalizedQuestionText || normalizedTitle,
    title: normalizedTitle || undefined,
    description: normalizedDescription || undefined,
    instructions: typeof instructions === 'string' ? instructions.trim() : undefined,
    difficulty: normalizedDifficulty || undefined,
    category: normalizedCategory || undefined,
    questionType: normalizedStorageQuestionType,
    questionFormat: normalizedQuestionFormat,
    options,
    correctAnswer: normalizeCorrectAnswerForStorage(
      normalizedStorageQuestionType,
      correctAnswer,
      options
    ),
    imageUrl:
      typeof normalizedImageUrlCandidate === 'string' && String(normalizedImageUrlCandidate).trim().length
        ? String(normalizedImageUrlCandidate).trim()
        : undefined,
    imageBase64:
      typeof normalizedImageBase64Candidate === 'string' && String(normalizedImageBase64Candidate).trim().length
        ? String(normalizedImageBase64Candidate).trim()
        : undefined,
    generatedImage:
      typeof (generatedImage || generated_image) === 'string' && String(generatedImage || generated_image).trim().length
        ? String(generatedImage || generated_image).trim()
        : undefined,
    passage: typeof passage === 'string' && passage.trim().length ? passage.trim() : undefined,
    paragraphGroupId:
      typeof paragraphGroupId === 'string' && paragraphGroupId.trim().length ? paragraphGroupId.trim() : undefined,
    codingFields:
      normalizedStorageQuestionType === 'CODING' || normalizedQuestionFormat === 'CODING'
        ? normalizedCodingFields
        : undefined,
    points: Number.isFinite(Number(points ?? max_marks)) ? Number(points ?? max_marks) : 1,
    order: Number.isFinite(Number(order)) ? Number(order) : 0,
    sectionId: sectionId || undefined,
  });

  await question.save();
  await ensureQuestionImageAvailability({
    question,
    examId,
    persist: true,
  });

  return question;
};

// Get all questions for an exam (via question papers)
router.get('/:examId/questions', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const questionPapers = await QuestionPaper.find({ examId: req.params.examId });
    const questionPaperIds = questionPapers.map((qp) => qp._id);

    const questions = await Question.find({
      questionPaperId: { $in: questionPaperIds },
    })
      .populate('questionPaperId', 'setName')
      .sort({ order: 1 });

    try {
      await ensureQuestionsImageAvailability({
        questions,
        examId: req.params.examId,
        persist: true,
      });
    } catch (imageAvailabilityError) {
      console.warn(
        '[questions/list] image availability check failed:',
        imageAvailabilityError?.message || imageAvailabilityError
      );
    }

    res.json({ questions });
  } catch (error) {
    next(error);
  }
});

// Get questions for a specific question paper
router.get('/:examId/question-papers/:paperId/questions', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const { examId, paperId } = req.params;
    
    // Verify exam exists and user has access
    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    // Check tenant boundaries - user must be in same tenant as exam (unless SUPER_ADMIN)
    if (req.user.role !== 'SUPER_ADMIN') {
      const userTenantId = req.user.tenantId;
      const examTenantId = exam.tenantId;
      
      if (userTenantId && examTenantId && userTenantId.toString() !== examTenantId.toString()) {
        return res.status(403).json({ error: 'Access denied - Exam belongs to different tenant' });
      }
    }

    // Verify question paper belongs to this exam
    const questionPaper = await QuestionPaper.findById(paperId);
    if (!questionPaper) {
      return res.status(404).json({ error: 'Question paper not found' });
    }
    
    if (questionPaper.examId.toString() !== examId) {
      return res.status(400).json({ error: 'Question paper does not belong to this exam' });
    }

    // Get questions for this question paper
    const questions = await Question.find({
      questionPaperId: paperId,
    })
      .populate('sectionId', 'name order duration') // Populate section info
      .sort({ order: 1 });

    try {
      await ensureQuestionsImageAvailability({
        questions,
        examId,
        persist: true,
      });
    } catch (imageAvailabilityError) {
      console.warn(
        '[questions/list-by-paper] image availability check failed:',
        imageAvailabilityError?.message || imageAvailabilityError
      );
    }

    const examResponseQuestions = questions.map((questionDoc) => {
      const serializedQuestion =
        typeof questionDoc?.toObject === 'function' ? questionDoc.toObject() : questionDoc;

      return {
        ...serializedQuestion,
        question_type: resolveQuestionTypeTokenForExamResponse(serializedQuestion),
      };
    });

    res.json({ questions: examResponseQuestions });
  } catch (error) {
    next(error);
  }
});

// Create question (requires CREATE_SESSION permission or EXAM_CREATOR)
router.post(
  '/:examId/questions',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can create questions
  requireOwnershipOrAdmin,
  prepareCreateQuestionCount,
  checkQuestionLimit,
  [
    body('questionText')
      .customSanitizer((value, { req }) => normalizeString(value || req.body?.question))
      .custom((value, { req }) => {
        if (isContextQuestionGroupPayload(req.body || {})) {
          return true;
        }
        if (!normalizeString(value)) {
          throw new Error('Question text is required');
        }
        return true;
      }),
    body('question').optional({ nullable: true }).isString().withMessage('question must be a string'),
    body('questionType')
      .customSanitizer((value, { req }) => normalizeQuestionTypeAlias(value || req.body?.type))
      .isIn([
        'MULTIPLE_CHOICE',
        'MULTIPLE_OPTIONS',
        'MULTI_SELECT_MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'NUMBER',
        'CODING',
        'IMAGE_BASED',
      ])
      .withMessage('Invalid question type'),
    body('type').optional({ nullable: true }).isString().withMessage('type must be a string'),
    body('questionFormat')
      .optional({ nullable: true })
      .customSanitizer((value) => normalizeQuestionFormatAlias(value))
      .isIn([
        'MCQ',
        'MULTIPLE_OPTIONS',
        'MULTI_SELECT_MCQ',
        'IMAGE',
        'IMAGE_BASED',
        'PARAGRAPH',
        'SCENARIO',
        'TRUE_FALSE',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'CODING',
      ])
      .withMessage('Invalid question format'),
    body('question_type')
      .optional({ nullable: true })
      .customSanitizer((value) => normalizeQuestionFormatAlias(value))
      .isIn([
        'MCQ',
        'MULTIPLE_OPTIONS',
        'MULTI_SELECT_MCQ',
        'IMAGE',
        'IMAGE_BASED',
        'PARAGRAPH',
        'SCENARIO',
        'TRUE_FALSE',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'CODING',
      ])
      .withMessage('Invalid question format'),
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('order').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
    body('imageUrl').optional({ nullable: true }).isString().withMessage('Image URL must be a string'),
    body('image').optional({ nullable: true }).isString().withMessage('Image must be a string'),
    body('imageBase64').optional({ nullable: true }).isString().withMessage('Image Base64 must be a string'),
    body('generatedImage').optional({ nullable: true }).isString().withMessage('Generated image must be a string'),
    body('sectionId').optional({ nullable: true }).isMongoId().withMessage('Section ID must be a valid id'),
    body('passage').optional({ nullable: true }).isString().withMessage('Passage must be a string'),
    body('paragraphGroupId').optional({ nullable: true }).isString().withMessage('paragraphGroupId must be a string'),
    body('questions').optional({ nullable: true }).isArray().withMessage('questions must be an array'),
    body('title').optional({ nullable: true }).isString().withMessage('Title must be a string'),
    body('description').optional({ nullable: true }).isString().withMessage('Description must be a string'),
    body('instructions').optional({ nullable: true }).isString().withMessage('Instructions must be a string'),
    body('difficulty').optional({ nullable: true }).isString().withMessage('Difficulty must be a string'),
    body('category').optional({ nullable: true }).isString().withMessage('Category must be a string'),
    body('languages').optional({ nullable: true }).isArray().withMessage('Languages must be an array'),
    body('language').optional({ nullable: true }).isString().withMessage('language must be a string'),
    body('sample_input').optional({ nullable: true }).isString().withMessage('sample_input must be a string'),
    body('sample_output').optional({ nullable: true }).isString().withMessage('sample_output must be a string'),
    body('max_marks').optional({ nullable: true }).isNumeric().withMessage('max_marks must be numeric'),
    body('starterCode').optional({ nullable: true }).isObject().withMessage('Starter code must be an object'),
    body('testCases').optional({ nullable: true }).isArray().withMessage('Test cases must be an array'),
    body('timeLimit').optional({ nullable: true }).isNumeric().withMessage('Time limit must be numeric'),
    body('memoryLimit').optional({ nullable: true }).isNumeric().withMessage('Memory limit must be numeric'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        questionText,
        question: legacyQuestionText,
        title,
        description,
        instructions,
        difficulty,
        category,
        questionType,
        type,
        questionFormat,
        question_type,
        options,
        correctAnswer,
        points,
        max_marks,
        order,
        questionPaperId,
        imageUrl,
        image_path,
        image,
        imageBase64,
        image_base64,
        generatedImage,
        generated_image,
        sectionId,
        paragraphGroupId,
        languages,
        language,
        sample_input,
        sample_output,
        starterCode,
        testCases,
        timeLimit,
        memoryLimit,
        codingFields,
      } =
        req.body;
      const { passage } = req.body;
      const normalizedQuestionText = normalizeString(questionText || legacyQuestionText);
      const normalizedQuestionType = normalizeQuestionTypeAlias(questionType || type);
      const normalizedQuestionFormat = normalizeQuestionFormatAlias(
        questionFormat || question_type || type
      );
      const normalizedPoints = points ?? max_marks;
      const normalizedPayload = {
        ...req.body,
        questionText: normalizedQuestionText,
        questionType: normalizedQuestionType,
        questionFormat: normalizedQuestionFormat,
        question_type: normalizedQuestionFormat,
        points: normalizedPoints,
        languages: languages ?? language,
      };
      const isContextQuestionGroup = isContextQuestionGroupPayload(req.body || {});
      const expandedCreateQuestions = Array.isArray(req.planLimitContext?.expandedCreateQuestions)
        ? req.planLimitContext.expandedCreateQuestions
        : flattenQuestionPayloadList([req.body || {}]);

      if (isContextQuestionGroup && expandedCreateQuestions.length === 0) {
        return res.status(400).json({
          error: 'At least one sub-question is required for paragraph/scenario question groups.',
        });
      }

      const createPayloads = isContextQuestionGroup ? expandedCreateQuestions : [normalizedPayload];
      const normalizedCreatePayloads = createPayloads.map((payload) => {
        const safePayload = payload && typeof payload === 'object' ? payload : {};
        const normalizedRecordQuestionText = normalizeString(
          safePayload.questionText || safePayload.question || safePayload.title
        );
        const normalizedRecordQuestionType = normalizeQuestionTypeAlias(
          safePayload.questionType || safePayload.type || normalizedQuestionType
        );
        const normalizedRecordQuestionFormat = normalizeQuestionFormatAlias(
          safePayload.questionFormat || safePayload.question_type || safePayload.type || normalizedQuestionFormat
        );
        const normalizedRecordPoints = safePayload.points ?? safePayload.max_marks ?? normalizedPoints;

        return {
          ...safePayload,
          questionText: normalizedRecordQuestionText,
          questionType: normalizedRecordQuestionType,
          questionFormat: normalizedRecordQuestionFormat,
          question_type: normalizedRecordQuestionFormat,
          points: normalizedRecordPoints,
          languages: safePayload.languages ?? safePayload.language ?? languages ?? language,
        };
      });

      for (const payloadRecord of normalizedCreatePayloads) {
        const codingPayloadError = validateCodingQuestionPayload(payloadRecord);
        if (codingPayloadError) {
          return res.status(400).json({ error: codingPayloadError });
        }
      }

      // Verify question paper belongs to exam
      const questionPaper = await QuestionPaper.findOne({
        _id: questionPaperId,
        examId: req.params.examId,
      });

      if (!questionPaper) {
        return res.status(404).json({ error: 'Question paper not found' });
      }

      // Verify exam belongs to user's tenant (for non-SUPER_ADMIN)
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      if (req.user.role !== 'SUPER_ADMIN') {
        const userTenantId = req.user.tenantId;
        const examTenantId = exam.tenantId;
        
        if (!examTenantId || examTenantId.toString() !== userTenantId?.toString()) {
          return res.status(403).json({ error: 'Access denied - Exam does not belong to your tenant' });
        }
      }

      const planContext = await resolveExamPlanContext(exam._id);
      if (planContext?.planType && isFreePlan(planContext.planType)) {
        for (const payloadRecord of normalizedCreatePayloads) {
          const restrictionError = validateFreePlanQuestionPayload(payloadRecord);
          if (restrictionError) {
            return sendPlanRestriction(res, restrictionError);
          }
        }
      }

      // If sectionId is provided, verify it belongs to the question paper
      const sectionIdsToValidate = Array.from(
        new Set(
          normalizedCreatePayloads
            .map((payloadRecord) => normalizeString(payloadRecord.sectionId || sectionId))
            .filter(Boolean)
        )
      );
      if (sectionIdsToValidate.length > 0) {
        const Section = (await import('../models/Section.js')).default;
        for (const sectionIdToValidate of sectionIdsToValidate) {
          const section = await Section.findOne({
            _id: sectionIdToValidate,
            questionPaperId: questionPaperId,
          });
          if (!section) {
            return res.status(400).json({ error: 'Section does not belong to this question paper' });
          }
        }
      }

      const createdQuestions = [];
      for (let index = 0; index < normalizedCreatePayloads.length; index += 1) {
        const payloadRecord = normalizedCreatePayloads[index];
        const recordQuestionText = normalizeString(
          payloadRecord.questionText || payloadRecord.question || payloadRecord.title
        );

        if (!recordQuestionText) {
          return res.status(400).json({ error: `Question text is required for sub-question ${index + 1}.` });
        }

        const createdQuestion = await createQuestionWithManagedImage({
          examId: req.params.examId,
          questionPaperId,
          questionText: recordQuestionText,
          questionPrompt: payloadRecord.question,
          title: payloadRecord.title ?? title,
          description: payloadRecord.description ?? description,
          instructions: payloadRecord.instructions ?? instructions,
          difficulty: payloadRecord.difficulty ?? difficulty,
          category: payloadRecord.category ?? category,
          questionType: payloadRecord.questionType ?? normalizedQuestionType,
          type: payloadRecord.type ?? type,
          questionFormat: payloadRecord.questionFormat ?? normalizedQuestionFormat,
          question_type: payloadRecord.question_type ?? normalizedQuestionFormat,
          options: parseOptionsInput(payloadRecord.options),
          correctAnswer: payloadRecord.correctAnswer ?? payloadRecord.correct_answer ?? correctAnswer,
          points: payloadRecord.points ?? payloadRecord.max_marks ?? normalizedPoints,
          max_marks: payloadRecord.max_marks ?? max_marks,
          order:
            Number.isFinite(Number(payloadRecord.order)) ? Number(payloadRecord.order) : order ?? index,
          imageUrl: payloadRecord.imageUrl ?? imageUrl,
          image_path: payloadRecord.image_path ?? image_path,
          image: payloadRecord.image ?? image,
          imageBase64: payloadRecord.imageBase64 ?? imageBase64,
          image_base64: payloadRecord.image_base64 ?? image_base64,
          generatedImage: payloadRecord.generatedImage ?? generatedImage,
          generated_image: payloadRecord.generated_image ?? generated_image,
          sectionId: payloadRecord.sectionId ?? sectionId,
          passage: payloadRecord.passage ?? passage,
          paragraphGroupId: payloadRecord.paragraphGroupId ?? paragraphGroupId,
          languages: payloadRecord.languages ?? payloadRecord.language ?? languages ?? language,
          language: payloadRecord.language ?? language,
          sample_input: payloadRecord.sample_input ?? payloadRecord.sampleInput ?? sample_input,
          sample_output: payloadRecord.sample_output ?? payloadRecord.sampleOutput ?? sample_output,
          starterCode: payloadRecord.starterCode ?? starterCode,
          testCases: payloadRecord.testCases ?? testCases,
          timeLimit: payloadRecord.timeLimit ?? timeLimit,
          memoryLimit: payloadRecord.memoryLimit ?? memoryLimit,
          codingFields: payloadRecord.codingFields ?? codingFields,
        });
        createdQuestions.push(createdQuestion);
      }

      await Promise.all(
        createdQuestions.map((createdQuestion) => createdQuestion.populate('questionPaperId', 'setName'))
      );
      await syncExamQuestionCount(req.params.examId);
      void queueExamPackageRegenerationForContentChange({
        examId: req.params.examId,
        userId: req.user._id,
        reason: 'QUESTION_CREATED',
        questionPaperId,
      });

      const primaryQuestion = createdQuestions[0] || null;
      if (!primaryQuestion) {
        return res.status(400).json({ error: 'No questions were created from the provided payload.' });
      }

      if (createdQuestions.length > 1) {
        return res.status(201).json({
          question: primaryQuestion,
          questions: createdQuestions,
          createdCount: createdQuestions.length,
        });
      }

      return res.status(201).json({ question: primaryQuestion });
    } catch (error) {
      next(error);
    }
  }
);

// Get single question
router.get('/:examId/questions/:questionId', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const question = await Question.findById(req.params.questionId).populate(
      'questionPaperId',
      'setName examId'
    );

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    // Verify question belongs to exam
    const questionPaper = await QuestionPaper.findById(question.questionPaperId._id);
    if (questionPaper.examId.toString() !== req.params.examId) {
      return res.status(404).json({ error: 'Question not found for this exam' });
    }

    await ensureQuestionImageAvailability({
      question,
      examId: req.params.examId,
      persist: true,
    });

    res.json({ question });
  } catch (error) {
    next(error);
  }
});

// Update question
router.put(
  '/:examId/questions/:questionId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR'), // Only EXAM_CREATOR can modify questions
  requireOwnershipOrAdmin,
  [
    body('questionText')
      .optional()
      .customSanitizer((value, { req }) => normalizeString(value || req.body?.question))
      .notEmpty(),
    body('question').optional({ nullable: true }).isString().withMessage('question must be a string'),
    body('questionType')
      .optional()
      .customSanitizer((value, { req }) => normalizeQuestionTypeAlias(value || req.body?.type))
      .isIn([
        'MULTIPLE_CHOICE',
        'MULTIPLE_OPTIONS',
        'MULTI_SELECT_MCQ',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'NUMBER',
        'CODING',
        'IMAGE_BASED',
      ]),
    body('type').optional({ nullable: true }).isString().withMessage('type must be a string'),
    body('questionFormat')
      .optional({ nullable: true })
      .customSanitizer((value) => normalizeQuestionFormatAlias(value))
      .isIn([
        'MCQ',
        'MULTIPLE_OPTIONS',
        'MULTI_SELECT_MCQ',
        'IMAGE',
        'IMAGE_BASED',
        'PARAGRAPH',
        'SCENARIO',
        'TRUE_FALSE',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'CODING',
      ])
      .withMessage('Invalid question format'),
    body('question_type')
      .optional({ nullable: true })
      .customSanitizer((value) => normalizeQuestionFormatAlias(value))
      .isIn([
        'MCQ',
        'MULTIPLE_OPTIONS',
        'MULTI_SELECT_MCQ',
        'IMAGE',
        'IMAGE_BASED',
        'PARAGRAPH',
        'SCENARIO',
        'TRUE_FALSE',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'CODING',
      ])
      .withMessage('Invalid question format'),
    body('imageUrl').optional({ nullable: true }).isString().withMessage('Image URL must be a string'),
    body('image').optional({ nullable: true }).isString().withMessage('Image must be a string'),
    body('imageBase64').optional({ nullable: true }).isString().withMessage('Image Base64 must be a string'),
    body('generatedImage').optional({ nullable: true }).isString().withMessage('Generated image must be a string'),
    body('passage').optional({ nullable: true }).isString().withMessage('Passage must be a string'),
    body('paragraphGroupId').optional({ nullable: true }).isString().withMessage('paragraphGroupId must be a string'),
    body('title').optional({ nullable: true }).isString().withMessage('Title must be a string'),
    body('description').optional({ nullable: true }).isString().withMessage('Description must be a string'),
    body('instructions').optional({ nullable: true }).isString().withMessage('Instructions must be a string'),
    body('difficulty').optional({ nullable: true }).isString().withMessage('Difficulty must be a string'),
    body('category').optional({ nullable: true }).isString().withMessage('Category must be a string'),
    body('languages').optional({ nullable: true }).isArray().withMessage('Languages must be an array'),
    body('language').optional({ nullable: true }).isString().withMessage('language must be a string'),
    body('sample_input').optional({ nullable: true }).isString().withMessage('sample_input must be a string'),
    body('sample_output').optional({ nullable: true }).isString().withMessage('sample_output must be a string'),
    body('max_marks').optional({ nullable: true }).isNumeric().withMessage('max_marks must be numeric'),
    body('starterCode').optional({ nullable: true }).isObject().withMessage('Starter code must be an object'),
    body('testCases').optional({ nullable: true }).isArray().withMessage('Test cases must be an array'),
    body('timeLimit').optional({ nullable: true }).isNumeric().withMessage('Time limit must be numeric'),
    body('memoryLimit').optional({ nullable: true }).isNumeric().withMessage('Memory limit must be numeric'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const question = await Question.findById(req.params.questionId);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      // Verify question belongs to exam
      const questionPaper = await QuestionPaper.findById(question.questionPaperId);
      if (questionPaper.examId.toString() !== req.params.examId) {
        return res.status(404).json({ error: 'Question not found for this exam' });
      }

      const exam = await Exam.findById(questionPaper.examId).select('_id createdBy');
      if (exam) {
        const planContext = await resolveExamPlanContext(exam._id);
        if (planContext?.planType && isFreePlan(planContext.planType)) {
          const restrictionPayload = {
            ...question.toObject(),
            ...req.body,
            questionText: normalizeString(
              req.body?.questionText ?? req.body?.question ?? question.questionText
            ),
            questionType: normalizeQuestionTypeAlias(
              req.body?.questionType ?? req.body?.type ?? question.questionType
            ),
            questionFormat: normalizeQuestionFormatAlias(
              req.body?.questionFormat ??
                req.body?.question_type ??
                req.body?.type ??
                question.questionFormat
            ),
            question_type: normalizeQuestionFormatAlias(
              req.body?.question_type ??
                req.body?.questionFormat ??
                req.body?.type ??
                question.questionFormat
            ),
            points: req.body?.points ?? req.body?.max_marks ?? question.points,
            languages:
              req.body?.languages ?? req.body?.language ?? question.codingFields?.languages ?? [],
          };
          const restrictionError = validateFreePlanQuestionPayload(restrictionPayload);
          if (restrictionError) {
            return sendPlanRestriction(res, restrictionError);
          }
        }
      }

      const {
        questionText,
        question: legacyQuestionText,
        questionType,
        type,
        questionFormat,
        question_type,
        options,
        correctAnswer,
        points,
        max_marks,
        order,
        imageUrl,
        image_path,
        image,
        imageBase64,
        image_base64,
        generatedImage,
        generated_image,
        sectionId,
        passage,
        paragraphGroupId,
        title,
        description,
        instructions,
        difficulty,
        category,
        languages,
        language,
        sample_input,
        sample_output,
        starterCode,
        testCases,
        timeLimit,
        memoryLimit,
        codingFields,
      } =
        req.body;
      const normalizedQuestionText =
        questionText !== undefined || legacyQuestionText !== undefined
          ? normalizeString(questionText || legacyQuestionText)
          : undefined;
      const hasQuestionTypeUpdate = questionType !== undefined || type !== undefined;
      const normalizedQuestionType = hasQuestionTypeUpdate
        ? normalizeQuestionTypeAlias(questionType || type)
        : undefined;
      const hasQuestionFormatUpdate =
        questionFormat !== undefined || question_type !== undefined || type !== undefined;
      const normalizedQuestionFormat = hasQuestionFormatUpdate
        ? normalizeQuestionFormatAlias(questionFormat || question_type || type)
        : undefined;
      const normalizedPoints = points ?? max_marks;
      const normalizedPayload = {
        ...question.toObject(),
        ...req.body,
        ...(normalizedQuestionText !== undefined ? { questionText: normalizedQuestionText } : {}),
        ...(normalizedQuestionType !== undefined ? { questionType: normalizedQuestionType } : {}),
        ...(normalizedQuestionFormat !== undefined
          ? { questionFormat: normalizedQuestionFormat, question_type: normalizedQuestionFormat }
          : {}),
        ...(normalizedPoints !== undefined ? { points: normalizedPoints } : {}),
        ...(languages !== undefined || language !== undefined
          ? { languages: languages ?? language }
          : {}),
      };

      const codingPayloadError = validateCodingQuestionPayload(normalizedPayload);
      if (codingPayloadError) {
        return res.status(400).json({ error: codingPayloadError });
      }

      if (normalizedQuestionText !== undefined) question.questionText = normalizedQuestionText;
      if (title !== undefined) question.title = title;
      if (description !== undefined) question.description = description;
      if (instructions !== undefined) question.instructions = instructions;
      if (difficulty !== undefined) question.difficulty = difficulty;
      if (category !== undefined) question.category = category;
      if (hasQuestionTypeUpdate || hasQuestionFormatUpdate) {
        question.questionType = normalizeQuestionTypeForStorage({
          questionType:
            normalizedQuestionType !== undefined ? normalizedQuestionType : question.questionType,
          questionFormat:
            normalizedQuestionFormat !== undefined ? normalizedQuestionFormat : question.questionFormat,
          question_type:
            normalizedQuestionFormat !== undefined ? normalizedQuestionFormat : undefined,
          type,
          options: options !== undefined ? options : question.options,
          correctAnswer: correctAnswer !== undefined ? correctAnswer : question.correctAnswer,
          passage: passage !== undefined ? passage : question.passage,
          paragraphGroupId:
            paragraphGroupId !== undefined ? paragraphGroupId : question.paragraphGroupId,
          imageUrl: imageUrl !== undefined ? imageUrl : question.imageUrl,
          image_path,
          image,
          imageBase64: imageBase64 !== undefined ? imageBase64 : question.imageBase64,
          image_base64,
          generatedImage:
            generatedImage !== undefined ? generatedImage : question.generatedImage,
          generated_image,
          title: title !== undefined ? title : question.title,
          description: description !== undefined ? description : question.description,
          category: category !== undefined ? category : question.category,
          languages:
            languages !== undefined || language !== undefined
              ? languages ?? language
              : question.codingFields?.languages,
          language,
          starterCode: starterCode !== undefined ? starterCode : question.codingFields?.starterCode,
          testCases: testCases !== undefined ? testCases : question.codingFields?.testCases,
          sample_input,
          sample_output,
          timeLimit: timeLimit !== undefined ? timeLimit : question.codingFields?.timeLimit,
          memoryLimit: memoryLimit !== undefined ? memoryLimit : question.codingFields?.memoryLimit,
          codingFields,
        });
        question.questionFormat =
          normalizeQuestionFormat({
            questionType: question.questionType,
            questionFormat:
              normalizedQuestionFormat !== undefined ? normalizedQuestionFormat : question.questionFormat,
            question_type:
              normalizedQuestionFormat !== undefined ? normalizedQuestionFormat : undefined,
            type,
            questionText:
              normalizedQuestionText !== undefined ? normalizedQuestionText : question.questionText,
            passage: passage !== undefined ? passage : question.passage,
            paragraphGroupId:
              paragraphGroupId !== undefined ? paragraphGroupId : question.paragraphGroupId,
            imageUrl: imageUrl !== undefined ? imageUrl : question.imageUrl,
            image_path,
            image,
            imageBase64: imageBase64 !== undefined ? imageBase64 : question.imageBase64,
            image_base64,
            generatedImage:
              generatedImage !== undefined ? generatedImage : question.generatedImage,
            generated_image,
            title: title !== undefined ? title : question.title,
            description: description !== undefined ? description : question.description,
            category: category !== undefined ? category : question.category,
            languages:
              languages !== undefined || language !== undefined
                ? languages ?? language
                : question.codingFields?.languages,
            language,
            starterCode: starterCode !== undefined ? starterCode : question.codingFields?.starterCode,
            testCases: testCases !== undefined ? testCases : question.codingFields?.testCases,
            sample_input,
            sample_output,
            timeLimit: timeLimit !== undefined ? timeLimit : question.codingFields?.timeLimit,
            memoryLimit: memoryLimit !== undefined ? memoryLimit : question.codingFields?.memoryLimit,
            codingFields,
          }) || undefined;
      }
      if (options !== undefined) question.options = options;
      if (correctAnswer !== undefined) question.correctAnswer = correctAnswer;
      if (normalizedPoints !== undefined) question.points = normalizedPoints;
      if (order !== undefined) question.order = order;
      if (
        imageUrl !== undefined ||
        image_path !== undefined ||
        (image !== undefined && !isDataImageSource(image))
      ) {
        const incomingImageValue =
          imageUrl !== undefined
            ? imageUrl
            : image_path !== undefined
              ? image_path
              : image;
        const normalized = typeof incomingImageValue === 'string' ? incomingImageValue.trim() : '';
        question.imageUrl =
          normalized.length && !isDataImageSource(normalized) ? normalized : '';
      }
      if (
        imageBase64 !== undefined ||
        image_base64 !== undefined ||
        (image !== undefined && isDataImageSource(image))
      ) {
        const incomingBase64Value =
          imageBase64 !== undefined
            ? imageBase64
            : image_base64 !== undefined
              ? image_base64
              : image;
        const normalized = typeof incomingBase64Value === 'string' ? incomingBase64Value.trim() : '';
        question.imageBase64 =
          normalized.length && isDataImageSource(normalized) ? normalized : '';
      }
      if (generatedImage !== undefined || generated_image !== undefined) {
        const incomingGeneratedValue = generatedImage !== undefined ? generatedImage : generated_image;
        const normalized = typeof incomingGeneratedValue === 'string' ? incomingGeneratedValue.trim() : '';
        question.generatedImage = normalized.length ? normalized : '';
      }
      if (sectionId !== undefined) {
        const normalizedSectionId =
          typeof sectionId === 'string' ? sectionId.trim() : sectionId;
        if (!normalizedSectionId) {
          question.sectionId = undefined;
        } else {
          const Section = (await import('../models/Section.js')).default;
          const section = await Section.findOne({
            _id: normalizedSectionId,
            questionPaperId: questionPaper._id,
          });
          if (!section) {
            return res.status(400).json({ error: 'Section does not belong to this question paper' });
          }
          question.sectionId = normalizedSectionId;
        }
      }
      if (passage !== undefined) {
        const normalizedPassage = typeof passage === 'string' ? passage.trim() : '';
        question.passage = normalizedPassage.length ? normalizedPassage : '';
      }
      if (paragraphGroupId !== undefined) {
        const normalizedParagraphGroupId = typeof paragraphGroupId === 'string' ? paragraphGroupId.trim() : '';
        question.paragraphGroupId = normalizedParagraphGroupId.length ? normalizedParagraphGroupId : '';
      }
      if (
        languages !== undefined ||
        language !== undefined ||
        starterCode !== undefined ||
        testCases !== undefined ||
        sample_input !== undefined ||
        sample_output !== undefined ||
        timeLimit !== undefined ||
        memoryLimit !== undefined ||
        codingFields !== undefined
      ) {
        question.codingFields = extractCodingFields({
          difficulty: difficulty !== undefined ? difficulty : question.difficulty,
          category: category !== undefined ? category : question.category,
          languages:
            languages !== undefined || language !== undefined
              ? languages ?? language
              : question.codingFields?.languages,
          language,
          starterCode: starterCode !== undefined ? starterCode : question.codingFields?.starterCode,
          testCases: testCases !== undefined ? testCases : question.codingFields?.testCases,
          sample_input,
          sample_output,
          timeLimit: timeLimit !== undefined ? timeLimit : question.codingFields?.timeLimit,
          memoryLimit: memoryLimit !== undefined ? memoryLimit : question.codingFields?.memoryLimit,
          codingFields,
        });
      }

      if (
        !isCodingQuestionPayload({
          questionType: question.questionType,
          questionFormat: question.questionFormat,
          question_type: question.questionFormat,
          options: question.options,
          correctAnswer: question.correctAnswer,
          passage: question.passage,
          paragraphGroupId: question.paragraphGroupId,
          imageUrl: question.imageUrl,
          imageBase64: question.imageBase64,
          generatedImage: question.generatedImage,
          codingFields: question.codingFields,
        })
      ) {
        question.codingFields = undefined;
      }

      await question.save();
      await ensureQuestionImageAvailability({
        question,
        examId: req.params.examId,
        persist: true,
      });
      await question.populate('questionPaperId', 'setName');
      void queueExamPackageRegenerationForContentChange({
        examId: req.params.examId,
        userId: req.user._id,
        reason: 'QUESTION_UPDATED',
        questionPaperId: questionPaper._id,
      });

      res.json({ question });
    } catch (error) {
      next(error);
    }
  }
);

// Delete question
router.delete(
  '/:examId/questions/:questionId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR'), // Only EXAM_CREATOR can modify questions
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const question = await Question.findById(req.params.questionId);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      // Verify question belongs to exam
      const questionPaper = await QuestionPaper.findById(question.questionPaperId);
      if (questionPaper.examId.toString() !== req.params.examId) {
        return res.status(404).json({ error: 'Question not found for this exam' });
      }

      await Question.findByIdAndDelete(req.params.questionId);
      await syncExamQuestionCount(req.params.examId);
      void queueExamPackageRegenerationForContentChange({
        examId: req.params.examId,
        userId: req.user._id,
        reason: 'QUESTION_DELETED',
        questionPaperId: questionPaper._id,
      });
      res.json({ message: 'Question deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:examId/questions/:questionId/ensure-image',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  [
    body('forceGenerate').optional().isBoolean().withMessage('forceGenerate must be a boolean'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const question = await Question.findById(req.params.questionId);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      const questionPaper = await QuestionPaper.findById(question.questionPaperId);
      if (!questionPaper || questionPaper.examId.toString() !== req.params.examId) {
        return res.status(404).json({ error: 'Question not found for this exam' });
      }

      const result = await ensureQuestionImageAvailability({
        question,
        examId: req.params.examId,
        persist: true,
        forceGenerate: Boolean(req.body?.forceGenerate),
      });

      await question.populate('questionPaperId', 'setName');

      res.json({
        question,
        imageStatus: {
          changed: result.changed,
          regenerated: result.regenerated,
          restoredFromBase64: result.restoredFromBase64,
          warnings: result.warnings,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Import questions from CSV
router.post(
  '/:examId/questions/import',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Keep import permissions aligned with manual question creation
  requireOwnershipOrAdmin,
  prepareImportedQuestionCount,
  checkQuestionLimit,
  async (req, res, next) => {
    try {
      const { csvContent, questionPaperId } = req.body;
      const preParsedRecords = req.planLimitContext?.parsedCsvRecords;
      const importSourceType = normalizeString(req.body?.importSourceType).toUpperCase() || 'FILE';
      const importedQuestionsPayload = Array.isArray(req.planLimitContext?.parsedImportedQuestions)
        ? req.planLimitContext.parsedImportedQuestions
        : Array.isArray(req.body?.questions)
          ? flattenQuestionPayloadList(req.body.questions)
          : null;

      console.log('[questions/import] Request summary:', {
        examId: req.params.examId,
        importSourceType,
        hasCsvContent: Boolean(normalizeString(csvContent)),
        payloadQuestionsCount: Array.isArray(importedQuestionsPayload) ? importedQuestionsPayload.length : 0,
        questionPaperIdProvided: Boolean(normalizeString(questionPaperId)),
      });

      if (!csvContent && !importedQuestionsPayload) {
        return res.status(400).json({
          success: false,
          importedCount: 0,
          message: 'Import failed. No questions were added.',
          error: 'Questions payload is empty. Please import at least one valid question.',
        });
      }

      let effectiveQuestionPaperId = normalizeString(questionPaperId);
      if (!effectiveQuestionPaperId) {
        const fallbackQuestionPaper = await QuestionPaper.findOne({
          examId: req.params.examId,
        })
          .select('_id')
          .sort({ createdAt: 1 })
          .lean();
        effectiveQuestionPaperId = fallbackQuestionPaper?._id
          ? String(fallbackQuestionPaper._id)
          : '';

        if (effectiveQuestionPaperId) {
          console.warn(
            '[questions/import] Missing questionPaperId in payload. Using fallback question paper:',
            effectiveQuestionPaperId
          );
        }
      }

      if (!effectiveQuestionPaperId) {
        return res.status(400).json({
          success: false,
          importedCount: 0,
          message: 'Import failed. No questions were added.',
          error: 'Question paper ID is missing for this import request.',
        });
      }

      // Verify question paper belongs to exam
      const questionPaper = await QuestionPaper.findOne({
        _id: effectiveQuestionPaperId,
        examId: req.params.examId,
      });

      if (!questionPaper) {
        return res.status(404).json({ error: 'Question paper not found' });
      }

      const exam = await Exam.findById(req.params.examId).select('_id createdBy tenantId');
      let freePlanRestriction = null;
      if (exam) {
        const planContext = await resolveExamPlanContext(exam._id);
        if (planContext?.planType && isFreePlan(planContext.planType)) {
          freePlanRestriction = true;
        }
      }

      let createdQuestions = [];
      const rejectedRows = [];

      const importRecords = (() => {
        if (Array.isArray(importedQuestionsPayload)) {
          return importedQuestionsPayload;
        }

        const parsedRecords = Array.isArray(preParsedRecords)
          ? preParsedRecords
          : parseCSV(csvContent);
        validateQuestionCSV(parsedRecords);
        return parsedRecords;
      })();

      if (importedQuestionsPayload && Array.isArray(importRecords)) {
        console.log('[questions/import] Payload sample row:', importRecords[0] || null);
      }

      for (let index = 0; index < importRecords.length; index += 1) {
        const record = importRecords[index] || {};
        const preparedRecord = prepareImportedQuestionRecordForInsert(record, index);
        const rowNumber = Number.isFinite(Number(record?._rowIndex))
          ? Number(record._rowIndex)
          : index + 1;
        const rowValidationErrors = validatePreparedImportQuestion(preparedRecord);

        if (rowValidationErrors.length > 0) {
          const reason = rowValidationErrors.join('; ');
          rejectedRows.push({
            row: rowNumber,
            reason,
            questionText: normalizeString(preparedRecord.questionText).slice(0, 140),
          });
          console.warn('[questions/import] Row rejected by validation:', {
            row: rowNumber,
            reason,
          });
          continue;
        }

        if (freePlanRestriction) {
          const restrictionError = validateFreePlanQuestionPayload(preparedRecord);
          if (restrictionError) {
            return sendPlanRestriction(res, restrictionError);
          }
        }

        try {
          const createdQuestion = await createQuestionWithManagedImage({
            examId: req.params.examId,
            questionPaperId: effectiveQuestionPaperId,
            questionText: preparedRecord.questionText || preparedRecord.question || preparedRecord.title,
            questionPrompt: preparedRecord.question,
            title: preparedRecord.title,
            description: preparedRecord.description,
            instructions: preparedRecord.instructions,
            difficulty: preparedRecord.difficulty,
            category: preparedRecord.category,
            questionType: preparedRecord.questionType,
            type: preparedRecord.type,
            options: parseOptionsInput(preparedRecord.options),
            correctAnswer: preparedRecord.correctAnswer || '',
            points: parseInt(preparedRecord.points ?? preparedRecord.max_marks, 10) || 1,
            max_marks: preparedRecord.max_marks,
            order: Number.isFinite(Number(preparedRecord.order))
              ? Number(preparedRecord.order)
              : index,
            sectionId: preparedRecord.sectionId,
            passage: preparedRecord.passage,
            questionFormat: preparedRecord.questionFormat,
            question_type: preparedRecord.question_type,
            imageUrl: preparedRecord.imageUrl,
            image_path: preparedRecord.image_path,
            image: preparedRecord.image,
            imageBase64: preparedRecord.imageBase64,
            image_base64: preparedRecord.image_base64,
            generatedImage: preparedRecord.generatedImage,
            generated_image: preparedRecord.generated_image,
            languages: preparedRecord.languages ?? preparedRecord.language,
            language: preparedRecord.language,
            starterCode: preparedRecord.starterCode,
            testCases: preparedRecord.testCases,
            sample_input: preparedRecord.sample_input ?? preparedRecord.sampleInput,
            sample_output: preparedRecord.sample_output ?? preparedRecord.sampleOutput,
            timeLimit: preparedRecord.timeLimit,
            memoryLimit: preparedRecord.memoryLimit,
            codingFields: preparedRecord.codingFields,
          });
          createdQuestions.push(createdQuestion);
        } catch (rowError) {
          const detailedReason =
            rowError?.name === 'ValidationError' && rowError?.errors
              ? Object.values(rowError.errors)
                  .map((entry) => entry?.message)
                  .filter(Boolean)
                  .join('; ')
              : rowError?.message || 'Unknown import error';

          rejectedRows.push({
            row: rowNumber,
            reason: detailedReason || 'Unknown import error',
            questionText: normalizeString(preparedRecord.questionText).slice(0, 140),
          });
          console.warn('[questions/import] Row failed during save:', {
            row: rowNumber,
            reason: detailedReason || 'Unknown import error',
          });
        }
      }

      await syncExamQuestionCount(req.params.examId);

      const tenantIdForUsage = exam?.tenantId || req.user?.tenantId || null;
      if (tenantIdForUsage && createdQuestions.length > 0) {
        try {
          await trackAIUsageEvent({
            feature: 'question_import_file',
            tenantId: tenantIdForUsage,
            userId: req.user?._id || null,
            model: 'upload',
            usageCount: 1,
            questionCount: createdQuestions.length,
            requestStatus: 'SUCCESS',
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          });
        } catch (usageTrackError) {
          console.warn(
            '[questions/import] failed to track import usage:',
            usageTrackError?.message || usageTrackError
          );
        }
      }

      if (rejectedRows.length > 0) {
        console.warn('[questions/import] Rejected row summary:', rejectedRows.slice(0, 25));
      }

      if (!createdQuestions.length) {
        const firstFailureReason = rejectedRows[0]?.reason || 'No valid questions found in the uploaded file.';
        return res.status(400).json({
          success: false,
          importedCount: 0,
          message: 'Import failed. No questions were added.',
          error: firstFailureReason,
          details: rejectedRows
            .slice(0, 25)
            .map((entry) => `Row ${entry.row}: ${entry.reason}`),
          questions: [],
        });
      }

      void queueExamPackageRegenerationForContentChange({
        examId: req.params.examId,
        userId: req.user._id,
        reason: 'QUESTIONS_IMPORTED',
        questionPaperId: effectiveQuestionPaperId,
      });

      console.log('[question-import-debug] TOTAL IMPORTED:', createdQuestions.length);
      createdQuestions.forEach((question, index) => {
        console.log(
          `[question-import-debug] DB Q${index + 1}: questionType=${question?.questionType || ''} questionFormat=${question?.questionFormat || ''}`
        );
      });

      res.status(201).json({
        success: true,
        importedCount: createdQuestions.length,
        message: `Successfully imported ${createdQuestions.length} question${createdQuestions.length === 1 ? '' : 's'}.`,
        questions: createdQuestions,
        skippedCount: rejectedRows.length,
        skipped: rejectedRows.slice(0, 25),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

