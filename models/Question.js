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
        'FILL_IN_THE_BLANK',
        'MATCHING',
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
        'FILL_IN_THE_BLANK',
        'MATCHING',
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
    // Cognitive demand (Blueprint section 4B) — independent of difficulty
    // above and bloomLevel below; never a synonym for either. Additive,
    // nullable: every pre-existing question has cognitiveDemand: null and
    // stays that way unless explicitly classified. Always resolved by the
    // application (utils/cognitiveDemand.js) from bloomLevel + the
    // applicable framework mapping — never trusted verbatim from an
    // AI-provided label — except when a human explicitly sets/overrides it
    // (manual authoring, import review, or a creator override the
    // framework permits).
    cognitiveDemand: {
      type: String,
      enum: ['LOT', 'MOT', 'HOT', null],
      default: null,
    },
    bloomLevel: {
      type: String,
      enum: ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE', null],
      default: null,
    },
    category: {
      type: String,
      trim: true,
      default: '',
    },
    options: {
      type: mongoose.Schema.Types.Mixed,
    },
    matchingPairs: {
      type: mongoose.Schema.Types.Mixed,
      default: [],
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
    // Choice / alternative semantics (Phase 1C). Additive & optional
    // (default undefined ⇒ every existing question is byte-for-byte
    // unaffected). Set only by import or manual authoring to record that a
    // set of questions are alternatives ("write on ANY ONE of the
    // following") rather than compulsory. Stage 1 stores this as metadata
    // only; it is not yet read by delivery or scoring.
    choiceGroup: {
      type: {
        groupId: { type: String, trim: true },
        kind: { type: String, enum: ['ALTERNATIVES'], default: 'ALTERNATIVES' },
        selectRequired: { type: Number, default: 1, min: 1 },
      },
      default: undefined,
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
    // Configuration used by the marking engine. It is deliberately stored with the
    // question so a published exam is graded against the rubric the author set.
    evaluationConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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
    // false only for a question generated into a sectioned exam's pool but
    // never assigned to a section ("Unassigned — Not included in exam").
    // Default true preserves every pre-existing question and every
    // no-section exam (where sectionId is legitimately always empty).
    isIncludedInExam: {
      type: Boolean,
      default: true,
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
    // Source-Grounded AI Question Generation — entirely optional/additive.
    // Absent on every pre-existing question, so existing rendering, export,
    // grading, and translation code paths are unaffected. Only populated for
    // questions accepted out of a generationMode: 'SOURCE_GROUNDED' run.
    // Internal/examiner-facing only — never exposed to candidates.
    provenance: {
      type: new mongoose.Schema(
        {
          generationRunId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AIGenerationRun',
            default: undefined,
          },
          // Set when this question was created via the Question Bank reuse
          // flow (Content & Question Bank -> "Add to this exam"). Always a
          // copy, never a shared/live reference — see docs on question-bank
          // reuse ownership decision.
          reusedFromQuestionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Question',
            default: undefined,
          },
          // Canonical Question Bank materialization (Part 5 convergence) —
          // set when this question was copied from an APPROVED
          // QuestionVersion rather than from another exam's delivered
          // Question. reusedFromQuestionId above remains valid compatibility
          // metadata for the legacy exam-to-exam copy path.
          questionBankItemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QuestionBankItem',
            default: undefined,
          },
          questionVersionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QuestionVersion',
            default: undefined,
          },
          sourceIds: {
            type: [mongoose.Schema.Types.ObjectId],
            ref: 'ContextSource',
            default: undefined,
          },
          chunkIds: {
            type: [mongoose.Schema.Types.ObjectId],
            ref: 'ContextChunk',
            default: undefined,
          },
          // Short excerpt for the "View source evidence" reviewer affordance
          // — never the full chunk text.
          evidenceSnippet: {
            type: String,
            trim: true,
            default: undefined,
          },
          noveltySignatures: {
            type: new mongoose.Schema(
              {
                exact: { type: String, default: undefined },
                near: { type: String, default: undefined },
                blueprint: { type: String, default: undefined },
              },
              { _id: false }
            ),
            default: undefined,
          },
          // --- Source-Verified Question Intelligence (additive) ---------------
          // Every field default:undefined ⇒ pre-existing questions are
          // byte-for-byte unaffected; the educator-facing labels below only
          // appear once these are populated by a new generation.
          generationMode: {
            // How this question came to exist. Drives the "Based on ..." label.
            type: String,
            enum: ['STANDARD', 'SOURCE_GROUNDED', 'MANUAL', 'QUESTION_BANK_REUSE', 'IMPORTED'],
            default: undefined,
          },
          sourcePolicy: {
            type: String,
            enum: ['STRICT_SOURCE', 'SELECTED_CONTEXT', 'AUTO_CONTEXT', 'NONE'],
            default: undefined,
          },
          // The creator's own instruction text at generation time — frozen so
          // history stays explainable ("Generated from creator instructions").
          creatorInstructionSnapshot: { type: String, trim: true, default: undefined },
          // The AI Engine operation id for this generation (audit / observability).
          generationOperationId: { type: String, trim: true, default: undefined },
          generatedAt: { type: Date, default: undefined },
          // CURRENT until a manual edit materially changes the factual basis;
          // AI Modify re-runs grounding verification and resets this.
          revalidationState: {
            type: String,
            enum: ['CURRENT', 'SOURCE_REFERENCE_NEEDS_REVALIDATION'],
            default: undefined,
          },
          // Overall grounding outcome recorded by the verifier at accept time.
          groundingVerdict: {
            type: String,
            enum: ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'NOT_APPLICABLE'],
            default: undefined,
          },
          // Frozen, educator-facing source references. Xamigo assigns every
          // value from persisted LibraryResource / ContextSource / ContextChunk
          // metadata — the AI provider never contributes any of these.
          sourceReferences: {
            type: [
              new mongoose.Schema(
                {
                  libraryResourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryResource', default: undefined },
                  contextSourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContextSource', default: undefined },
                  resourceTitleSnapshot: { type: String, trim: true, default: undefined },
                  resourceTypeSnapshot: { type: String, trim: true, default: undefined },
                  fileTitleSnapshot: { type: String, trim: true, default: undefined },
                  chapterSnapshot: { type: String, trim: true, default: undefined },
                  unitSnapshot: { type: String, trim: true, default: undefined },
                  topicSnapshot: { type: String, trim: true, default: undefined },
                  sectionTitleSnapshot: { type: String, trim: true, default: undefined },
                  // null when the parser did not expose page positions — never guessed.
                  pageStart: { type: Number, default: undefined },
                  pageEnd: { type: Number, default: undefined },
                  // Internal only — redacted from every API response by toProvenanceView().
                  evidenceChunkIdsInternal: { type: [mongoose.Schema.Types.ObjectId], ref: 'ContextChunk', default: undefined },
                  evidenceHash: { type: String, trim: true, default: undefined },
                  evidenceTextSnapshot: { type: String, trim: true, default: undefined },
                  relevanceScoreInternal: { type: Number, default: undefined },
                  usage: {
                    type: [String],
                    enum: ['QUESTION_CONCEPT', 'ANSWER_SUPPORT', 'SCENARIO_CONTEXT', 'IMAGE_CONTEXT'],
                    default: undefined,
                  },
                },
                { _id: false }
              ),
            ],
            default: undefined,
          },
        },
        { _id: false }
      ),
      default: undefined,
    },
    // Historical-question novelty backfill only (scripts/backfillHistoricalQuestionSignatures.js).
    // Kept separate from provenance.noveltySignatures so it's obvious in
    // review which signatures came from real generation-time grounding vs.
    // a lexical-only approximation computed after the fact for pre-existing
    // questions that have no source/chunk provenance to reconstruct.
    legacySignature: {
      type: String,
      default: undefined,
    },
    legacySignatureComputedAt: {
      type: Date,
      default: undefined,
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

QuestionSchema.index({ questionPaperId: 1, order: 1 });
QuestionSchema.index({ sectionId: 1, order: 1 });

export default mongoose.model('Question', QuestionSchema);
