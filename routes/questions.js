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
import {
  extractCodingFields,
  hasCodingConfiguration,
} from '../utils/codingQuestions.js';

const router = express.Router();

const prepareImportedQuestionCount = (req, res, next) => {
  try {
    const importedQuestions = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (importedQuestions) {
      req.planLimitContext = {
        ...(req.planLimitContext || {}),
        parsedImportedQuestions: importedQuestions,
        questionsToAdd: importedQuestions.length,
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

const resolveQuestionTypeTokenForExamResponse = (question = {}) => {
  const normalizedType = normalizeString(question.questionType).toUpperCase();
  const normalizedFormat = normalizeString(
    question.questionFormat || question.question_type
  ).toUpperCase();

  if (normalizedType === 'CODING') return 'coding';
  if (normalizedType === 'MULTIPLE_OPTIONS') return 'multi_select';
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
  const explicitType = normalizeString(payload.questionType).toUpperCase();
  const explicitFormat = normalizeString(payload.questionFormat || payload.question_type).toUpperCase();
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

  const title = normalizeString(payload.title || payload.questionText);
  const description = normalizeString(payload.description);
  const codingFields = extractCodingFields(payload);

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
  const explicitType = normalizeString(payload.questionType).toUpperCase();
  const explicitFormat = normalizeString(payload.questionFormat || payload.question_type).toUpperCase();

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
  title,
  description,
  difficulty,
  category,
  questionType,
  options,
  correctAnswer,
  points,
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
  starterCode,
  testCases,
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
    questionType,
    questionFormat,
    question_type,
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
      questionType,
      questionFormat,
      question_type,
      questionText,
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
      languages,
      starterCode,
      testCases,
      timeLimit,
      memoryLimit,
      codingFields,
    }) || undefined;
  const normalizedTitle = normalizeString(title || questionText);
  const normalizedDescription = normalizeString(description);
  const normalizedDifficulty = normalizeString(difficulty);
  const normalizedCategory = normalizeString(category);
  const normalizedCodingFields = extractCodingFields({
    difficulty,
    category,
    languages,
    starterCode,
    testCases,
    timeLimit,
    memoryLimit,
    codingFields,
  });

  const question = new Question({
    questionPaperId,
    questionText: normalizeString(questionText || normalizedTitle),
    title: normalizedTitle || undefined,
    description: normalizedDescription || undefined,
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
    points: Number.isFinite(Number(points)) ? Number(points) : 1,
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

    await ensureQuestionsImageAvailability({
      questions,
      examId: req.params.examId,
      persist: true,
    });

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

    await ensureQuestionsImageAvailability({
      questions,
      examId,
      persist: true,
    });

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
  checkQuestionLimit,
  [
    body('questionText').trim().notEmpty().withMessage('Question text is required'),
    body('questionType')
      .isIn(['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'SHORT_ANSWER', 'PARAGRAPH', 'NUMBER', 'CODING', 'IMAGE_BASED'])
      .withMessage('Invalid question type'),
    body('questionFormat')
      .optional({ nullable: true })
      .isIn(['MCQ', 'IMAGE', 'IMAGE_BASED', 'PARAGRAPH', 'SCENARIO', 'TRUE_FALSE', 'CODING'])
      .withMessage('Invalid question format'),
    body('question_type')
      .optional({ nullable: true })
      .isIn(['MCQ', 'IMAGE', 'IMAGE_BASED', 'PARAGRAPH', 'SCENARIO', 'TRUE_FALSE', 'CODING'])
      .withMessage('Invalid question format'),
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('order').isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
    body('imageUrl').optional({ nullable: true }).isString().withMessage('Image URL must be a string'),
    body('image').optional({ nullable: true }).isString().withMessage('Image must be a string'),
    body('imageBase64').optional({ nullable: true }).isString().withMessage('Image Base64 must be a string'),
    body('generatedImage').optional({ nullable: true }).isString().withMessage('Generated image must be a string'),
    body('sectionId').optional({ nullable: true }).isMongoId().withMessage('Section ID must be a valid id'),
    body('passage').optional({ nullable: true }).isString().withMessage('Passage must be a string'),
    body('paragraphGroupId').optional({ nullable: true }).isString().withMessage('paragraphGroupId must be a string'),
    body('title').optional({ nullable: true }).isString().withMessage('Title must be a string'),
    body('description').optional({ nullable: true }).isString().withMessage('Description must be a string'),
    body('difficulty').optional({ nullable: true }).isString().withMessage('Difficulty must be a string'),
    body('category').optional({ nullable: true }).isString().withMessage('Category must be a string'),
    body('languages').optional({ nullable: true }).isArray().withMessage('Languages must be an array'),
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
        title,
        description,
        difficulty,
        category,
        questionType,
        questionFormat,
        question_type,
        options,
        correctAnswer,
        points,
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
        starterCode,
        testCases,
        timeLimit,
        memoryLimit,
        codingFields,
      } =
        req.body;
      const { passage } = req.body;

      const codingPayloadError = validateCodingQuestionPayload(req.body);
      if (codingPayloadError) {
        return res.status(400).json({ error: codingPayloadError });
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
        const restrictionError = validateFreePlanQuestionPayload(req.body);
        if (restrictionError) {
          return sendPlanRestriction(res, restrictionError);
        }
      }

      // If sectionId is provided, verify it belongs to the question paper
      if (sectionId) {
        const Section = (await import('../models/Section.js')).default;
        const section = await Section.findOne({
          _id: sectionId,
          questionPaperId: questionPaperId,
        });
        if (!section) {
          return res.status(400).json({ error: 'Section does not belong to this question paper' });
        }
      }

      const question = await createQuestionWithManagedImage({
        examId: req.params.examId,
        questionPaperId,
        questionText,
        title,
        description,
        difficulty,
        category,
        questionType,
        questionFormat,
        question_type,
        options,
        correctAnswer,
        points,
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
        languages,
        starterCode,
        testCases,
        timeLimit,
        memoryLimit,
        codingFields,
      });
      await question.populate('questionPaperId', 'setName');
      await syncExamQuestionCount(req.params.examId);

      res.status(201).json({ question });
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
    body('questionText').optional().trim().notEmpty(),
    body('questionType').optional().isIn(['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'SHORT_ANSWER', 'PARAGRAPH', 'NUMBER', 'CODING', 'IMAGE_BASED']),
    body('questionFormat')
      .optional({ nullable: true })
      .isIn(['MCQ', 'IMAGE', 'IMAGE_BASED', 'PARAGRAPH', 'SCENARIO', 'TRUE_FALSE', 'CODING'])
      .withMessage('Invalid question format'),
    body('question_type')
      .optional({ nullable: true })
      .isIn(['MCQ', 'IMAGE', 'IMAGE_BASED', 'PARAGRAPH', 'SCENARIO', 'TRUE_FALSE', 'CODING'])
      .withMessage('Invalid question format'),
    body('imageUrl').optional({ nullable: true }).isString().withMessage('Image URL must be a string'),
    body('image').optional({ nullable: true }).isString().withMessage('Image must be a string'),
    body('imageBase64').optional({ nullable: true }).isString().withMessage('Image Base64 must be a string'),
    body('generatedImage').optional({ nullable: true }).isString().withMessage('Generated image must be a string'),
    body('passage').optional({ nullable: true }).isString().withMessage('Passage must be a string'),
    body('paragraphGroupId').optional({ nullable: true }).isString().withMessage('paragraphGroupId must be a string'),
    body('title').optional({ nullable: true }).isString().withMessage('Title must be a string'),
    body('description').optional({ nullable: true }).isString().withMessage('Description must be a string'),
    body('difficulty').optional({ nullable: true }).isString().withMessage('Difficulty must be a string'),
    body('category').optional({ nullable: true }).isString().withMessage('Category must be a string'),
    body('languages').optional({ nullable: true }).isArray().withMessage('Languages must be an array'),
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
          const restrictionError = validateFreePlanQuestionPayload({
            ...question.toObject(),
            ...req.body,
          });
          if (restrictionError) {
            return sendPlanRestriction(res, restrictionError);
          }
        }
      }

      const {
        questionText,
        questionType,
        questionFormat,
        question_type,
        options,
        correctAnswer,
        points,
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
        difficulty,
        category,
        languages,
        starterCode,
        testCases,
        timeLimit,
        memoryLimit,
        codingFields,
      } =
        req.body;

      const codingPayloadError = validateCodingQuestionPayload({
        ...question.toObject(),
        ...req.body,
      });
      if (codingPayloadError) {
        return res.status(400).json({ error: codingPayloadError });
      }

      if (questionText) question.questionText = questionText;
      if (title !== undefined) question.title = title;
      if (description !== undefined) question.description = description;
      if (difficulty !== undefined) question.difficulty = difficulty;
      if (category !== undefined) question.category = category;
      if (questionType || questionFormat || question_type) {
        question.questionType = normalizeQuestionTypeForStorage({
          questionType: questionType !== undefined ? questionType : question.questionType,
          questionFormat: questionFormat !== undefined ? questionFormat : question.questionFormat,
          question_type,
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
          languages: languages !== undefined ? languages : question.codingFields?.languages,
          starterCode: starterCode !== undefined ? starterCode : question.codingFields?.starterCode,
          testCases: testCases !== undefined ? testCases : question.codingFields?.testCases,
          timeLimit: timeLimit !== undefined ? timeLimit : question.codingFields?.timeLimit,
          memoryLimit: memoryLimit !== undefined ? memoryLimit : question.codingFields?.memoryLimit,
          codingFields,
        });
        question.questionFormat =
          normalizeQuestionFormat({
            questionType: question.questionType,
            questionFormat:
              questionFormat !== undefined ? questionFormat : question.questionFormat,
            question_type,
            questionText: questionText !== undefined ? questionText : question.questionText,
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
            languages: languages !== undefined ? languages : question.codingFields?.languages,
            starterCode: starterCode !== undefined ? starterCode : question.codingFields?.starterCode,
            testCases: testCases !== undefined ? testCases : question.codingFields?.testCases,
            timeLimit: timeLimit !== undefined ? timeLimit : question.codingFields?.timeLimit,
            memoryLimit: memoryLimit !== undefined ? memoryLimit : question.codingFields?.memoryLimit,
            codingFields,
          }) || undefined;
      }
      if (options !== undefined) question.options = options;
      if (correctAnswer !== undefined) question.correctAnswer = correctAnswer;
      if (points !== undefined) question.points = points;
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
        starterCode !== undefined ||
        testCases !== undefined ||
        timeLimit !== undefined ||
        memoryLimit !== undefined ||
        codingFields !== undefined
      ) {
        question.codingFields = extractCodingFields({
          difficulty: difficulty !== undefined ? difficulty : question.difficulty,
          category: category !== undefined ? category : question.category,
          languages: languages !== undefined ? languages : question.codingFields?.languages,
          starterCode: starterCode !== undefined ? starterCode : question.codingFields?.starterCode,
          testCases: testCases !== undefined ? testCases : question.codingFields?.testCases,
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
  requireRole('EXAM_CREATOR'), // Only EXAM_CREATOR can modify questions
  requireOwnershipOrAdmin,
  prepareImportedQuestionCount,
  checkQuestionLimit,
  async (req, res, next) => {
    try {
      const { csvContent, questionPaperId } = req.body;
      const preParsedRecords = req.planLimitContext?.parsedCsvRecords;
      const importedQuestionsPayload = Array.isArray(req.body?.questions)
        ? req.body.questions
        : Array.isArray(req.planLimitContext?.parsedImportedQuestions)
          ? req.planLimitContext.parsedImportedQuestions
          : null;

      if ((!csvContent && !importedQuestionsPayload) || !questionPaperId) {
        return res.status(400).json({
          error: 'Questions or CSV content and question paper ID are required',
        });
      }

      // Verify question paper belongs to exam
      const questionPaper = await QuestionPaper.findOne({
        _id: questionPaperId,
        examId: req.params.examId,
      });

      if (!questionPaper) {
        return res.status(404).json({ error: 'Question paper not found' });
      }

      const exam = await Exam.findById(req.params.examId).select('_id createdBy');
      let freePlanRestriction = null;
      if (exam) {
        const planContext = await resolveExamPlanContext(exam._id);
        if (planContext?.planType && isFreePlan(planContext.planType)) {
          freePlanRestriction = true;
        }
      }

      let createdQuestions = [];

      if (importedQuestionsPayload) {
        for (let index = 0; index < importedQuestionsPayload.length; index += 1) {
          const record = importedQuestionsPayload[index] || {};
          if (freePlanRestriction) {
            const restrictionError = validateFreePlanQuestionPayload(record);
            if (restrictionError) {
              return sendPlanRestriction(res, restrictionError);
            }
          }
          const createdQuestion = await createQuestionWithManagedImage({
            examId: req.params.examId,
            questionPaperId,
            questionText: record.questionText || record.title,
            title: record.title,
            description: record.description,
            difficulty: record.difficulty,
            category: record.category,
            questionType: record.questionType,
            options: parseOptionsInput(record.options),
            correctAnswer: record.correctAnswer || '',
            points: parseInt(record.points) || 1,
            order: Number.isFinite(Number(record.order)) ? Number(record.order) : index,
            sectionId: record.sectionId,
            passage: record.passage,
            questionFormat: record.questionFormat,
            question_type: record.question_type,
            imageUrl: record.imageUrl,
            image_path: record.image_path,
            image: record.image,
            imageBase64: record.imageBase64,
            image_base64: record.image_base64,
            generatedImage: record.generatedImage,
            generated_image: record.generated_image,
            languages: record.languages,
            starterCode: record.starterCode,
            testCases: record.testCases,
            timeLimit: record.timeLimit,
            memoryLimit: record.memoryLimit,
            codingFields: record.codingFields,
          });
          createdQuestions.push(createdQuestion);
        }
      } else {
        const records = Array.isArray(preParsedRecords)
          ? preParsedRecords
          : parseCSV(csvContent);
        validateQuestionCSV(records);

        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          if (freePlanRestriction) {
            const restrictionError = validateFreePlanQuestionPayload(record);
            if (restrictionError) {
              return sendPlanRestriction(res, restrictionError);
            }
          }
          const createdQuestion = await createQuestionWithManagedImage({
            examId: req.params.examId,
            questionPaperId,
            questionText: record.questionText || record.title,
            title: record.title,
            description: record.description,
            difficulty: record.difficulty,
            category: record.category,
            questionType: record.questionType,
            options: parseOptionsInput(record.options),
            correctAnswer: record.correctAnswer || '',
            points: parseInt(record.points) || 1,
            order: parseInt(record.order) || index,
            imageUrl: record.imageUrl,
            image_path: record.image_path,
            image: record.image,
            imageBase64: record.imageBase64,
            image_base64: record.image_base64,
            generatedImage: record.generatedImage,
            generated_image: record.generated_image,
            questionFormat: record.questionFormat,
            question_type: record.question_type,
            languages: record.languages,
            starterCode: record.starterCode,
            testCases: record.testCases,
            timeLimit: record.timeLimit,
            memoryLimit: record.memoryLimit,
            codingFields: record.codingFields,
          });
          createdQuestions.push(createdQuestion);
        }
      }

      await syncExamQuestionCount(req.params.examId);

      res.status(201).json({
        message: `Imported ${createdQuestions.length} questions`,
        questions: createdQuestions,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

