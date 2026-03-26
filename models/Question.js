import mongoose from 'mongoose';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';
import {
  normalizeQuestionCorrectAnswer,
  sanitizeQuestionOptionText,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';
import {
  normalizeQuestionFormat,
  normalizeQuestionTypeForStorage,
} from '../utils/questionTypes.js';
import {
  extractCodingFields,
  hasCodingConfiguration,
  normalizeCodingCategory,
  normalizeCodingDifficulty,
  normalizeCodingLanguages,
} from '../utils/codingQuestions.js';

const QuestionSchema = new mongoose.Schema(
  {
    uniqueId: {
      type: String,
      unique: true,
      required: false, // Will be generated in pre-validate hook
      sparse: true,
      immutable: true,
    },
    questionPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      required: true,
    },
    questionText: {
      type: String,
      required: true,
      trim: true,
      alias: 'question_text',
    },
    questionType: {
      type: String,
      enum: [
        'MULTIPLE_CHOICE',
        'MULTIPLE_OPTIONS',
        'TRUE_FALSE',
        'SHORT_ANSWER',
        'PARAGRAPH',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'NUMBER',
        'CODING',
      ],
      required: true,
    },
    questionFormat: {
      type: String,
      enum: [
        'MCQ',
        'IMAGE',
        'PARAGRAPH',
        'SCENARIO',
        'TRUE_FALSE',
        'ESSAY',
        'ESSAY_LETTER',
        'ESSAY_STORY',
        'CODING',
      ],
      alias: 'question_type',
    },
    title: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    instructions: {
      type: String,
      trim: true,
      default: '',
    },
    difficulty: {
      type: String,
      trim: true,
      default: '',
    },
    category: {
      type: String,
      trim: true,
      default: '',
    },
    options: {
      type: mongoose.Schema.Types.Mixed,
    },
    optionA: {
      type: String,
      trim: true,
      alias: 'option_a',
    },
    optionB: {
      type: String,
      trim: true,
      alias: 'option_b',
    },
    optionC: {
      type: String,
      trim: true,
      alias: 'option_c',
    },
    optionD: {
      type: String,
      trim: true,
      alias: 'option_d',
    },
    correctAnswer: {
      type: String,
      alias: 'correct_answer',
    },
    imageUrl: {
      type: String,
      trim: true,
      alias: 'image_path',
    },
    imageBase64: {
      type: String,
      trim: true,
      alias: 'image_base64',
    },
    generatedImage: {
      type: String,
      trim: true,
      alias: 'generated_image',
    },
    passage: {
      type: String,
      trim: true,
    },
    paragraphGroupId: {
      type: String,
      trim: true,
      alias: 'paragraph_group_id',
    },
    codingFields: {
      languages: {
        type: [String],
        default: [],
      },
      starterCode: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
      testCases: [
        {
          input: {
            type: String,
            default: '',
          },
          expectedOutput: {
            type: String,
            default: '',
          },
          hidden: {
            type: Boolean,
            default: false,
          },
          isSample: {
            type: Boolean,
            default: false,
          },
        },
      ],
      timeLimit: {
        type: Number,
        default: 2,
        min: 1,
      },
      memoryLimit: {
        type: Number,
        default: 128,
        min: 1,
      },
    },
    points: {
      type: Number,
      default: 1,
      min: 0,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
    },
    translations: {
      type: Map,
      of: {
        questionText: { type: String, trim: true },
        options: { type: mongoose.Schema.Types.Mixed },
        passage: { type: String, trim: true },
      },
      default: new Map(),
    },
  },
  {
    timestamps: true,
  }
);

const normalizeTrimmedString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const applyQuestionShape = (target) => {
  if (!target || typeof target !== 'object') return target;

  target.questionType = normalizeQuestionTypeForStorage(target);
  target.questionFormat = normalizeQuestionFormat(target) || undefined;
  const normalizedQuestionType = normalizeTrimmedString(target.questionType).toUpperCase();
  const normalizedQuestionFormat = normalizeTrimmedString(target.questionFormat).toUpperCase();
  const hasExplicitNonCodingSignal =
    (normalizedQuestionType && normalizedQuestionType !== 'CODING') ||
    (normalizedQuestionFormat && normalizedQuestionFormat !== 'CODING');
  const isCodingQuestion =
    normalizedQuestionType === 'CODING' ||
    (!hasExplicitNonCodingSignal && hasCodingConfiguration(target));
  const options = sanitizeQuestionOptions(target.options);

  const optionColumns = [
    sanitizeQuestionOptionText(target.optionA),
    sanitizeQuestionOptionText(target.optionB),
    sanitizeQuestionOptionText(target.optionC),
    sanitizeQuestionOptionText(target.optionD),
  ];
  const hasOptionColumns = optionColumns.some(Boolean);

  if (isCodingQuestion) {
    target.options = [];
    target.optionA = '';
    target.optionB = '';
    target.optionC = '';
    target.optionD = '';
  } else if (options.length > 0) {
    target.options = options;
    [target.optionA, target.optionB, target.optionC, target.optionD] = [
      options[0] || '',
      options[1] || '',
      options[2] || '',
      options[3] || '',
    ];
  } else if (hasOptionColumns) {
    target.options = sanitizeQuestionOptions(optionColumns.filter(Boolean));
    [target.optionA, target.optionB, target.optionC, target.optionD] = [
      target.options[0] || '',
      target.options[1] || '',
      target.options[2] || '',
      target.options[3] || '',
    ];
  } else if (normalizedQuestionType === 'TRUE_FALSE') {
    target.options = ['True', 'False'];
    target.optionA = 'True';
    target.optionB = 'False';
    target.optionC = '';
    target.optionD = '';
  }

  target.title = normalizeTrimmedString(target.title || (isCodingQuestion ? target.questionText : ''));
  target.description = normalizeTrimmedString(target.description);
  target.difficulty = isCodingQuestion
    ? normalizeCodingDifficulty(target.difficulty)
    : normalizeTrimmedString(target.difficulty);
  target.category = normalizeCodingCategory(target.category);
  target.questionText = normalizeTrimmedString(target.questionText || target.title);

  if (isCodingQuestion) {
    const codingFields = extractCodingFields(target);
    target.questionType = 'CODING';
    target.questionFormat = 'CODING';
    target.title = normalizeTrimmedString(target.title || target.questionText);
    target.questionText = normalizeTrimmedString(target.title || target.questionText);
    target.description = normalizeTrimmedString(target.description || target.passage);
    target.difficulty = normalizeCodingDifficulty(target.difficulty);
    target.category = normalizeCodingCategory(target.category);
    target.correctAnswer = '';
    target.passage = '';
    target.paragraphGroupId = '';
    target.codingFields = {
      languages: normalizeCodingLanguages(codingFields.languages),
      starterCode: codingFields.starterCode,
      testCases: codingFields.testCases,
      timeLimit: codingFields.timeLimit,
      memoryLimit: codingFields.memoryLimit,
    };
  } else {
    target.codingFields = undefined;
    const normalizedCorrectAnswer = normalizeQuestionCorrectAnswer({
      questionType: normalizedQuestionType,
      correctAnswer: target.correctAnswer,
      options: target.options,
    });
    target.correctAnswer =
      normalizedQuestionType === 'MULTIPLE_OPTIONS'
        ? (normalizedCorrectAnswer.length ? JSON.stringify(normalizedCorrectAnswer) : '')
        : normalizeTrimmedString(normalizedCorrectAnswer);
  }
  target.imageUrl = normalizeTrimmedString(target.imageUrl);
  target.imageBase64 = normalizeTrimmedString(target.imageBase64);
  target.generatedImage = normalizeTrimmedString(target.generatedImage);
  target.passage = normalizeTrimmedString(target.passage);
  target.paragraphGroupId = normalizeTrimmedString(target.paragraphGroupId);
  target.questionFormat = normalizeTrimmedString(target.questionFormat) || undefined;

  return target;
};

const applySerializedAliases = (ret) => {
  if (!ret || typeof ret !== 'object') return ret;

  const normalizedQuestionType = normalizeTrimmedString(ret.questionType).toUpperCase();
  const storedQuestionFormat = normalizeTrimmedString(ret.questionFormat).toUpperCase();
  const hasCodingFormatConflict =
    storedQuestionFormat === 'CODING' &&
    normalizedQuestionType &&
    normalizedQuestionType !== 'CODING';
  const optionColumns = [
    sanitizeQuestionOptionText(ret.optionA),
    sanitizeQuestionOptionText(ret.optionB),
    sanitizeQuestionOptionText(ret.optionC),
    sanitizeQuestionOptionText(ret.optionD),
  ].filter(Boolean);
  const options = sanitizeQuestionOptions(Array.isArray(ret.options) && ret.options.length ? ret.options : optionColumns);
  const normalizedCorrectAnswer = normalizeQuestionCorrectAnswer({
    questionType: normalizedQuestionType,
    correctAnswer: ret.correctAnswer,
    options,
  });
  const serializedImageUrl = normalizeTrimmedString(ret.imageUrl);
  const serializedImageBase64 = normalizeTrimmedString(ret.imageBase64);
  const serializedGeneratedImage = normalizeTrimmedString(ret.generatedImage);
  ret.options = options;
  ret.question_text = normalizeTrimmedString(ret.questionText);
  ret.question = normalizeTrimmedString(ret.questionText);
  ret.optionA = options[0] || '';
  ret.optionB = options[1] || '';
  ret.optionC = options[2] || '';
  ret.optionD = options[3] || '';
  ret.option_a = ret.optionA;
  ret.option_b = ret.optionB;
  ret.option_c = ret.optionC;
  ret.option_d = ret.optionD;
  ret.correctAnswer =
    normalizedQuestionType === 'MULTIPLE_OPTIONS'
      ? (normalizedCorrectAnswer.length ? JSON.stringify(normalizedCorrectAnswer) : '')
      : normalizeTrimmedString(normalizedCorrectAnswer);
  ret.correct_answer = ret.correctAnswer;
  ret.image_path = serializedImageUrl;
  ret.image_base64 = serializedImageBase64;
  ret.generated_image = serializedGeneratedImage;
  ret.image = serializedImageUrl || serializedGeneratedImage || serializedImageBase64;
  ret.paragraph_group_id = normalizeTrimmedString(ret.paragraphGroupId);
  ret.questionFormat =
    normalizeTrimmedString(
      hasCodingFormatConflict
        ? normalizeQuestionFormat({
            ...ret,
            questionFormat: '',
            question_type: '',
          })
        : storedQuestionFormat
    ) ||
    normalizeQuestionFormat(ret) ||
    '';
  ret.question_type = ret.questionFormat;
  ret.title = normalizeTrimmedString(ret.title || (normalizedQuestionType === 'CODING' ? ret.questionText : ''));
  ret.description = normalizeTrimmedString(ret.description);
  ret.difficulty =
    normalizedQuestionType === 'CODING'
      ? normalizeCodingDifficulty(ret.difficulty)
      : normalizeTrimmedString(ret.difficulty);
  ret.category = normalizeCodingCategory(ret.category);

  const shouldSerializeCodingPayload =
    normalizedQuestionType === 'CODING' ||
    (ret.question_type === 'CODING' &&
      (!normalizedQuestionType || normalizedQuestionType === 'CODING'));

  if (shouldSerializeCodingPayload) {
    const codingFields = extractCodingFields(ret);
    ret.difficulty = normalizeCodingDifficulty(ret.difficulty);
    ret.category = normalizeCodingCategory(ret.category);
    ret.languages = codingFields.languages;
    ret.starterCode = codingFields.starterCode;
    ret.testCases = codingFields.testCases;
    ret.timeLimit = codingFields.timeLimit;
    ret.memoryLimit = codingFields.memoryLimit;
    ret.options = [];
    ret.optionA = '';
    ret.optionB = '';
    ret.optionC = '';
    ret.optionD = '';
    ret.option_a = '';
    ret.option_b = '';
    ret.option_c = '';
    ret.option_d = '';
    ret.correctAnswer = '';
    ret.correct_answer = '';
  }

  return ret;
};

QuestionSchema.set('toJSON', {
  transform: (_doc, ret) => {
    return applySerializedAliases(ret);
  },
});

QuestionSchema.set('toObject', {
  transform: (_doc, ret) => {
    return applySerializedAliases(ret);
  },
});

// Generate uniqueId before validation
QuestionSchema.pre('validate', async function (next) {
  applyQuestionShape(this);
  if (!this.uniqueId) {
    try {
      this.uniqueId = await generateUniqueIdWithCheck(
        mongoose.model('Question'),
        ID_PREFIXES.QUESTION
      );
    } catch (error) {
      return next(error);
    }
  }
  next();
});

QuestionSchema.index({ uniqueId: 1 });
QuestionSchema.index({ questionPaperId: 1, order: 1 });
QuestionSchema.index({ sectionId: 1, order: 1 });

export default mongoose.model('Question', QuestionSchema);

