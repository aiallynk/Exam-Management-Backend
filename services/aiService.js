import OpenAI from 'openai';
import config from '../config/env.js';
import { createGeneratedQuestionImage } from './questionImportImageService.js';
import { createTrackedChatCompletion, trackAIUsageEvent } from './aiTokenUsageService.js';
import {
  normalizeQuestionCorrectAnswer,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';
import { extractCodingFields, getSupportedCodingLanguages } from '../utils/codingQuestions.js';

const client = config.openaiApiKey
  ? new OpenAI({ apiKey: config.openaiApiKey })
  : null;
const OPENAI_MODEL = config.openaiModel || 'gpt-4o-mini';
const IMPORT_EXTRACTION_MODEL = 'gpt-4o-mini';
const MAX_IMPORT_AI_CHUNKS = 120;
const MAX_IMPORT_CHUNK_PREVIEW_LENGTH = 8000;
const MAX_PARALLEL_IMPORT_CHUNK_REQUESTS = 4;
const IMPORT_HEADER_LINE_REGEX =
  /^(?:quiz|name|date|section|instructions?)\b(?:\s*[:\-].*|[\s_]*$)/i;
const IMPORT_HEADER_BLOCK_HINT_REGEX = /\b(?:quiz|name|date|section)\b/i;
const IMPORT_NUMBERED_SPLIT_REGEX = /(?=\d+\.\s)/g;
const IMPORT_TRUE_FALSE_REGEX = /\b(?:true\s*(?:\/|\s+or\s+)\s*false|t\s*\/\s*f)\b/i;

const VALID_QUESTION_TYPES = [
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
];
const WRITING_QUESTION_TYPES = new Set(['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY']);

const IMAGE_BASED_GENERATION_MODES = new Set(['percentage', 'per_count']);
const VALID_IMAGE_QUESTION_TYPES = ['diagram', 'graph', 'chart', 'object_identification'];
const DEFAULT_IMAGE_QUESTION_TYPES = ['diagram'];
const MAX_PARALLEL_IMAGE_VARIANTS = 2;
const DEFAULT_IMAGE_QUESTIONS_PER_IMAGE = 1;
const DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH = 1;
const DEFAULT_CODING_LANGUAGES = ['python', 'javascript'];
const DEFAULT_CODING_STARTER_CODE = {
  python: 'def solve():\n    pass\n',
  java: 'public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n',
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    return 0;\n}\n',
  javascript: 'function solve(input) {\n  return input;\n}\n',
};
const QUESTION_SORTING_PATTERNS = new Set([
  'MIX_ALL',
  'GROUP_BY_TYPE',
  'ALTERNATING',
  'CUSTOM',
]);

const sanitizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeQuestionTypeToken = (value) => {
  const normalized = sanitizeString(value).toUpperCase();
  if (!normalized) return '';
  if (['MCQ', 'MULTIPLE CHOICE', 'SINGLE_CHOICE'].includes(normalized)) {
    return 'MULTIPLE_CHOICE';
  }
  if (['MULTI_SELECT_MCQ', 'MULTI_SELECT MCQ'].includes(normalized)) {
    return 'MULTIPLE_OPTIONS';
  }
  if (['MULTI_SELECT', 'MULTISELECT', 'MULTI_CHOICE'].includes(normalized)) {
    return 'MULTIPLE_OPTIONS';
  }
  if (['TRUEFALSE', 'TRUE_FALSE', 'TF', 'TRUE/FALSE'].includes(normalized)) {
    return 'TRUE_FALSE';
  }
  if (['SHORT', 'SHORTANSWER', 'SHORT_ANSWER'].includes(normalized)) {
    return 'SHORT_ANSWER';
  }
  if (['FILL_BLANK', 'FILL_IN_BLANK', 'FILLINTHEBLANK', 'FIB'].includes(normalized)) {
    return 'FILL_IN_THE_BLANK';
  }
  if (['MATCH', 'MATCH_THE_FOLLOWING', 'MATCHING_PAIRS'].includes(normalized)) {
    return 'MATCHING';
  }
  if (['LONG_ANSWER', 'LONGANSWER', 'DESCRIPTIVE', 'ESSAY'].includes(normalized)) {
    return 'ESSAY';
  }
  if (['ESSAY_LETTER', 'LETTER_WRITING', 'LETTER'].includes(normalized)) {
    return 'ESSAY_LETTER';
  }
  if (['ESSAY_STORY', 'STORY_WRITING', 'STORY'].includes(normalized)) {
    return 'ESSAY_STORY';
  }
  if (['IMAGE_BASED', 'IMAGE', 'IMAGE-BASED'].includes(normalized)) {
    return 'MULTIPLE_CHOICE';
  }
  if (['SCENARIO'].includes(normalized)) {
    return 'PARAGRAPH';
  }
  if (['NUMERIC'].includes(normalized)) {
    return 'NUMBER';
  }
  if (['CODE'].includes(normalized)) {
    return 'CODING';
  }
  return normalized;
};

const resolveTrackingContext = ({ tenantId = null, userId = null, metadata = null } = {}) => {
  const metadataTenantId =
    metadata?.tenantId || metadata?.tenant_id || metadata?.tenant?._id || null;
  const metadataUserId =
    metadata?.userId || metadata?.generatedBy || metadata?.user?._id || null;

  return {
    tenantId: tenantId || metadataTenantId || null,
    userId: userId || metadataUserId || null,
  };
};

const trackFallbackUsage = async ({
  feature,
  tenantId = null,
  userId = null,
  errorMessage = '',
}) =>
  trackAIUsageEvent({
    feature,
    tenantId,
    userId,
    model: 'unavailable',
    usageCount: 1,
    requestStatus: 'FAILED',
    errorMessage:
      errorMessage || 'AI request was handled by local fallback logic.',
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });

const parseMultiAnswer = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
      .filter(Boolean);
  }
  if (value === undefined || value === null) {
    return [];
  }
  const raw = String(value).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
        .filter(Boolean);
    }
  } catch (error) {
    // ignore JSON parse errors and fallback to delimiters
  }
  return raw
    .split(/[,;|\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeQuestionObject = (question, index = 0) => {
  if (!question || typeof question !== 'object') {
    return null;
  }

  const rawType = normalizeQuestionTypeToken(
    question.questionType || question.type || question.question_type
  );
  const resolvedType = rawType;
  const questionType = VALID_QUESTION_TYPES.includes(resolvedType) ? resolvedType : 'SHORT_ANSWER';
  const questionText = sanitizeString(
    question.questionText || question.title || question.question || question.text
  );
  if (!questionText) {
    return null;
  }

  const points = Number.isFinite(Number(question.points)) ? Number(question.points) : 1;

  if (questionType === 'CODING') {
    const codingFields = extractCodingFields(question);
    return {
      questionText,
      title: questionText,
      description: sanitizeString(
        question.description || question.problemStatement || question.prompt || question.details
      ),
      difficulty: sanitizeString(question.difficulty || 'medium') || 'medium',
      category: sanitizeString(question.category || codingFields.category),
      questionType,
      points,
      order: Number.isFinite(Number(question.order)) ? Number(question.order) : index,
      languages: codingFields.languages.length ? codingFields.languages : [...DEFAULT_CODING_LANGUAGES],
      starterCode: {
        ...DEFAULT_CODING_STARTER_CODE,
        ...codingFields.starterCode,
      },
      testCases: codingFields.testCases,
      timeLimit: codingFields.timeLimit,
      passage: '',
      paragraphGroupId: '',
      imageUrl: '',
    };
  }

  let options = Array.isArray(question.options)
    ? sanitizeQuestionOptions(question.options)
    : undefined;

  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType)) {
    if (!options || options.length === 0) {
      if (questionType === 'TRUE_FALSE') {
        options = ['True', 'False'];
      } else {
        options = ['Option A', 'Option B', 'Option C', 'Option D'];
      }
    }
  } else {
    options = undefined;
  }

  let correctAnswer;
  if (questionType === 'MULTIPLE_OPTIONS') {
    correctAnswer = normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: question.correctAnswer || question.answers || question.correctAnswers,
      options,
    });
  } else {
    correctAnswer = normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: question.correctAnswer || question.answer || question.correct_option || '',
      options,
    });
  }

  const passage = sanitizeString(
    question.passage ||
      question.context ||
      question.sourceText ||
      question.reference ||
      question.passageText ||
      question.reading ||
      ''
  );
  const matchingPairs = Array.isArray(question.matchingPairs || question.matching_pairs)
    ? (question.matchingPairs || question.matching_pairs)
        .map((pair) => ({
          left: sanitizeString(pair?.left || pair?.term || pair?.prompt),
          right: sanitizeString(pair?.right || pair?.match || pair?.answer),
        }))
        .filter((pair) => pair.left && pair.right)
    : [];
  const paragraphGroupId = sanitizeString(
    question.paragraphGroupId || question.paragraph_group_id || question.scenarioGroupId || ''
  );

  return {
    questionText,
    questionType,
    options,
    correctAnswer,
    points,
    order: Number.isFinite(Number(question.order)) ? Number(question.order) : index,
    passage,
    paragraphGroupId,
    imageUrl: sanitizeString(
      question.imageUrl || question.image_path || question.imagePath || question.diagram || question.figure || ''
    ),
    matchingPairs,
    sourceRowIndex: Number.isInteger(question.sourceRowIndex)
      ? question.sourceRowIndex
      : Number.isInteger(question._sourceRowIndex)
        ? question._sourceRowIndex
        : undefined,
  };
};

const parseCount = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const chunkArray = (values = [], size = 1) => {
  const safeSize = Math.max(1, Number.isFinite(Number(size)) ? Number(size) : 1);
  const chunks = [];
  for (let index = 0; index < values.length; index += safeSize) {
    chunks.push(values.slice(index, index + safeSize));
  }
  return chunks;
};

const normalizeImageQuestionTypes = (value) => {
  const requestedTypes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;|\n]/)
      : [];

  const normalized = requestedTypes
    .map((item) => sanitizeString(item).toLowerCase())
    .filter((item, index, items) => VALID_IMAGE_QUESTION_TYPES.includes(item) && items.indexOf(item) === index);

  return normalized.length ? normalized : [...DEFAULT_IMAGE_QUESTION_TYPES];
};

const parseJsonObjectContent = (responseContent) => {
  if (typeof responseContent !== 'string') return null;

  try {
    const parsed = JSON.parse(responseContent);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
};

const normalizeQuestionsPerParagraph = (value, fallback = DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH, max = 50) =>
  clampNumber(parseCount(value, fallback), 1, Math.max(1, max));

const createParagraphGroupId = (groupIndex = 0) =>
  `paragraph-${Date.now().toString(36)}-${groupIndex + 1}-${Math.random().toString(36).slice(2, 8)}`;

const flattenGroupedQuestionContainers = (groupEntries = [], options = {}) => {
  const { fallbackFormat = 'PARAGRAPH' } = options;
  const safeEntries = Array.isArray(groupEntries) ? groupEntries : [];
  const flattenedQuestions = [];

  safeEntries.forEach((groupEntry, groupIndex) => {
    if (!groupEntry || typeof groupEntry !== 'object') return;

    const sharedPassage = sanitizeString(
      groupEntry.passage ||
        groupEntry.context ||
        groupEntry.paragraph ||
        groupEntry.scenario ||
        groupEntry.text
    );
    const sharedGroupId =
      sanitizeString(
        groupEntry.paragraphGroupId ||
          groupEntry.paragraph_group_id ||
          groupEntry.groupId ||
          groupEntry.id
      ) || createParagraphGroupId(groupIndex);
    const groupFormatRaw = sanitizeString(
      groupEntry.questionFormat || groupEntry.question_type || groupEntry.type || fallbackFormat
    ).toUpperCase();
    const groupFormat = groupFormatRaw === 'SCENARIO' ? 'SCENARIO' : 'PARAGRAPH';
    const safeQuestions = Array.isArray(groupEntry.questions) ? groupEntry.questions : [];

    safeQuestions.forEach((questionEntry, localIndex) => {
      if (!questionEntry || typeof questionEntry !== 'object') return;
      flattenedQuestions.push({
        ...questionEntry,
        passage: sanitizeString(questionEntry.passage || questionEntry.context || sharedPassage),
        paragraphGroupId: sanitizeString(
          questionEntry.paragraphGroupId || questionEntry.paragraph_group_id || sharedGroupId
        ),
        questionFormat: sanitizeString(
          questionEntry.questionFormat || questionEntry.question_type || groupFormat
        ),
        question_type: sanitizeString(
          questionEntry.question_type || questionEntry.questionFormat || groupFormat
        ),
        order:
          Number.isFinite(Number(questionEntry.order))
            ? Number(questionEntry.order)
            : Number(groupEntry.order) + localIndex || localIndex + 1,
      });
    });
  });

  return flattenedQuestions;
};

const extractQuestionsFromAiResponse = (parsedResponse) => {
  if (Array.isArray(parsedResponse)) {
    return parsedResponse;
  }

  if (!parsedResponse || typeof parsedResponse !== 'object') {
    return [];
  }

  const topLevelSharedPassage = sanitizeString(
    parsedResponse.passage ||
      parsedResponse.context ||
      parsedResponse.paragraph ||
      parsedResponse.scenario
  );
  if (Array.isArray(parsedResponse.questions) && topLevelSharedPassage) {
    return flattenGroupedQuestionContainers([parsedResponse], {
      fallbackFormat: sanitizeString(parsedResponse.type || parsedResponse.questionFormat || 'PARAGRAPH'),
    });
  }

  if (Array.isArray(parsedResponse.questions)) {
    const mixedQuestions = [];
    parsedResponse.questions.forEach((entry) => {
      if (
        entry &&
        typeof entry === 'object' &&
        Array.isArray(entry.questions) &&
        !sanitizeString(entry.questionText || entry.question || entry.title)
      ) {
        mixedQuestions.push(
          ...flattenGroupedQuestionContainers([entry], {
            fallbackFormat: sanitizeString(entry.type || entry.questionFormat || 'PARAGRAPH'),
          })
        );
      } else {
        mixedQuestions.push(entry);
      }
    });
    return mixedQuestions;
  }

  if (Array.isArray(parsedResponse.data)) {
    return parsedResponse.data;
  }

  const groupedKeys = ['groups', 'scenarios', 'paragraphs', 'passages', 'sections'];
  for (const key of groupedKeys) {
    if (Array.isArray(parsedResponse[key])) {
      const fallbackFormat = key === 'scenarios' ? 'SCENARIO' : 'PARAGRAPH';
      return flattenGroupedQuestionContainers(parsedResponse[key], { fallbackFormat });
    }
  }

  return [];
};

const normalizeImageQuestionConfig = ({
  enableImageQuestions,
  imageQuestionCount,
  imageQuestionRatio,
  imageQuestionPerCount,
  imageQuestionsPerImage,
  imageQuestionMode,
  imageQuestionTypes,
  count,
}) => {
  const totalQuestions = Math.max(1, parseCount(count, 5));
  const requestedCount = clampNumber(parseCount(imageQuestionCount, 0), 0, totalQuestions);
  const normalizedMode = IMAGE_BASED_GENERATION_MODES.has(sanitizeString(imageQuestionMode))
    ? sanitizeString(imageQuestionMode)
    : 'percentage';
  const ratioPercent = clampNumber(Number.parseFloat(imageQuestionRatio) || 0, 0, 100);
  const perCount = clampNumber(parseCount(imageQuestionPerCount, 5), 1, totalQuestions);
  const questionsPerImage = clampNumber(
    parseCount(imageQuestionsPerImage, DEFAULT_IMAGE_QUESTIONS_PER_IMAGE),
    1,
    totalQuestions
  );
  const enabled = enableImageQuestions === true || requestedCount > 0;

  let resolvedCount = requestedCount;
  if (!resolvedCount && enabled) {
    if (normalizedMode === 'per_count') {
      resolvedCount = Math.floor(totalQuestions / Math.max(perCount, 1));
    } else {
      resolvedCount = Math.round((totalQuestions * ratioPercent) / 100);
    }
  }

  resolvedCount = clampNumber(resolvedCount, 0, totalQuestions);

  return {
    enabled: enabled && resolvedCount > 0,
    count: resolvedCount,
    mode: normalizedMode,
    ratioPercent,
    perCount,
    questionsPerImage,
    imageTypes: normalizeImageQuestionTypes(imageQuestionTypes),
  };
};

const normalizeRequestedQuestionTypes = (questionTypes) =>
  (Array.isArray(questionTypes) ? questionTypes : [])
    .map((type) => normalizeQuestionTypeToken(type))
    .filter((type, index, items) => VALID_QUESTION_TYPES.includes(type) && items.indexOf(type) === index);

const normalizeScenarioQuestionTypes = (questionTypes) => {
  const normalized = normalizeRequestedQuestionTypes(questionTypes);
  return normalized.length ? normalized : ['PARAGRAPH'];
};

const shuffleArray = (values = []) => {
  const items = [...values];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

const normalizeQuestionSorting = (value) =>
  QUESTION_SORTING_PATTERNS.has(sanitizeString(value).toUpperCase())
    ? sanitizeString(value).toUpperCase()
    : 'MIX_ALL';

const normalizeSortPattern = (value, allowedTypes = []) => {
  const allowed = new Set(allowedTypes);
  const raw = Array.isArray(value) ? value : [];
  const pattern = raw
    .map((type) => normalizeQuestionTypeToken(type))
    .filter((type) => allowed.has(type));
  return pattern.length ? pattern : [...allowed];
};

const applyQuestionSorting = ({
  questions = [],
  questionSorting = 'MIX_ALL',
  questionSortPattern = [],
  questionTypes = [],
} = {}) => {
  const safeQuestions = Array.isArray(questions) ? [...questions] : [];
  const sorting = normalizeQuestionSorting(questionSorting);
  const allowedTypes = normalizeRequestedQuestionTypes(questionTypes);

  if (sorting === 'MIX_ALL') {
    return shuffleArray(safeQuestions).map((question, index) => ({ ...question, order: index + 1 }));
  }

  const order = normalizeSortPattern(questionSortPattern, allowedTypes);
  const rank = new Map(order.map((type, index) => [type, index]));
  if (sorting === 'GROUP_BY_TYPE') {
    return safeQuestions
      .map((question, index) => ({ question, index }))
      .sort((left, right) => {
        const leftType = normalizeQuestionTypeToken(left.question?.questionType);
        const rightType = normalizeQuestionTypeToken(right.question?.questionType);
        return (rank.get(leftType) ?? order.length) - (rank.get(rightType) ?? order.length) || left.index - right.index;
      })
      .map(({ question }, index) => ({ ...question, order: index + 1 }));
  }

  const queues = new Map();
  safeQuestions.forEach((question) => {
    const type = normalizeQuestionTypeToken(question?.questionType);
    if (!queues.has(type)) queues.set(type, []);
    queues.get(type).push(question);
  });
  const result = [];
  while (result.length < safeQuestions.length) {
    let added = false;
    order.forEach((type) => {
      const next = queues.get(type)?.shift();
      if (next) {
        result.push(next);
        added = true;
      }
    });
    if (!added) {
      queues.forEach((queue) => {
        while (queue.length) result.push(queue.shift());
      });
    }
  }
  return result.map((question, index) => ({ ...question, order: index + 1 }));
};

const pickRandomIndexes = (total, count) =>
  shuffleArray(Array.from({ length: Math.max(0, total) }, (_, index) => index))
    .slice(0, Math.max(0, count))
    .sort((left, right) => left - right);

const pickRandomImageType = (imageTypes = []) => {
  const safeTypes = normalizeImageQuestionTypes(imageTypes);
  return safeTypes[Math.floor(Math.random() * safeTypes.length)] || 'diagram';
};

const buildFallbackImagePrompt = ({ topic, questionText, imageType }) => {
  const safeTopic = sanitizeString(topic) || 'the topic';
  const safeQuestionText = sanitizeString(questionText) || `an assessment question about ${safeTopic}`;

  if (imageType === 'graph') {
    return `Create a clean educational graph that supports this exam question about ${safeTopic}: ${safeQuestionText}`;
  }
  if (imageType === 'chart') {
    return `Create a clean educational chart that supports this exam question about ${safeTopic}: ${safeQuestionText}`;
  }
  if (imageType === 'object_identification') {
    return `Create a clear, realistic educational object image for identification that supports this exam question about ${safeTopic}: ${safeQuestionText}`;
  }
  return `Create a clean educational diagram that supports this exam question about ${safeTopic}: ${safeQuestionText}`;
};

const buildSharedFallbackImagePrompt = ({ topic, questions, imageType }) => {
  const safeTopic = sanitizeString(topic) || 'the topic';
  const safeQuestions = (Array.isArray(questions) ? questions : [])
    .map((question) => sanitizeString(question?.questionText))
    .filter(Boolean)
    .slice(0, 5);
  const context = safeQuestions.join(' | ') || `related exam questions about ${safeTopic}`;

  if (imageType === 'graph') {
    return `Create one clear educational graph about ${safeTopic} that supports these related exam questions: ${context}`;
  }
  if (imageType === 'chart') {
    return `Create one clear educational chart about ${safeTopic} that supports these related exam questions: ${context}`;
  }
  if (imageType === 'object_identification') {
    return `Create one clear realistic educational object image about ${safeTopic} that supports these related exam questions: ${context}`;
  }
  return `Create one clear educational diagram about ${safeTopic} that supports these related exam questions: ${context}`;
};

const buildQuestionTypeDistribution = ({ questionTypes, questionTypeDistribution, count }) => {
  const safeTypes = Array.isArray(questionTypes)
    ? questionTypes
      .map((type) => sanitizeString(type).toUpperCase())
      .filter((type) => VALID_QUESTION_TYPES.includes(type))
    : [];

  const safeCount = Math.max(1, parseCount(count, 5));

  if (!safeTypes.length) {
    return [{ type: 'MULTIPLE_CHOICE', count: safeCount }];
  }

  const distributionMap = {};
  safeTypes.forEach((type) => {
    distributionMap[type] = 0;
  });

  if (Array.isArray(questionTypeDistribution) && questionTypeDistribution.length > 0) {
    questionTypeDistribution.forEach((item) => {
      const type = sanitizeString(item?.type).toUpperCase();
      const typeCount = Math.max(0, parseCount(item?.count, 0));
      if (safeTypes.includes(type)) {
        distributionMap[type] += typeCount;
      }
    });
  }

  let total = safeTypes.reduce((sum, type) => sum + distributionMap[type], 0);

  if (total <= 0) {
    const perType = Math.floor(safeCount / safeTypes.length);
    const remainder = safeCount % safeTypes.length;
    safeTypes.forEach((type, idx) => {
      distributionMap[type] = perType + (idx < remainder ? 1 : 0);
    });
    total = safeCount;
  }

  if (total !== safeCount) {
    if (total < safeCount) {
      distributionMap[safeTypes[0]] += safeCount - total;
    } else {
      let overflow = total - safeCount;
      const orderedTypes = [...safeTypes].sort((a, b) => distributionMap[b] - distributionMap[a]);
      for (const type of orderedTypes) {
        if (overflow <= 0) break;
        const removable = Math.min(distributionMap[type], overflow);
        distributionMap[type] -= removable;
        overflow -= removable;
      }

      if (overflow > 0) {
        const perType = Math.floor(safeCount / safeTypes.length);
        const remainder = safeCount % safeTypes.length;
        safeTypes.forEach((type, idx) => {
          distributionMap[type] = perType + (idx < remainder ? 1 : 0);
        });
      }
    }
  }

  const distribution = safeTypes
    .map((type) => ({ type, count: Math.max(0, distributionMap[type] || 0) }))
    .filter((item) => item.count > 0);

  if (!distribution.length) {
    return [{ type: safeTypes[0], count: safeCount }];
  }

  const finalTotal = distribution.reduce((sum, item) => sum + item.count, 0);
  if (finalTotal !== safeCount) {
    distribution[0].count += safeCount - finalTotal;
  }

  return distribution;
};

const buildFallbackQuestionForType = ({ type, index, topic }) => {
  const safeType = VALID_QUESTION_TYPES.includes(type) ? type : 'SHORT_ANSWER';
  const safeTopic = sanitizeString(topic) || 'the topic';
  const typeLabel = safeType.replace(/_/g, ' ').toLowerCase();
  const baseQuestionText = `Sample ${typeLabel} question ${index + 1} about ${safeTopic}?`;

  if (safeType === 'TRUE_FALSE') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: ['True', 'False'],
      correctAnswer: 'True',
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'MULTIPLE_CHOICE') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctAnswer: 'Option A',
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'MULTIPLE_OPTIONS') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctAnswer: ['Option A'],
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'NUMBER') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: undefined,
      correctAnswer: '0',
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'FILL_IN_THE_BLANK') {
    return {
      questionText: `Complete the blank: ${safeTopic} is an important concept in _____.`,
      questionType: safeType,
      options: undefined,
      correctAnswer: safeTopic,
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'MATCHING') {
    const matchingPairs = [
      { left: `${safeTopic} term 1`, right: 'Definition 1' },
      { left: `${safeTopic} term 2`, right: 'Definition 2' },
      { left: `${safeTopic} term 3`, right: 'Definition 3' },
    ];
    return {
      questionText: `Match the following items related to ${safeTopic}.`,
      questionType: safeType,
      options: undefined,
      matchingPairs,
      correctAnswer: JSON.stringify(matchingPairs),
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'PARAGRAPH') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: undefined,
      correctAnswer: 'Refer to passage',
      points: 1,
      order: index + 1,
      passage: `Read the following passage about ${safeTopic} and answer the question.`,
    };
  }

  if (safeType === 'ESSAY') {
    return {
      questionText: `Write an essay on ${safeTopic}.`,
      questionType: safeType,
      options: undefined,
      correctAnswer: `A well-structured essay covering the core ideas of ${safeTopic}.`,
      instructions:
        'Write with a clear introduction, well-developed body paragraphs, and a concise conclusion.',
      points: 10,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'ESSAY_LETTER') {
    return {
      questionText: `Write a formal letter related to ${safeTopic}.`,
      questionType: safeType,
      options: undefined,
      correctAnswer:
        'A properly formatted letter with suitable salutation, body, closing, and context-relevant content.',
      instructions:
        'Use formal letter format, appropriate tone, and include all required communication details.',
      points: 10,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'ESSAY_STORY') {
    return {
      questionText: `Write a creative story inspired by ${safeTopic}.`,
      questionType: safeType,
      options: undefined,
      correctAnswer:
        'An original, coherent story with engaging narrative flow, relevant theme, and meaningful ending.',
      instructions:
        'Focus on creativity, coherence, and narrative flow with a clear beginning, middle, and end.',
      points: 10,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'CODING') {
    return {
      questionText: `Coding challenge ${index + 1}: Solve a ${sanitizeString(topic) || 'programming'} task`,
      title: `Coding challenge ${index + 1}`,
      description: `Write a program related to ${sanitizeString(topic) || 'the topic'} and print the expected output.`,
      difficulty: 'medium',
      category: 'General Programming',
      questionType: safeType,
      options: undefined,
      correctAnswer: '',
      points: 1,
      order: index + 1,
      languages: [...DEFAULT_CODING_LANGUAGES],
      starterCode: { ...DEFAULT_CODING_STARTER_CODE },
      testCases: [
        {
          input: 'sample input',
          expectedOutput: 'sample output',
          hidden: false,
          isSample: true,
        },
      ],
      timeLimit: 2,
      passage: '',
    };
  }

  return {
    questionText: baseQuestionText,
    questionType: safeType,
    options: undefined,
    correctAnswer: 'Sample answer',
    points: 1,
    order: index + 1,
    passage: '',
  };
};

const normalizeToRequestedType = ({ question, type, index, topic }) => {
  const fallback = buildFallbackQuestionForType({ type, index, topic });
  const source = question && typeof question === 'object' ? question : fallback;
  const normalized =
    normalizeQuestionObject({ ...source, questionType: type }, index + 1) ||
    normalizeQuestionObject(fallback, index + 1) ||
    fallback;

  const questionText = sanitizeString(normalized.questionText) || fallback.questionText;
  const points = Number.isFinite(Number(normalized.points)) ? Number(normalized.points) : 1;
  const paragraphGroupId = sanitizeString(
    normalized.paragraphGroupId || source?.paragraphGroupId || source?.paragraph_group_id || ''
  );
  const scenarioPassage = sanitizeString(normalized.passage || source?.passage || source?.context || '');
  const attachScenarioContext = (questionData, fallbackPassage = '') => ({
    ...questionData,
    passage: scenarioPassage || fallbackPassage || '',
    ...(paragraphGroupId ? { paragraphGroupId } : {}),
  });

  if (type === 'MULTIPLE_CHOICE') {
    const options = Array.isArray(normalized.options) && normalized.options.length
      ? normalized.options
      : ['Option A', 'Option B', 'Option C', 'Option D'];
    const answer = sanitizeString(normalized.correctAnswer);
    const correctAnswer = options.includes(answer) ? answer : options[0];
    return attachScenarioContext({
      questionText,
      questionType: type,
      options,
      correctAnswer,
      points,
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'MULTIPLE_OPTIONS') {
    const options = Array.isArray(normalized.options) && normalized.options.length
      ? normalized.options
      : ['Option A', 'Option B', 'Option C', 'Option D'];
    const answers = parseMultiAnswer(normalized.correctAnswer).filter((ans) => options.includes(ans));
    return attachScenarioContext({
      questionText,
      questionType: type,
      options,
      correctAnswer: answers.length ? answers : [options[0]],
      points,
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'TRUE_FALSE') {
    const answer = sanitizeString(normalized.correctAnswer).toLowerCase();
    return attachScenarioContext({
      questionText,
      questionType: type,
      options: ['True', 'False'],
      correctAnswer: answer.startsWith('f') ? 'False' : 'True',
      points,
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'NUMBER') {
    const answer = sanitizeString(normalized.correctAnswer);
    return attachScenarioContext({
      questionText,
      questionType: type,
      options: undefined,
      correctAnswer: answer || '0',
      points,
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'FILL_IN_THE_BLANK') {
    return attachScenarioContext({
      questionText,
      questionType: type,
      options: undefined,
      correctAnswer: sanitizeString(normalized.correctAnswer) || sanitizeString(fallback.correctAnswer),
      points,
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'MATCHING') {
    const matchingPairs = Array.isArray(normalized.matchingPairs) && normalized.matchingPairs.length
      ? normalized.matchingPairs
      : fallback.matchingPairs;
    return attachScenarioContext({
      questionText,
      questionType: type,
      options: undefined,
      matchingPairs,
      correctAnswer: JSON.stringify(matchingPairs),
      points,
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'PARAGRAPH') {
    const answer = sanitizeString(normalized.correctAnswer) || 'Refer to passage';
    const passage = sanitizeString(normalized.passage) || fallback.passage;
    return attachScenarioContext({
      questionText,
      questionType: type,
      options: undefined,
      correctAnswer: answer,
      points,
      order: index + 1,
      passage,
    }, passage);
  }

  if (WRITING_QUESTION_TYPES.has(type)) {
    const answer = sanitizeString(normalized.correctAnswer) || sanitizeString(fallback.correctAnswer);
    const instructions = sanitizeString(normalized.instructions) || sanitizeString(fallback.instructions);
    return attachScenarioContext({
      questionText,
      questionType: type,
      options: undefined,
      correctAnswer: answer,
      instructions,
      points: Number.isFinite(Number(normalized.points)) ? Number(normalized.points) : Math.max(points, 1),
      order: index + 1,
      passage: '',
    });
  }

  if (type === 'CODING') {
    const fallbackCoding = buildFallbackQuestionForType({ type, index, topic });
    const codingFields = extractCodingFields(normalized);
    return {
      questionText,
      title: sanitizeString(normalized.title) || questionText,
      description: sanitizeString(normalized.description) || fallbackCoding.description,
      difficulty: sanitizeString(normalized.difficulty) || 'medium',
      category: sanitizeString(normalized.category || fallbackCoding.category),
      questionType: type,
      questionFormat: 'CODING',
      options: undefined,
      correctAnswer: '',
      points,
      order: index + 1,
      languages: codingFields.languages.length ? codingFields.languages : fallbackCoding.languages,
      starterCode: {
        ...fallbackCoding.starterCode,
        ...codingFields.starterCode,
      },
      testCases: codingFields.testCases.length ? codingFields.testCases : fallbackCoding.testCases,
      timeLimit: codingFields.timeLimit || fallbackCoding.timeLimit,
      passage: '',
    };
  }

  return attachScenarioContext({
    questionText,
    questionType: 'SHORT_ANSWER',
    options: undefined,
    correctAnswer: sanitizeString(normalized.correctAnswer) || 'Sample answer',
    points,
    order: index + 1,
    passage: '',
  });
};

const enforceQuestionDistribution = ({ questions, typeDistribution, count, topic }) => {
  const safeDistribution = Array.isArray(typeDistribution)
    ? typeDistribution
      .map((item) => ({
        type: sanitizeString(item?.type).toUpperCase(),
        count: Math.max(0, parseCount(item?.count, 0)),
      }))
      .filter((item) => VALID_QUESTION_TYPES.includes(item.type) && item.count > 0)
    : [];

  const safeCount = Math.max(1, parseCount(count, 5));
  if (!safeDistribution.length) {
    return Array.from({ length: safeCount }, (_, idx) =>
      buildFallbackQuestionForType({ type: 'MULTIPLE_CHOICE', index: idx, topic })
    );
  }

  const targetByType = {};
  const poolsByType = {};
  safeDistribution.forEach(({ type, count: typeCount }) => {
    targetByType[type] = typeCount;
    poolsByType[type] = [];
  });

  const overflowPool = [];
  (Array.isArray(questions) ? questions : []).forEach((question, index) => {
    const normalized = normalizeQuestionObject(question, index + 1);
    if (!normalized) return;
    const type = sanitizeString(normalized.questionType).toUpperCase();
    if (!targetByType[type]) {
      overflowPool.push(normalized);
      return;
    }
    if (poolsByType[type].length < targetByType[type]) {
      poolsByType[type].push(normalized);
    } else {
      overflowPool.push(normalized);
    }
  });

  const result = [];
  safeDistribution.forEach(({ type, count: targetCount }) => {
    for (let i = 0; i < targetCount; i += 1) {
      let candidate = poolsByType[type].shift();
      if (!candidate && overflowPool.length > 0) {
        candidate = overflowPool.shift();
      }
      result.push(
        normalizeToRequestedType({
          question: candidate,
          type,
          index: result.length,
          topic,
        })
      );
    }
  });

  while (result.length < safeCount) {
    result.push(
      normalizeToRequestedType({
        question: null,
        type: safeDistribution[0].type,
        index: result.length,
        topic,
      })
    );
  }

  return result
    .slice(0, safeCount)
    .map((question, index) => ({ ...question, order: index + 1 }));
};

const buildFallbackParagraphScenarioGroups = ({
  questions,
  groupIndexes,
  topic,
  scenarioQuestionTypes,
}) => {
  const safeQuestions = Array.isArray(questions) ? questions : [];
  const safeGroupIndexes = Array.isArray(groupIndexes) ? groupIndexes : [];
  const safeTopic = sanitizeString(topic) || 'the topic';
  const safeScenarioQuestionTypes = normalizeScenarioQuestionTypes(scenarioQuestionTypes);
  let scenarioQuestionCursor = 0;

  return safeGroupIndexes.map((indexes, groupIndex) => {
    const groupId = createParagraphGroupId(groupIndex);
    const baseQuestions = (Array.isArray(indexes) ? indexes : []).map((questionIndex) => {
      const targetType = safeScenarioQuestionTypes[scenarioQuestionCursor % safeScenarioQuestionTypes.length];
      scenarioQuestionCursor += 1;

      return normalizeToRequestedType({
        question: safeQuestions[questionIndex],
        type: targetType,
        index: questionIndex,
        topic: safeTopic,
      });
    });
    const focusPoints = baseQuestions
      .map((question) => sanitizeString(question?.questionText).replace(/[?!.]+$/g, ''))
      .filter(Boolean)
      .slice(0, 3);
    const scenarioSummary = focusPoints.length
      ? `It focuses on ${focusPoints.join('; ')}.`
      : `It presents a realistic case study related to ${safeTopic}.`;
    const passage = `Scenario ${groupIndex + 1}: Consider the following case study about ${safeTopic}. ${scenarioSummary} Use this scenario to answer the related questions.`;

    return {
      groupId,
      passage,
      questions: baseQuestions.map((question, localIndex) => ({
        ...question,
        questionText:
          sanitizeString(question?.questionText) ||
          `Based on the scenario, answer question ${localIndex + 1} about ${safeTopic}.`,
        correctAnswer:
          question?.questionType === 'MULTIPLE_OPTIONS'
            ? (() => {
                const answers = parseMultiAnswer(question?.correctAnswer);
                if (answers.length) return answers;
                const fallbackOption = Array.isArray(question?.options) && question.options.length
                  ? question.options[0]
                  : 'Option A';
                return [fallbackOption];
              })()
            : sanitizeString(question?.correctAnswer) ||
              `Reference response for Scenario ${groupIndex + 1}, Question ${localIndex + 1}.`,
        passage,
        paragraphGroupId: groupId,
      })),
    };
  });
};

const applyParagraphScenarioGroups = ({ questions, groupIndexes, groups, topic }) => {
  const safeQuestions = Array.isArray(questions) ? [...questions] : [];
  const safeGroupIndexes = Array.isArray(groupIndexes) ? groupIndexes : [];
  const safeGroups = Array.isArray(groups) ? groups : [];

  safeGroupIndexes.forEach((indexes, groupIndex) => {
    const group = safeGroups[groupIndex];
    if (!group || !Array.isArray(group.questions)) return;

    indexes.forEach((questionIndex, localIndex) => {
      const targetType = sanitizeString(
        group.questions?.[localIndex]?.questionType || safeQuestions[questionIndex]?.questionType || 'PARAGRAPH'
      ).toUpperCase();
      const normalizedTargetType = VALID_QUESTION_TYPES.includes(targetType) ? targetType : 'PARAGRAPH';

      const normalizedQuestion = normalizeToRequestedType({
        question: {
          ...(safeQuestions[questionIndex] || {}),
          ...(group.questions[localIndex] || {}),
          questionType: normalizedTargetType,
          passage: sanitizeString(group?.passage || group.questions?.[localIndex]?.passage),
          paragraphGroupId: sanitizeString(group?.groupId || group.questions?.[localIndex]?.paragraphGroupId),
        },
        type: normalizedTargetType,
        index: questionIndex,
        topic,
      });

      safeQuestions[questionIndex] = {
        ...(safeQuestions[questionIndex] || {}),
        ...normalizedQuestion,
        passage: sanitizeString(group?.passage || normalizedQuestion?.passage),
        paragraphGroupId: sanitizeString(
          group?.groupId || normalizedQuestion?.paragraphGroupId || group.questions?.[localIndex]?.paragraphGroupId
        ),
        order: questionIndex + 1,
      };
    });
  });

  return safeQuestions.map((question, index) => ({ ...question, order: index + 1 }));
};

const enhanceParagraphScenarioQuestions = async ({
  questions,
  questionsPerParagraph = DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH,
  scenarioQuestionTypes = ['PARAGRAPH'],
  topic,
  difficulty,
  uploadedContent,
  examTitle,
  examDescription,
  existingQuestions = [],
  tenantId = null,
  userId = null,
}) => {
  const safeQuestions = Array.isArray(questions) ? [...questions] : [];
  const paragraphIndexes = safeQuestions.reduce((indexes, question, index) => {
    if (sanitizeString(question?.questionType).toUpperCase() === 'PARAGRAPH') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (!paragraphIndexes.length) {
    return safeQuestions.map((question, index) => ({ ...question, order: index + 1 }));
  }

  const normalizedQuestionsPerParagraph = normalizeQuestionsPerParagraph(
    questionsPerParagraph,
    DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH,
    paragraphIndexes.length
  );
  const normalizedScenarioQuestionTypes = normalizeScenarioQuestionTypes(scenarioQuestionTypes);
  const groupIndexes = chunkArray(paragraphIndexes, normalizedQuestionsPerParagraph);
  const fallbackGroups = buildFallbackParagraphScenarioGroups({
    questions: safeQuestions,
    groupIndexes,
    topic,
    scenarioQuestionTypes: normalizedScenarioQuestionTypes,
  });

  if (!client) {
    return applyParagraphScenarioGroups({
      questions: safeQuestions,
      groupIndexes,
      groups: fallbackGroups,
      topic,
    });
  }

  const groupBlueprint = groupIndexes.map((indexes, groupIndex) => ({
    groupNumber: groupIndex + 1,
    questionCount: indexes.length,
    baseQuestions: fallbackGroups[groupIndex].questions.map((question) => ({
      targetQuestionType: sanitizeString(question?.questionType).toUpperCase() || 'PARAGRAPH',
      questionText: question.questionText,
      referenceAnswer:
        sanitizeString(question?.questionType).toUpperCase() === 'MULTIPLE_OPTIONS'
          ? parseMultiAnswer(question.correctAnswer)
          : question.correctAnswer,
      points: question.points || 1,
    })),
  }));
  const uploadedExcerpt = sanitizeString(uploadedContent).slice(0, 1500);
  const existingQuestionsText = Array.isArray(existingQuestions) && existingQuestions.length > 0
    ? existingQuestions
      .slice(0, 40)
      .map((question, index) => `${index + 1}. ${sanitizeString(question).slice(0, 220)}`)
      .filter(Boolean)
      .join('\n')
    : '';

  try {
    const completion = await createTrackedChatCompletion({
      client,
      feature: 'question_generation',
      tenantId,
      userId,
      request: {
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: `You create shared scenario-based exam question groups.

Return JSON with:
- groups: an array of exactly ${groupBlueprint.length} scenario groups in the SAME ORDER as the input groups

Each group must include:
- passage: one shared scenario/case-study paragraph
- questions: an array of exactly the required number of question objects for that group

Each question object must include:
- questionType
- questionText
- options
- correctAnswer
- points

Rules:
- All questions inside a group must depend only on that group's shared passage
- Each questionType must EXACTLY match the requested targetQuestionType for that slot
- Group question counts must match the requested counts exactly
- Keep the questions aligned with the base question intents and requested difficulty
- For MULTIPLE_CHOICE, provide 4 plausible options and make correctAnswer match one option exactly
- For MULTIPLE_OPTIONS, provide 4 plausible options and return correctAnswer as an array of exact option strings
- For TRUE_FALSE, use options ["True", "False"] and set correctAnswer to exactly one of those values
- For SHORT_ANSWER, PARAGRAPH, ESSAY, ESSAY_LETTER, ESSAY_STORY, and NUMBER, do not add unnecessary options
- For NUMBER, correctAnswer must be the numeric answer as a string
- Make the passage analytical, educational, and rich enough to support every question in the group
- Avoid duplicate or near-duplicate questions
- Do not include markdown, commentary, or extra fields`,
          },
          {
            role: 'user',
            content: `Create shared-scenario question groups.

Topic: ${sanitizeString(topic)}
Difficulty: ${sanitizeString(difficulty)}
${sanitizeString(examTitle) ? `Exam title: ${sanitizeString(examTitle)}` : ''}
${sanitizeString(examDescription) ? `Exam description: ${sanitizeString(examDescription).slice(0, 500)}` : ''}
${uploadedExcerpt ? `Relevant source content:\n${uploadedExcerpt}` : ''}
${existingQuestionsText ? `Avoid duplicating these existing questions:\n${existingQuestionsText}` : ''}
Scenario question types to use: ${normalizedScenarioQuestionTypes.join(', ')}

Required scenario groups:
${JSON.stringify(groupBlueprint)}`,
          },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      },
    });

    const responseContent = completion?.choices?.[0]?.message?.content || '{}';
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseContent);
    } catch {
      const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      parsedResponse = jsonMatch ? JSON.parse(jsonMatch[1]) : {};
    }

    const parsedGroups = Array.isArray(parsedResponse?.groups)
      ? parsedResponse.groups
      : Array.isArray(parsedResponse?.scenarios)
        ? parsedResponse.scenarios
        : [];

    const normalizedGroups = fallbackGroups.map((fallbackGroup, groupIndex) => {
      const parsedGroup = parsedGroups[groupIndex] && typeof parsedGroups[groupIndex] === 'object'
        ? parsedGroups[groupIndex]
        : {};
      const sharedPassage =
        sanitizeString(parsedGroup?.passage || parsedGroup?.paragraph || parsedGroup?.scenario) ||
        fallbackGroup.passage;
      const parsedQuestions = Array.isArray(parsedGroup?.questions) ? parsedGroup.questions : [];

      return {
        groupId: fallbackGroup.groupId,
        passage: sharedPassage,
        questions: fallbackGroup.questions.map((fallbackQuestion, localIndex) => {
          const questionIndex = groupIndexes[groupIndex]?.[localIndex] ?? localIndex;
          const targetType = sanitizeString(fallbackQuestion?.questionType).toUpperCase() || 'PARAGRAPH';
          const parsedQuestion = parsedQuestions[localIndex] && typeof parsedQuestions[localIndex] === 'object'
            ? parsedQuestions[localIndex]
            : {};

          return {
            ...normalizeToRequestedType({
              question: {
                ...fallbackQuestion,
                ...parsedQuestion,
                questionType: targetType,
                options: Array.isArray(parsedQuestion?.options)
                  ? parsedQuestion.options
                  : fallbackQuestion.options,
                correctAnswer:
                  parsedQuestion?.correctAnswer !== undefined
                    ? parsedQuestion.correctAnswer
                    : fallbackQuestion.correctAnswer,
                passage: sharedPassage,
                paragraphGroupId: fallbackGroup.groupId,
                points: Number.isFinite(Number(parsedQuestion?.points))
                  ? Number(parsedQuestion.points)
                  : fallbackQuestion.points,
              },
              type: targetType,
              index: questionIndex,
              topic,
            }),
            passage: sharedPassage,
            paragraphGroupId: fallbackGroup.groupId,
          };
        }),
      };
    });

    return applyParagraphScenarioGroups({
      questions: safeQuestions,
      groupIndexes,
      groups: normalizedGroups,
      topic,
    });
  } catch (error) {
    console.warn('Falling back to local paragraph scenario grouping:', error?.message || error);
    return applyParagraphScenarioGroups({
      questions: safeQuestions,
      groupIndexes,
      groups: fallbackGroups,
      topic,
    });
  }
};

/**
 * Generate exam questions using OpenAI
 */
export const generateQuestions = async (params) => {
  // Extract and sanitize parameters
  let {
    topic,
    count,
    difficulty,
    questionTypes,
    scenarioQuestionTypes = ['PARAGRAPH'],
    questionTypeDistribution, // NEW: Array of { type, count } for specific distribution
    questionSorting = 'MIX_ALL',
    questionSortPattern = [],
    duration,
    uploadedContent,
    examTitle,
    examDescription,
    existingQuestions = [], // Array of existing question texts to avoid duplicates
    enableImageQuestions = false,
    imageQuestionCount = 0,
    imageQuestionRatio = 0,
    imageQuestionPerCount = 5,
    imageQuestionsPerImage = DEFAULT_IMAGE_QUESTIONS_PER_IMAGE,
    questionsPerParagraph = DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH,
    imageQuestionMode = 'percentage',
    imageQuestionTypes = [],
    metadata = null,
    tenantId = null,
    userId = null,
  } = params;

  const trackingContext = resolveTrackingContext({ tenantId, userId, metadata });

  // Sanitize topic
  topic = String(topic || '').trim().substring(0, 500);
  
  // Sanitize exam title and description
  examTitle = examTitle ? String(examTitle).trim().substring(0, 200) : undefined;
  examDescription = examDescription ? String(examDescription).trim().substring(0, 1000) : undefined;
  
  // Sanitize uploaded content (limit size to prevent abuse)
  if (uploadedContent) {
    uploadedContent = String(uploadedContent).trim().substring(0, 50000); // 50KB limit
  }

  // Validate inputs
  if (!topic || !count || !difficulty || !Array.isArray(questionTypes)) {
    throw new Error('Missing required parameters for question generation');
  }

  // Sanitize and validate topic (prevent prompt injection)
  const sanitizedTopic = String(topic || '').trim().substring(0, 500); // Limit length
  if (!sanitizedTopic || sanitizedTopic.length < 3) {
    throw new Error('Topic must be at least 3 characters long');
  }

  // Validate count
  const questionCount = parseInt(count, 10);
  if (isNaN(questionCount) || questionCount < 5 || questionCount > 50) {
    throw new Error('Question count must be between 5 and 50');
  }
  const normalizedQuestionsPerParagraph = normalizeQuestionsPerParagraph(
    questionsPerParagraph,
    DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH,
    questionCount
  );

  const imageQuestionConfig = normalizeImageQuestionConfig({
    enableImageQuestions,
    imageQuestionCount,
    imageQuestionRatio,
    imageQuestionPerCount,
    imageQuestionsPerImage,
    imageQuestionMode,
    imageQuestionTypes,
    count: questionCount,
  });
  const requestedQuestionTypes = normalizeRequestedQuestionTypes(questionTypes);
  const imageOnlyGeneration = requestedQuestionTypes.length === 0 && imageQuestionConfig.enabled;
  const effectiveImageQuestionConfig = imageOnlyGeneration
    ? {
        ...imageQuestionConfig,
        enabled: true,
        count: questionCount,
        ratioPercent: 100,
        perCount: 1,
      }
    : imageQuestionConfig;

  // Validate OpenAI API key
  if (!client) {
    console.warn('OpenAI API key not configured, using fallback templates');
    await trackFallbackUsage({
      feature: 'question_generation',
      tenantId: trackingContext.tenantId,
      userId: trackingContext.userId,
      errorMessage: 'OpenAI API key not configured.',
    });
    return generateFallbackQuestions({
      ...params,
      enableImageQuestions: effectiveImageQuestionConfig.enabled,
      imageQuestionCount: effectiveImageQuestionConfig.count,
      imageQuestionRatio: effectiveImageQuestionConfig.ratioPercent,
      imageQuestionPerCount: effectiveImageQuestionConfig.perCount,
      imageQuestionsPerImage: effectiveImageQuestionConfig.questionsPerImage,
      questionsPerParagraph: normalizedQuestionsPerParagraph,
      imageQuestionMode: effectiveImageQuestionConfig.mode,
      imageQuestionTypes: effectiveImageQuestionConfig.imageTypes,
    });
  }

  // Validate difficulty
  const validDifficulties = ['easy', 'medium', 'hard', 'ultra_hard'];
  if (!validDifficulties.includes(difficulty)) {
    throw new Error(`Difficulty must be one of: ${validDifficulties.join(', ')}`);
  }

  // Sanitize question types and support image-only generation by resolving
  // to image-based MCQ when no base type is explicitly selected.
  questionTypes = requestedQuestionTypes;
  if (questionTypes.length === 0 && effectiveImageQuestionConfig.enabled) {
    questionTypes = ['MULTIPLE_CHOICE'];
  }
  if (questionTypes.length === 0) {
    throw new Error('At least one valid question type is required');
  }
  
  // Sanitize exam title and description
  examTitle = examTitle ? String(examTitle).trim().substring(0, 200) : undefined;
  examDescription = examDescription ? String(examDescription).trim().substring(0, 1000) : undefined;
  
  // Sanitize uploaded content (limit size to prevent abuse)
  if (uploadedContent) {
    uploadedContent = String(uploadedContent).trim().substring(0, 50000); // 50KB limit
  }

  try {
    // Define difficulty level descriptions for AI guidance
    const difficultyDescriptions = {
      easy: `EASY LEVEL: Questions should test basic, fundamental concepts. They should be straightforward and require only basic knowledge of the topic. Use simple language and avoid complex scenarios. Suitable for beginners or introductory courses.`,
      medium: `MEDIUM LEVEL: Questions should test intermediate understanding. They require students to apply concepts, make connections, or solve moderately complex problems. May involve multi-step reasoning or application of multiple concepts. Suitable for students with solid foundational knowledge.`,
      hard: `HARD LEVEL: Questions should be challenging and require advanced knowledge. They should test deep understanding, critical thinking, and the ability to solve complex problems. May involve synthesis of multiple concepts, advanced problem-solving techniques, or require expert-level knowledge. Suitable for advanced students or upper-level courses.`,
      ultra_hard: `ULTRA HARD (EXTREME) LEVEL: Questions must be extremely challenging and test expert-level mastery. They should require:
- Deep, comprehensive understanding of advanced concepts
- Complex multi-step problem-solving and critical analysis
- Synthesis of multiple advanced topics
- Creative or innovative thinking approaches
- Expert-level knowledge that goes beyond standard curriculum
- Questions that challenge even the most advanced students
- May involve cutting-edge concepts, advanced research-level topics, or require extensive domain expertise
These questions should be at the highest difficulty level, suitable for expert-level assessments, competitive exams, or advanced graduate-level courses.`,
    };

    const difficultyGuidance = difficultyDescriptions[difficulty] || difficultyDescriptions.medium;

    // Normalize requested distribution so backend always enforces exact totals.
    const typeDistribution = buildQuestionTypeDistribution({
      questionTypes,
      questionTypeDistribution,
      count: questionCount,
    });

    // Build system prompt with enhanced difficulty guidance
    const existingQuestionsText = Array.isArray(existingQuestions) && existingQuestions.length > 0
      ? existingQuestions.slice(0, 50).map((q, idx) => `${idx + 1}. ${String(q).substring(0, 200)}`).join('\n')
      : '';

    let systemPrompt = `You are an expert exam question generator specializing in creating questions at precise difficulty levels. Generate high-quality exam questions in JSON format.

CRITICAL REQUIREMENTS:
- Generate exactly ${questionCount} questions
- Difficulty level: ${difficulty.toUpperCase()}
- ${difficultyGuidance}

QUESTION TYPE ENFORCEMENT (MANDATORY):
- You MUST ONLY use these question types: ${questionTypes.join(', ')}
- DO NOT generate any question types other than: ${questionTypes.join(', ')}
- EXACT Question type distribution (CRITICAL - follow this precisely): ${typeDistribution.map(item => `${item.count} ${item.type}`).join(', ')}
- You MUST generate EXACTLY the specified number for each type:
${typeDistribution.map(item => `  - ${item.count} question${item.count > 1 ? 's' : ''} of type ${item.type}`).join('\n')}
- Each question's questionType field MUST be one of: ${questionTypes.join(', ')}
- The total count MUST equal exactly ${questionCount} questions
- DO NOT deviate from the specified distribution - generate exactly as specified above

${existingQuestionsText ? `\nCRITICAL: DUPLICATE PREVENTION
- The following questions already exist in this exam. You MUST NOT generate questions that are similar or duplicate these:
${existingQuestionsText}
- Generate COMPLETELY NEW and UNIQUE questions that are different from the existing ones
- Ensure each new question covers different aspects or concepts than the existing questions
- Do not rephrase or slightly modify existing questions - create entirely new ones\n` : ''}

Topic: ${topic}
${examTitle ? `Exam title: ${examTitle}` : ''}
${examDescription ? `Exam description: ${examDescription}` : ''}
${duration ? `Exam duration: ${duration} minutes` : ''}
${uploadedContent ? `\nIMPORTANT: Use the following detailed content as the PRIMARY source for generating questions:\n${uploadedContent.substring(0, 2000)}` : ''}

DIFFICULTY ENFORCEMENT:
- You MUST strictly adhere to the ${difficulty} difficulty level specified above
- Each question must match the difficulty requirements exactly
- For ${difficulty === 'ultra_hard' ? 'ULTRA HARD' : difficulty.toUpperCase()} level, ensure questions are genuinely challenging and require expert-level knowledge
- Do NOT create questions that are easier than the specified difficulty level
- The complexity, depth, and cognitive demand of each question must align with the difficulty level

For each question, provide:
- questionText: The question itself (must match the difficulty level)
- questionType: MUST be one of ONLY these types: ${questionTypes.join(', ')}. DO NOT use any other types.
- options: Array of options (for MULTIPLE_CHOICE, MULTIPLE_OPTIONS, TRUE_FALSE). For harder difficulties, make distractors more plausible and challenging.
- correctAnswer: The correct answer (string) for non-coding questions. Use an empty string for CODING questions.
- For FILL_IN_THE_BLANK, place exactly one blank in questionText and return the exact missing text as correctAnswer.
- For MATCHING, return matchingPairs as an array of at least 3 objects, each with non-empty left and right fields; correctAnswer must be the same pair mapping serialized as JSON.
- passage: For PARAGRAPH questions, include the supporting passage students must read. Use an empty string for other question types unless contextual text is explicitly required.
- For grouped PARAGRAPH/SCENARIO output, you may return { "groups": [{ "passage": "...", "questions": [...] }] }. Each nested question counts toward total questions.
- title: For CODING questions, provide a short problem title.
- description: For CODING questions, provide a full problem statement.
- category: For CODING questions, provide a short category label such as Data Structures or Algorithms.
- languages: For CODING questions, return an array chosen from ${getSupportedCodingLanguages().join(', ')}.
- starterCode: For CODING questions, return an object keyed by language with starter templates.
- testCases: For CODING questions, return an array of objects with input, expectedOutput, and hidden (boolean). Include at least one visible sample with hidden=false.
- timeLimit: For CODING questions, provide a time limit in seconds.
- points: Points for this question (default 1)
- order: Sequential order starting from 1

Return a JSON object with a "questions" array containing exactly ${questionCount} questions. Format: { "questions": [...] }`;

    const userPrompt = `Generate exactly ${questionCount} ${difficulty} difficulty level questions about "${topic}". 

CRITICAL REQUIREMENTS:
- Question Types: You MUST ONLY generate questions of these types: ${questionTypes.join(', ')}
- EXACT Distribution (MUST follow precisely):
${typeDistribution.map(item => `  - Generate EXACTLY ${item.count} ${item.type} question${item.count > 1 ? 's' : ''}`).join('\n')}
- Total questions: ${questionCount} (sum of all types above)
- DO NOT generate any question types that are NOT in the list: ${questionTypes.join(', ')}
- Each question's questionType field MUST be exactly one of: ${questionTypes.join(', ')}
- IMPORTANT: The distribution above is EXACT - generate exactly the specified number for each type, no more, no less
${existingQuestionsText ? `\n- IMPORTANT: Do NOT create questions similar to the existing ones listed above. Generate completely new and unique questions covering different aspects of the topic.` : ''}

Difficulty:
- Strictly follow the ${difficulty.toUpperCase()} difficulty guidelines provided
- Each question must genuinely reflect ${difficulty === 'ultra_hard' ? 'expert-level, extreme difficulty requiring deep mastery' : difficulty === 'hard' ? 'advanced difficulty requiring deep understanding' : difficulty === 'medium' ? 'intermediate difficulty requiring solid understanding' : 'basic difficulty requiring fundamental knowledge'}
- Ensure questions are appropriately challenging for the ${difficulty} level
${uploadedContent ? `- Base questions on the provided detailed content while maintaining ${difficulty} difficulty level` : ''}`;

    // Adjust temperature based on difficulty - higher for harder questions to encourage more creative/complex questions
    const temperatureMap = {
      easy: 0.5,      // Lower temperature for more straightforward, predictable questions
      medium: 0.6,    // Moderate temperature for balanced questions
      hard: 0.75,     // Higher temperature for more complex, varied questions
      ultra_hard: 0.85, // Highest temperature for extremely challenging, creative questions
    };
    const temperature = temperatureMap[difficulty] || 0.7;

    // Make API call with retry logic
    const maxRetries = 3;
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const completion = await createTrackedChatCompletion({
          client,
          feature: 'question_generation',
          tenantId: trackingContext.tenantId,
          userId: trackingContext.userId,
          questionCount,
          request: {
            model: OPENAI_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: temperature,
            response_format: { type: 'json_object' },
          },
        });
        
        // Success - process response
        const responseContent = completion.choices[0].message.content;
        let parsedResponse;

        try {
          parsedResponse = JSON.parse(responseContent);
        } catch (parseError) {
          // Try to extract JSON from markdown code blocks
          const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
          if (jsonMatch) {
            parsedResponse = JSON.parse(jsonMatch[1]);
          } else {
            throw new Error('Failed to parse OpenAI response as JSON');
          }
        }

        const extractedQuestions = extractQuestionsFromAiResponse(parsedResponse);
        if (!extractedQuestions.length) {
          throw new Error('Invalid response format from OpenAI');
        }

        const normalizedQuestions = extractedQuestions
          .map((q, index) => normalizeQuestionObject(q, index + 1))
          .filter(Boolean);

        // Enforce exact requested type distribution and total count.
        const distributedQuestions = enforceQuestionDistribution({
          questions: normalizedQuestions,
          typeDistribution,
          count: questionCount,
          topic: sanitizedTopic,
        });
        const paragraphEnhancedQuestions = await enhanceParagraphScenarioQuestions({
          questions: distributedQuestions,
          questionsPerParagraph: normalizedQuestionsPerParagraph,
          scenarioQuestionTypes,
          topic: sanitizedTopic,
          difficulty,
          uploadedContent,
          examTitle,
          examDescription,
          existingQuestions,
          tenantId: trackingContext.tenantId,
          userId: trackingContext.userId,
        });

        const imageEnhancedQuestions = await attachImageBasedQuestions({
          questions: paragraphEnhancedQuestions,
          imageConfig: effectiveImageQuestionConfig,
          topic: sanitizedTopic,
          difficulty,
          uploadedContent,
          examTitle,
          examDescription,
          tenantId: trackingContext.tenantId,
          userId: trackingContext.userId,
        });
        return applyQuestionSorting({
          questions: imageEnhancedQuestions,
          questionSorting,
          questionSortPattern,
          questionTypes,
        });
      } catch (error) {
        lastError = error;
        
        // Don't retry on certain errors (authentication, invalid request, etc.)
        if (error.status === 401 || error.status === 403 || error.status === 400) {
          throw error;
        }
        
        // Exponential backoff: wait 1s, 2s, 4s before retrying
        if (attempt < maxRetries - 1) {
          const delayMs = Math.pow(2, attempt) * 1000;
          console.warn(`OpenAI API call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`, error.message);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    
    // All retries failed - fall back to template questions
    console.error('OpenAI API call failed after all retries:', lastError?.message || 'Unknown error');
    return generateFallbackQuestions({
      ...params,
      scenarioQuestionTypes,
      enableImageQuestions: effectiveImageQuestionConfig.enabled,
      imageQuestionCount: effectiveImageQuestionConfig.count,
      imageQuestionRatio: effectiveImageQuestionConfig.ratioPercent,
      imageQuestionPerCount: effectiveImageQuestionConfig.perCount,
      imageQuestionsPerImage: effectiveImageQuestionConfig.questionsPerImage,
      questionsPerParagraph: normalizedQuestionsPerParagraph,
      imageQuestionMode: effectiveImageQuestionConfig.mode,
      imageQuestionTypes: effectiveImageQuestionConfig.imageTypes,
    });
  } catch (error) {
    console.error('OpenAI question generation error:', error);
    // Check if it's a network/connection error
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      console.warn('Network error during AI generation, using fallback questions');
    }
    // Always return fallback questions on error
    return generateFallbackQuestions({
      ...params,
      scenarioQuestionTypes,
      enableImageQuestions: effectiveImageQuestionConfig.enabled,
      imageQuestionCount: effectiveImageQuestionConfig.count,
      imageQuestionRatio: effectiveImageQuestionConfig.ratioPercent,
      imageQuestionPerCount: effectiveImageQuestionConfig.perCount,
      imageQuestionsPerImage: effectiveImageQuestionConfig.questionsPerImage,
      questionsPerParagraph: normalizedQuestionsPerParagraph,
      imageQuestionMode: effectiveImageQuestionConfig.mode,
      imageQuestionTypes: effectiveImageQuestionConfig.imageTypes,
    });
  }
};

export const extractQuestionsFromContent = async (params) => {
  const {
    content,
    structuredRows,
    tenantId = null,
    userId = null,
    metadata = null,
  } = params;
  const trackingContext = resolveTrackingContext({ tenantId, userId, metadata });

  const trimmedContent = sanitizeString(content);
  const normalizedContent = normalizeImportTextForParsing(trimmedContent);
  console.log('[question-import-debug] CLEAN TEXT:', normalizedContent);
  const normalizedFromRows = Array.isArray(structuredRows)
    ? structuredRows
      .map((row, idx) => normalizeStructuredRow(row, idx))
      .filter((question) => isValidParsedImportQuestion(question))
    : [];

  const parsedFromNumbering = normalizedContent
    ? extractQuestionsFromNumberedText(normalizedContent)
    : [];

  if (
    normalizedFromRows.length &&
    parsedFromNumbering.length > normalizedFromRows.length &&
    normalizedFromRows.length <= 1
  ) {
    console.log(
      '[question-import-debug] STRUCTURED ROWS BYPASSED:',
      `rows=${normalizedFromRows.length} numbered=${parsedFromNumbering.length}`
    );
    return parsedFromNumbering;
  }

  if (normalizedFromRows.length) {
    return normalizedFromRows;
  }

  if (!normalizedContent) {
    throw new Error('No content provided to extract questions');
  }

  if (!client) {
    console.warn('OpenAI API key not configured, using fallback question extraction');
    await trackFallbackUsage({
      feature: 'question_import',
      tenantId: trackingContext.tenantId,
      userId: trackingContext.userId,
      errorMessage: 'OpenAI API key not configured.',
    });
    const localChunkParsed = dedupeQuestionsByText(
      splitContentIntoQuestionChunks(normalizedContent)
        .map((chunk, index) =>
          normalizeSingleChunkQuestion({
            extracted: null,
            chunkText: chunk,
            index,
          })
        )
        .filter(Boolean)
    );

    if (parsedFromNumbering.length) {
      return parsedFromNumbering;
    }

    return localChunkParsed.length
      ? localChunkParsed
      : extractQuestionsFallback({ content: normalizedContent, structuredRows });
  }

  try {
    const parsedFromChunks = await extractQuestionsFromChunkedAi({
      content: normalizedContent,
      trackingContext,
    });

    if (
      parsedFromNumbering.length > 0 &&
      parsedFromNumbering.length >= parsedFromChunks.length
    ) {
      return parsedFromNumbering;
    }

    if (parsedFromChunks.length) {
      return parsedFromChunks;
    }

    if (parsedFromNumbering.length) {
      return parsedFromNumbering;
    }

    const localChunkParsed = dedupeQuestionsByText(
      splitContentIntoQuestionChunks(normalizedContent)
        .map((chunk, index) =>
          normalizeSingleChunkQuestion({
            extracted: null,
            chunkText: chunk,
            index,
          })
        )
        .filter(Boolean)
    );

    if (localChunkParsed.length) {
      return localChunkParsed;
    }

    if (!parsedFromChunks.length) {
      throw new Error('No questions extracted by AI');
    }
  } catch (error) {
    console.error('OpenAI question extraction error:', error);
    return parsedFromNumbering.length
      ? parsedFromNumbering
      : extractQuestionsFallback({ content: normalizedContent, structuredRows });
  }
};

const normalizeEvaluationText = (value) =>
  sanitizeString(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeEvaluationList = (value) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => sanitizeString(typeof item === 'object' ? item?.text || item?.concept || item?.value : item))
    .filter(Boolean)
    .slice(0, 20);

const buildSemanticRubric = ({ evaluationConfig = {}, rubric = [], points = 0, questionType = '' }) => {
  const config = evaluationConfig && typeof evaluationConfig === 'object' ? evaluationConfig : {};
  const configuredRubric = Array.isArray(config.rubric) && config.rubric.length ? config.rubric : rubric;
  const expectedConcepts = normalizeEvaluationList(config.expectedConcepts || config.keyPoints);
  const maxPoints = Math.max(Number(points) || 0, 0);
  const defaults =
    ['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY'].includes(String(questionType).toUpperCase())
      ? [
          { criterion: 'Relevance and factual accuracy', weight: 30 },
          { criterion: 'Required concepts and completeness', weight: 30 },
          { criterion: 'Structure and coherence', weight: 20 },
          { criterion: 'Language and presentation', weight: 10 },
          { criterion: 'Conclusion or completeness', weight: 10 },
        ]
      : [
          { criterion: 'Conceptual correctness', weight: 50 },
          { criterion: 'Required concepts and completeness', weight: 35 },
          { criterion: 'Reasoning and relevance', weight: 15 },
        ];
  const source = Array.isArray(configuredRubric) && configuredRubric.length ? configuredRubric : defaults;
  const entries = source
    .map((entry, index) => {
      const criterion = sanitizeString(entry?.criterion || entry?.name || entry?.title) || `Criterion ${index + 1}`;
      const rawMax = Number(entry?.maxMarks ?? entry?.marks ?? entry?.maxScore);
      const rawWeight = Number(entry?.weight ?? entry?.percentage);
      return {
        criterion,
        description: sanitizeString(entry?.description),
        mandatory: Boolean(entry?.mandatory),
        keyPoints: normalizeEvaluationList(entry?.keyPoints || entry?.expectedConcepts),
        acceptableAlternatives: normalizeEvaluationList(entry?.acceptableAlternatives || entry?.alternatives),
        rawMax: Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0,
        weight: Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 0,
      };
    })
    .filter((entry) => entry.criterion);
  const explicitTotal = entries.reduce((sum, entry) => sum + entry.rawMax, 0);
  const weightTotal = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const scoredEntries = entries.map((entry) => {
    const share = explicitTotal > 0
      ? entry.rawMax / explicitTotal
      : weightTotal > 0
        ? entry.weight / weightTotal
        : 1 / Math.max(entries.length, 1);
    return {
      ...entry,
      maxScore: Number((maxPoints * share).toFixed(2)),
      weight: Number((share * 100).toFixed(2)),
    };
  });
  if (scoredEntries.length) {
    const precedingTotal = scoredEntries.slice(0, -1).reduce((sum, item) => sum + item.maxScore, 0);
    scoredEntries[scoredEntries.length - 1].maxScore = Number((maxPoints - precedingTotal).toFixed(2));
  }
  return scoredEntries;
};

const normalizeEvaluationItems = (value, fallback = []) => {
  const items = Array.isArray(value)
    ? value.map((item) => sanitizeString(item)).filter(Boolean)
    : [];
  return items.length ? items.slice(0, 10) : fallback;
};

/**
 * Evaluate text answers semantically against the question, supporting context and
 * an author-defined rubric. The reference answer is evidence, never a required
 * sentence to reproduce.
 */
export const evaluateAnswer = async (params) => {
  const {
    question,
    correctAnswer,
    studentAnswer,
    questionType,
    points,
    rubric = [],
    rubricScoringEnabled = false,
    evaluationConfig = {},
    tenantId = null,
    userId = null,
    metadata = null,
  } = params;
  const trackingContext = resolveTrackingContext({ tenantId, userId, metadata });

  if (!client) {
    await trackFallbackUsage({
      feature: 'evaluation',
      tenantId: trackingContext.tenantId,
      userId: trackingContext.userId,
      errorMessage: 'OpenAI API key not configured.',
    });
    return {
      ...evaluateFallbackAnswer(params),
      provider: 'fallback',
      fallbackReason: 'OPENAI_API_KEY_MISSING',
    };
  }

  if (!question || !studentAnswer || !questionType) {
    throw new Error('Missing required parameters for answer evaluation');
  }

  const normalizedQuestionType = sanitizeString(questionType).toUpperCase();
  const evaluationType =
    ['SHORT_ANSWER', 'SHORTANSWER', 'SHORT'].includes(normalizedQuestionType)
      ? 'short'
      : ['PARAGRAPH'].includes(normalizedQuestionType)
        ? 'paragraph'
        : ['ESSAY', 'LONG_ANSWER', 'LONGANSWER', 'DESCRIPTIVE'].includes(normalizedQuestionType)
          ? 'essay'
          : ['ESSAY_LETTER', 'LETTER_WRITING', 'LETTER'].includes(normalizedQuestionType)
            ? 'essay_letter'
            : ['ESSAY_STORY', 'STORY_WRITING', 'STORY'].includes(normalizedQuestionType)
              ? 'essay_story'
              : ['FILL_IN_THE_BLANK', 'FILL_IN_BLANK'].includes(normalizedQuestionType)
                ? 'fill_in_the_blank'
                : ['NUMBER', 'NUMERICAL'].includes(normalizedQuestionType)
                  ? 'numerical'
                  : null;

  if (!evaluationType) {
    throw new Error(
      'Evaluation only supported for text, fill-in-the-blank, and numerical answer types'
    );
  }

  const maxPoints = Math.max(Number(points) || 0, 0);
  const effectiveRubric = buildSemanticRubric({
    evaluationConfig,
    rubric,
    points: maxPoints,
    questionType: normalizedQuestionType,
  });
  const config = evaluationConfig && typeof evaluationConfig === 'object' ? evaluationConfig : {};
  const expectedConcepts = normalizeEvaluationList(config.expectedConcepts || config.keyPoints);
  const acceptableAnswers = normalizeEvaluationList(config.acceptableAnswers || config.acceptableAlternatives);
  const commonMisconceptions = normalizeEvaluationList(config.commonMisconceptions);

  try {
    const systemPrompt = `You are a careful, consistent exam examiner. Grade the MEANING and factual correctness of the student's answer, never whether it copies the reference wording.

The reference answer is evidence only. Equivalent wording, sentence order, case, punctuation, and minor spelling differences must receive the same credit when they communicate the same correct meaning. Do not award credit for irrelevant, fabricated, or contradictory claims. Award partial credit only for demonstrated criteria or concepts.

Score each supplied rubric criterion independently. Its score must be between 0 and its maxScore. The final total is the sum of criterion scores; never invent a score outside the rubric. Do not deduct grammar, presentation, format, creativity, or structure unless that appears as a rubric criterion. If a mandatory concept is absent, say so. For a fill blank, accept configured alternatives and semantically equivalent answers; for numerical work assess the final answer, method, units, and steps only when the rubric/configuration asks for them. For a passage or case question, use the supplied context as the authority.

Return STRICT JSON only:
{
  "rubricScores": [{"criterion":"exact criterion name","score":number,"rationale":"brief evidence","identifiedConcepts":["..."],"missingConcepts":["..."]}],
  "correctConcepts":["..."],
  "missingConcepts":["..."],
  "incorrectStatements":["..."],
  "grammarFeedback":"only when language/grammar is rubric-scored, otherwise empty",
  "feedback":"short explanation for the awarded marks",
  "confidence":number,
  "manualReviewRecommended":boolean
}
Do not include markdown, code fences, or other keys.`;

    const userPrompt = `GRADE THIS ANSWER
Question type: ${evaluationType}
Question: ${question}
Reference answer (not required wording): ${correctAnswer || 'None provided'}
Student answer: ${studentAnswer}
Maximum marks: ${maxPoints}
Difficulty: ${sanitizeString(config.difficulty || '') || 'Not specified'}
Passage/case/supporting context: ${sanitizeString(config.supportingContext || config.passage || '') || 'None provided'}
Expected concepts: ${JSON.stringify(expectedConcepts)}
Acceptable alternatives: ${JSON.stringify(acceptableAnswers)}
Common misconceptions: ${JSON.stringify(commonMisconceptions)}
Minimum answer requirements: ${sanitizeString(config.minimumAnswerRequirements || '') || 'None specified'}
Partial-marking configuration: ${JSON.stringify(config.partialMarking || {})}
Numerical configuration: ${JSON.stringify(config.numerical || {})}
Rubric (score only these criteria): ${JSON.stringify(effectiveRubric.map(({ criterion, description, maxScore, mandatory, keyPoints, acceptableAlternatives }) => ({ criterion, description, maxScore, mandatory, keyPoints, acceptableAlternatives })))} `;

    const completion = await createTrackedChatCompletion({
      client,
      feature: 'evaluation',
      tenantId: trackingContext.tenantId,
      userId: trackingContext.userId,
      request: {
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
    });

    const responseContent = completion.choices[0].message.content;
    const evaluation = parseJsonObjectContent(responseContent);
    if (!evaluation) {
      throw new Error('Failed to parse evaluation response');
    }

    const receivedRubricScores = Array.isArray(evaluation?.rubricScores) ? evaluation.rubricScores : [];
    const mappedScores = effectiveRubric.map((rubricEntry) => {
      const candidate = receivedRubricScores.find(
        (item) => normalizeEvaluationText(item?.criterion) === normalizeEvaluationText(rubricEntry.criterion)
      );
      const rawScore = Number(candidate?.score);
      const score = Number(clampNumber(Number.isFinite(rawScore) ? rawScore : 0, 0, rubricEntry.maxScore).toFixed(2));
      return {
        criterion: rubricEntry.criterion,
        weight: rubricEntry.weight,
        score,
        maxScore: rubricEntry.maxScore,
        rationale: sanitizeString(candidate?.rationale) || 'No criterion-specific rationale provided.',
        identifiedConcepts: normalizeEvaluationItems(candidate?.identifiedConcepts),
        missingConcepts: normalizeEvaluationItems(candidate?.missingConcepts),
        mandatory: rubricEntry.mandatory,
      };
    });
    const score = Number(clampNumber(mappedScores.reduce((sum, item) => sum + item.score, 0), 0, maxPoints).toFixed(2));
    const confidenceRaw = Number(evaluation?.confidence);
    const confidence = Number(
      clampNumber(Number.isFinite(confidenceRaw) ? confidenceRaw : 0.5, 0, 1).toFixed(3)
    );
    const feedback = sanitizeString(evaluation?.feedback) || 'No feedback provided';
    const correctConcepts = normalizeEvaluationItems(evaluation?.correctConcepts);
    const missingConcepts = normalizeEvaluationItems(evaluation?.missingConcepts);
    const incorrectStatements = normalizeEvaluationItems(evaluation?.incorrectStatements);
    const strengths = correctConcepts.length ? correctConcepts : [
      score > 0 ? 'Some alignment with expected answer.' : 'No clear strengths identified.',
    ];
    const weaknesses = [...missingConcepts, ...incorrectStatements].slice(0, 10);
    if (!weaknesses.length) weaknesses.push(
      score >= maxPoints
        ? 'No major weaknesses observed.'
        : 'Expected key points are missing or underdeveloped.',
    );
    const correctnessThreshold = evaluationType === 'short' ? 0.85 : 0.6;

    const result = {
      score,
      feedback,
      strengths,
      weaknesses,
      confidence,
      isCorrect: maxPoints > 0 ? score >= (maxPoints * correctnessThreshold) : score > 0,
      pointsEarned: score,
      needsReview: confidence < 0.8 || Boolean(evaluation?.manualReviewRecommended),
      mode: 'semantic_rubric',
      evaluationMethod: 'semantic_context_rubric',
      rubric: effectiveRubric,
      rubricScores: mappedScores,
      rubricTotal: score,
      correctConcepts,
      missingConcepts,
      incorrectStatements,
      grammarFeedback: sanitizeString(evaluation?.grammarFeedback),
      shortExplanation: feedback,
      provider: 'openai',
    };

    return result;
  } catch (error) {
    console.error('OpenAI evaluation error:', error);
    return {
      ...evaluateFallbackAnswer(params),
      provider: 'fallback',
      fallbackReason: 'OPENAI_EVALUATION_ERROR',
    };
  }
};

/**
 * Fallback question generation using templates
 */
const collectOptionsFromRow = (row) => {
  const options = [];
  const pushOption = (value) => {
    const normalized = sanitizeString(value);
    if (normalized) {
      options.push(normalized);
    }
  };
  Object.entries(row || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const lower = key.toLowerCase();
    if (lower.startsWith('option') || lower.startsWith('choice')) {
      if (Array.isArray(value)) {
        value.forEach((item) => pushOption(item));
      } else {
        pushOption(value);
      }
    } else if (['a', 'b', 'c', 'd', 'e', 'f', 'opt1', 'opt2', 'opt3', 'opt4', 'opt5', 'opt6'].includes(lower)) {
      if (Array.isArray(value)) {
        value.forEach((item) => pushOption(item));
      } else {
        pushOption(value);
      }
    }
  });

  if (!options.length && row) {
    const rawOptions = row.options || row.choices;
    if (rawOptions) {
      if (Array.isArray(rawOptions)) {
        rawOptions.forEach((item) => pushOption(item));
      } else {
        const text = sanitizeString(rawOptions);
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
              parsed.forEach((item) => pushOption(item));
            }
          } catch (error) {
            text
              .split(/[,;|\n]/)
              .map((item) => sanitizeString(item))
              .filter(Boolean)
              .forEach((item) => options.push(item));
          }
        }
      }
    }
  }

  return sanitizeQuestionOptions(Array.from(new Set(options.filter(Boolean))));
};

const inferQuestionType = (rawType, options, answer, questionText) => {
  const normalizedType = normalizeQuestionTypeToken(rawType);
  if (VALID_QUESTION_TYPES.includes(normalizedType)) {
    return normalizedType;
  }

  const optionCount = options ? options.length : 0;
  const answerList = parseMultiAnswer(answer);

  if (
    /\b(?:true\s*\/\s*false|true\s+or\s+false|t\s*\/\s*f)\b/i.test(
      sanitizeString(questionText)
    )
  ) {
    return 'TRUE_FALSE';
  }

  if (optionCount >= 2) {
    const tfOptions = options.every((opt) => ['true', 'false'].includes(opt.toLowerCase()));
    if (tfOptions) {
      return 'TRUE_FALSE';
    }
    if (answerList.length > 1) {
      return 'MULTIPLE_OPTIONS';
    }
    return 'MULTIPLE_CHOICE';
  }

  if (answerList.length > 1) {
    return 'MULTIPLE_OPTIONS';
  }

  const answerString = sanitizeString(answer);
  if (answerString && !Number.isNaN(Number(answerString))) {
    return 'NUMBER';
  }

  if (questionText && questionText.length > 220) {
    return 'PARAGRAPH';
  }

  return 'SHORT_ANSWER';
};

const normalizeImportLine = (line) =>
  sanitizeString(String(line || '').replace(/\u00A0/g, ' ').replace(/[ \t]{2,}/g, ' '));

const isImportMetadataLine = (line) => {
  const normalized = normalizeImportLine(line);
  if (!normalized) return true;
  return IMPORT_HEADER_LINE_REGEX.test(normalized);
};

const normalizeImportTextToSingleLine = (content) =>
  String(content || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stripLeadingQuestionNumberToken = (value) =>
  sanitizeString(value).replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[\).:\-]\s*/i, '');

const isLikelyImportHeaderBlock = (block) => {
  const normalized = sanitizeString(block);
  if (!normalized) return true;

  const headerTokens = ['quiz', 'name', 'date', 'section'];
  const headerTokenHits = headerTokens.reduce((count, token) => {
    const tokenRegex = new RegExp(`\\b${token}\\b`, 'i');
    return tokenRegex.test(normalized) ? count + 1 : count;
  }, 0);

  const hasHeaderFieldSyntax = /\b(?:name|date|section)\s*[:_]/i.test(normalized);
  const hasLabeledOptions = /(?:^|\s)[A-D][\).:\-]\s+\S+/i.test(normalized);
  const hasTrueFalse = IMPORT_TRUE_FALSE_REGEX.test(normalized);

  if (hasHeaderFieldSyntax && !hasLabeledOptions && !hasTrueFalse) {
    return true;
  }

  if (headerTokenHits >= 2 && !hasLabeledOptions && !hasTrueFalse) {
    return true;
  }

  return false;
};

const extractLabeledOptionsFromText = (text) => {
  const normalized = normalizeImportTextToSingleLine(text);
  if (!normalized) {
    return [];
  }

  const optionRegex =
    /(?:^|\s)([A-D])[\).:\-]\s*(.*?)(?=(?:\s+[A-D][\).:\-]\s*)|(?:\s+(?:answer|ans|correct\s*answer)\s*[:\-])|$)/gis;
  const optionMap = new Map();
  let match;

  while ((match = optionRegex.exec(normalized))) {
    const label = sanitizeString(match[1]).toUpperCase();
    const value = sanitizeString(match[2]).replace(/\s+/g, ' ');
    if (!label || !value || optionMap.has(label)) {
      continue;
    }
    optionMap.set(label, value);
  }

  const ordered = ['A', 'B', 'C', 'D'].map((label) => optionMap.get(label)).filter(Boolean);
  return sanitizeQuestionOptions(ordered);
};

const extractRawAnswerFromText = (text) => {
  const normalized = normalizeImportTextToSingleLine(text);
  if (!normalized) {
    return '';
  }

  const answerMatch = normalized.match(
    /\b(?:answer|ans|correct\s*answer)\s*[:\-]\s*(.+)$/i
  );
  return sanitizeString(answerMatch?.[1] || '');
};

const buildQuestionTextFromParsedBlock = (blockText) => {
  const withoutNumber = normalizeImportTextToSingleLine(
    stripLeadingQuestionNumberToken(blockText)
  );
  if (!withoutNumber) {
    return '';
  }

  const withoutAnswer = withoutNumber
    .replace(/\b(?:answer|ans|correct\s*answer)\s*[:\-]\s*.+$/i, '')
    .trim();

  const optionMatch = withoutAnswer.match(/(?:^|\s)A[\).:\-]\s*/i);
  const tfMatch = withoutAnswer.match(IMPORT_TRUE_FALSE_REGEX);
  let splitIndex = withoutAnswer.length;

  if (optionMatch && Number.isInteger(optionMatch.index)) {
    splitIndex = Math.min(splitIndex, optionMatch.index);
  }

  if (tfMatch && Number.isInteger(tfMatch.index)) {
    splitIndex = Math.min(splitIndex, tfMatch.index);
  }

  return sanitizeString(withoutAnswer.slice(0, splitIndex).replace(/\s+/g, ' '));
};

const normalizeImportTextForParsing = (content) => {
  const normalized = normalizeImportTextToSingleLine(content)
    .replace(/(^|\s)(?:q(?:uestion)?\s*)?(\d+)\)\s+/gi, '$1$2. ')
    .replace(/(^|\s)(?:q(?:uestion)?\s*)(\d+)\s*[:\-]\s+/gi, '$1$2. ')
    .replace(/\b(\d+)\)\s*/g, '$1. ')
    .replace(/\b(\d+)\.(?=\S)/g, '$1. ')
    .replace(/([A-D])\)(?=\S)/gi, '$1) ')
    .replace(/([A-D])\.(?=\S)/gi, '$1. ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
};

const isValidParsedImportQuestion = (question) => {
  const questionText = sanitizeString(question?.questionText || '');
  if (questionText.length <= 5) return false;
  if (isImportMetadataLine(questionText)) return false;

  const questionType = sanitizeString(question?.questionType).toUpperCase();
  const options = Array.isArray(question?.options) ? sanitizeQuestionOptions(question.options) : [];

  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType)) {
    return options.length >= 2;
  }

  return true;
};

const splitNumberedQuestionBlocks = (content) => {
  const normalizedContent = normalizeImportTextForParsing(content);
  if (!normalizedContent) {
    return [];
  }

  const markerPattern = /(?:^|\s)(?:q(?:uestion)?\s*)?(\d{1,3})\s*[\).:\-]\s+/gi;
  const markers = Array.from(normalizedContent.matchAll(markerPattern))
    .map((match) => {
      const markerIndex =
        Number.isInteger(match.index) && match.index >= 0
          ? match.index + Math.max(0, sanitizeString(match[0]).search(/\d/))
          : -1;
      const prefix = markerIndex > 0
        ? normalizedContent.slice(Math.max(0, markerIndex - 16), markerIndex)
        : '';
      const precededBySection = /\bsection[\s:._-]*$/i.test(prefix);
      return {
        index: markerIndex,
        number: Number.parseInt(match[1], 10),
        precededBySection,
      };
    })
    .filter((item) => item.index >= 0 && Number.isFinite(item.number) && !item.precededBySection);

  if (!markers.length) {
    return [];
  }

  let selectedMarkers = markers;
  if (markers.length >= 2) {
    let bestSequence = [];
    for (let start = 0; start < markers.length; start += 1) {
      const sequence = [markers[start]];
      let expected = markers[start].number + 1;
      for (let idx = start + 1; idx < markers.length; idx += 1) {
        if (markers[idx].number === expected) {
          sequence.push(markers[idx]);
          expected += 1;
        }
      }
      if (sequence.length > bestSequence.length) {
        bestSequence = sequence;
      }
    }
    if (bestSequence.length >= 2) {
      selectedMarkers = bestSequence;
    }
  }

  const blocks = selectedMarkers
    .map((marker, idx) => {
      const end = idx + 1 < selectedMarkers.length
        ? selectedMarkers[idx + 1].index
        : normalizedContent.length;
      return sanitizeString(normalizedContent.slice(marker.index, end));
    })
    .filter(Boolean)
    .filter((chunk) => /^\d+\s*[\).:\-]\s/.test(chunk))
    .filter((chunk) => !isLikelyImportHeaderBlock(chunk));

  if (blocks.length >= 2) {
    return blocks;
  }

  const directSplitBlocks = normalizedContent
    .split(IMPORT_NUMBERED_SPLIT_REGEX)
    .map((chunk) => sanitizeString(chunk))
    .filter(Boolean)
    .filter((chunk) => /^\d+\s*[\).:\-]\s/.test(chunk))
    .filter((chunk) => !isLikelyImportHeaderBlock(chunk));

  if (directSplitBlocks.length > blocks.length) {
    return directSplitBlocks;
  }

  return blocks;
};

const splitContentIntoQuestionChunks = (content) => {
  const normalizedContent = normalizeImportTextForParsing(content);
  if (!normalizedContent) {
    return [];
  }

  const numberedBlocks = splitNumberedQuestionBlocks(normalizedContent);
  if (numberedBlocks.length >= 2) {
    return numberedBlocks;
  }

  if (numberedBlocks.length === 1) {
    return numberedBlocks;
  }

  return [normalizedContent];
};

const detectImportQuestionType = (text) => {
  const normalized = normalizeImportTextToSingleLine(text);
  if (!normalized) return 'UNKNOWN';

  if (extractLabeledOptionsFromText(normalized).length >= 2) return 'MCQ';
  if (IMPORT_TRUE_FALSE_REGEX.test(normalized)) return 'TRUE_FALSE';
  return 'DESCRIPTIVE';
};

const normalizeImportQuestionType = (rawType) => {
  const normalized = normalizeQuestionTypeToken(rawType);
  if (!normalized) return '';
  if (
    [
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
    ].includes(normalized)
  ) {
    return normalized;
  }
  return '';
};

const extractOptionsFromChunkText = (chunkText) => {
  return extractLabeledOptionsFromText(chunkText);
};

const normalizeOptionsFromExtraction = (rawOptions, chunkText) => {
  if (Array.isArray(rawOptions)) {
    const direct = sanitizeQuestionOptions(rawOptions);
    if (direct.length >= 2) {
      return direct;
    }

    const flattened = rawOptions.map((item) => sanitizeString(item)).filter(Boolean).join(' ');
    const labeled = extractLabeledOptionsFromText(flattened);
    if (labeled.length >= 2) {
      return labeled;
    }

    return direct;
  }

  if (rawOptions && typeof rawOptions === 'object') {
    const orderedKeys = Object.keys(rawOptions)
      .sort((left, right) => left.localeCompare(right))
      .filter((key) => /^[a-h]$/i.test(key) || /^\d+$/.test(key));
    const mapped = orderedKeys
      .map((key) => sanitizeString(rawOptions[key]))
      .filter(Boolean);
    if (mapped.length) {
      return sanitizeQuestionOptions(mapped);
    }
  }

  const asString = sanitizeString(rawOptions);
  if (asString) {
    const labeledFromString = extractLabeledOptionsFromText(asString);
    if (labeledFromString.length >= 2) {
      return labeledFromString;
    }

    try {
      const parsed = JSON.parse(asString);
      if (Array.isArray(parsed)) {
        return sanitizeQuestionOptions(parsed);
      }
      if (parsed && typeof parsed === 'object') {
        const normalized = Object.values(parsed)
          .map((value) => sanitizeString(value))
          .filter(Boolean);
        if (normalized.length) {
          return sanitizeQuestionOptions(normalized);
        }
      }
    } catch {
      // Ignore parse errors and fallback to delimiters.
    }

    const delimited = asString
      .split(/[,;|\n]/)
      .map((item) => sanitizeString(item))
      .filter(Boolean);
    if (delimited.length) {
      return sanitizeQuestionOptions(delimited);
    }
  }

  return extractOptionsFromChunkText(chunkText);
};

const buildQuestionTextFromChunk = (chunkText) => {
  return buildQuestionTextFromParsedBlock(chunkText);
};

const normalizeSingleChunkQuestion = ({ extracted, chunkText, index }) => {
  const rawExtracted = extracted && typeof extracted === 'object' ? extracted : {};
  const normalizedChunkText = normalizeImportTextToSingleLine(chunkText);
  const questionText = sanitizeString(
    rawExtracted.questionText ||
      rawExtracted.question ||
      rawExtracted.question_text ||
      buildQuestionTextFromChunk(normalizedChunkText)
  );

  if (!questionText) {
    return null;
  }

  let options = normalizeOptionsFromExtraction(rawExtracted.options, normalizedChunkText);
  const parsedType = normalizeImportQuestionType(
    rawExtracted.type || rawExtracted.questionType || rawExtracted.question_type
  );
  const fallbackType = detectImportQuestionType(normalizedChunkText);

  let questionType = parsedType;
  if (!questionType) {
    if (options.length >= 2 || fallbackType === 'MCQ') {
      questionType = 'MULTIPLE_CHOICE';
    } else if (fallbackType === 'TRUE_FALSE') {
      questionType = 'TRUE_FALSE';
    } else {
      questionType = 'SHORT_ANSWER';
    }
  }

  if (questionType === 'TRUE_FALSE') {
    options = ['True', 'False'];
  } else if (!['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS'].includes(questionType)) {
    options = undefined;
  }

  console.log('[question-import-debug] BLOCK:', normalizedChunkText);
  console.log('[question-import-debug] OPTIONS:', options);
  console.log('[question-import-debug] TYPE:', questionType);

  const normalizedQuestion = normalizeQuestionObject(
    {
      questionText,
      questionType,
      options,
      correctAnswer: '',
      points: 1,
      order: index,
      passage: '',
    },
    index
  );
  if (!isValidParsedImportQuestion(normalizedQuestion)) {
    return null;
  }

  return normalizedQuestion;
};

const dedupeQuestionsByText = (questions = []) => {
  const seen = new Set();
  const deduped = [];

  (Array.isArray(questions) ? questions : []).forEach((question) => {
    const key = sanitizeString(question?.questionText).toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(question);
  });

  return deduped.map((question, index) => ({ ...question, order: index }));
};

const parseSingleChunkWithAi = async ({
  chunk,
  chunkIndex,
  trackingContext,
}) => {
  const safeChunk = sanitizeString(chunk);
  if (!safeChunk) {
    return null;
  }

  const completion = await createTrackedChatCompletion({
    client,
    feature: 'question_import',
    tenantId: trackingContext.tenantId,
    userId: trackingContext.userId,
    request: {
      model: IMPORT_EXTRACTION_MODEL,
      messages: [
        {
          role: 'system',
          content: `Extract a single question into structured JSON.

Rules:
- Identify question type:
  - If options A/B/C/D are present, set "type" to "MCQ".
  - If the question contains "True or False", set "type" to "TRUE_FALSE".
- Extract:
  - questionText
  - options (for MCQ or TRUE_FALSE)

Return format:
{
  "questionText": "",
  "type": "MCQ",
  "options": []
}`,
        },
        {
          role: 'user',
          content: safeChunk.length > MAX_IMPORT_CHUNK_PREVIEW_LENGTH
            ? safeChunk.slice(0, MAX_IMPORT_CHUNK_PREVIEW_LENGTH)
            : safeChunk,
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    },
  });

  const parsed = parseJsonObjectContent(completion?.choices?.[0]?.message?.content || '');
  return normalizeSingleChunkQuestion({
    extracted: parsed,
    chunkText: safeChunk,
    index: chunkIndex,
  });
};

const extractQuestionsFromChunkedAi = async ({
  content,
  trackingContext,
}) => {
  const rawChunks = splitContentIntoQuestionChunks(content)
    .slice(0, MAX_IMPORT_AI_CHUNKS)
    .map((chunk) => sanitizeString(chunk))
    .filter(Boolean);

  if (!rawChunks.length) {
    return [];
  }

  const indexedChunks = rawChunks.map((chunk, index) => ({ chunk, index }));
  const results = [];

  for (const batch of chunkArray(indexedChunks, MAX_PARALLEL_IMPORT_CHUNK_REQUESTS)) {
    const batchResults = await Promise.all(
      batch.map(async ({ chunk, index }) => {
        try {
          const parsed = await parseSingleChunkWithAi({
            chunk,
            chunkIndex: index,
            trackingContext,
          });
          if (parsed?.questionText) {
            return { index, question: parsed };
          }
        } catch {
          // Skip invalid chunk-level AI responses and fallback locally.
        }

        const fallbackQuestion = normalizeSingleChunkQuestion({
          extracted: null,
          chunkText: chunk,
          index,
        });
        if (!fallbackQuestion?.questionText) {
          return null;
        }
        return { index, question: fallbackQuestion };
      })
    );

    results.push(
      ...batchResults
        .filter(Boolean)
        .sort((left, right) => left.index - right.index)
        .map((item) => item.question)
    );
  }

  return dedupeQuestionsByText(results);
};

const mapAnswerTokenToOption = (token, options) => {
  const normalizedToken = sanitizeString(token);
  if (!normalizedToken) {
    return '';
  }

  if (/^[A-H]$/i.test(normalizedToken)) {
    const optionIndex = normalizedToken.toUpperCase().charCodeAt(0) - 65;
    if (Array.isArray(options) && options[optionIndex]) {
      return options[optionIndex];
    }
  }

  return normalizedToken;
};

const resolveCorrectAnswerFromRaw = ({ rawAnswer, options, questionType }) => {
  const normalizedRaw = sanitizeString(rawAnswer);
  if (!normalizedRaw) {
    return questionType === 'MULTIPLE_OPTIONS' ? [] : '';
  }

  if (questionType === 'TRUE_FALSE') {
    const lowered = normalizedRaw.toLowerCase();
    const mappedAnswer =
      lowered === 't' || lowered === 'true'
        ? 'True'
        : lowered === 'f' || lowered === 'false'
          ? 'False'
          : normalizedRaw;

    return normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: mappedAnswer,
      options: ['True', 'False'],
    });
  }

  if (questionType === 'MULTIPLE_OPTIONS') {
    const mappedAnswers = parseMultiAnswer(normalizedRaw)
      .map((token) => mapAnswerTokenToOption(token, options))
      .filter(Boolean);

    return normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: mappedAnswers,
      options,
    });
  }

  if (questionType === 'MULTIPLE_CHOICE') {
    const mappedAnswer = mapAnswerTokenToOption(normalizedRaw, options);
    return normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: mappedAnswer,
      options,
    });
  }

  return normalizeQuestionCorrectAnswer({
    questionType,
    correctAnswer: normalizedRaw,
    options,
  });
};

const normalizeParsedQuestionFromBlock = ({ block, index }) => {
  const withoutNumber = normalizeImportTextToSingleLine(
    stripLeadingQuestionNumberToken(block)
  );
  if (!withoutNumber) {
    return null;
  }

  const questionText = buildQuestionTextFromParsedBlock(withoutNumber);
  if (!questionText) {
    return null;
  }

  let options = extractLabeledOptionsFromText(withoutNumber);
  const rawAnswer = extractRawAnswerFromText(withoutNumber);
  const fallbackType = detectImportQuestionType(withoutNumber);

  let questionType = 'SHORT_ANSWER';
  if (options.length >= 2 || fallbackType === 'MCQ') {
    questionType = 'MULTIPLE_CHOICE';
  } else if (fallbackType === 'TRUE_FALSE') {
    questionType = 'TRUE_FALSE';
  }

  if (questionType === 'TRUE_FALSE') {
    options = ['True', 'False'];
  } else if (!['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS'].includes(questionType)) {
    options = undefined;
  }

  console.log('[question-import-debug] BLOCK:', block);
  console.log('[question-import-debug] OPTIONS:', options);
  console.log('[question-import-debug] TYPE:', questionType);

  const correctAnswer = resolveCorrectAnswerFromRaw({
    rawAnswer,
    options,
    questionType,
  });

  const normalizedQuestion = normalizeQuestionObject(
    {
      questionText,
      questionType,
      options,
      correctAnswer,
      points: 1,
      order: index,
      passage: '',
    },
    index
  );
  if (!isValidParsedImportQuestion(normalizedQuestion)) {
    return null;
  }

  return normalizedQuestion;
};

const extractQuestionsFromNumberedText = (content) => {
  const blocks = splitNumberedQuestionBlocks(content);
  console.log('[question-import-debug] QUESTION BLOCKS:', blocks.length);
  console.log('[question-import] Total blocks:', blocks.length);

  if (!blocks.length) {
    console.log('[question-import] Parsed questions:', 0);
    return [];
  }

  const parsed = blocks
    .map((block, idx) => normalizeParsedQuestionFromBlock({ block, index: idx }))
    .filter(Boolean);

  console.log('[question-import] Parsed questions:', parsed.length);
  parsed.forEach((question, idx) => {
    const questionText = sanitizeString(question?.questionText).slice(0, 180);
    const optionsCount = Array.isArray(question?.options) ? question.options.length : 0;
    const detectedType = sanitizeString(question?.questionType) || 'UNKNOWN';
    console.log(
      `[question-import] Q${idx + 1}: text="${questionText}" options=${optionsCount} type=${detectedType}`
    );
  });

  if (parsed.length < 1) {
    return [];
  }

  return parsed.map((question, idx) => ({ ...question, order: idx }));
};

const normalizeStructuredRow = (row, index) => {
  const normalizeLookupKey = (value) =>
    sanitizeString(value)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const loweredKeys = Object.keys(row || {}).reduce((acc, key) => {
    const lowerKey = key.toLowerCase();
    if (!acc[lowerKey]) {
      acc[lowerKey] = key;
    }
    return acc;
  }, {});

  const normalizedKeys = Object.keys(row || {}).reduce((acc, key) => {
    const normalizedKey = normalizeLookupKey(key);
    if (normalizedKey && !acc[normalizedKey]) {
      acc[normalizedKey] = key;
    }
    return acc;
  }, {});

  const get = (name) => {
    const loweredLookup = sanitizeString(name).toLowerCase();
    const loweredKey = loweredKeys[loweredLookup];
    if (loweredKey) return row[loweredKey];

    const normalizedLookup = normalizeLookupKey(name);
    const normalizedKey = normalizedKeys[normalizedLookup];
    return normalizedKey ? row[normalizedKey] : undefined;
  };

  const questionText = sanitizeString(
    get('questionText') ||
      get('question') ||
      get('prompt') ||
      get('q') ||
      row?.questionText ||
      row?.question
  );

  if (!questionText) {
    return null;
  }

  const options = collectOptionsFromRow(row);
  const answer =
    get('correctAnswer') ||
    get('correct_answer') ||
    get('correct answer') ||
    get('answer') ||
    get('correct') ||
    get('answers');
  const rawType = get('questionType') || get('type') || get('question_type');
  const questionType = inferQuestionType(rawType, options, answer, questionText);

  let normalizedOptions;
  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType)) {
    if (options.length) {
      normalizedOptions = options;
    } else if (questionType === 'TRUE_FALSE') {
      normalizedOptions = ['True', 'False'];
    } else {
      normalizedOptions = ['Option A', 'Option B', 'Option C', 'Option D'];
    }
  }

  let correctAnswer;
  if (questionType === 'MULTIPLE_OPTIONS') {
    correctAnswer = normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: answer,
      options: normalizedOptions,
    });
  } else {
    correctAnswer = normalizeQuestionCorrectAnswer({
      questionType,
      correctAnswer: answer,
      options: normalizedOptions,
    });
  }

  const pointsRaw = get('points') || get('score') || get('marks');
  const points = Number.isFinite(Number(pointsRaw)) ? Number(pointsRaw) : 1;

  const rawPassage =
    get('passage') || get('context') || get('reference') || get('reading') || row?.passage;
  const passage = sanitizeString(rawPassage);
  const paragraphGroupId = sanitizeString(
    get('paragraphGroupId') ||
      get('paragraph_group_id') ||
      get('scenarioGroupId') ||
      row?.paragraphGroupId ||
      row?.paragraph_group_id ||
      ''
  );
  const imageUrl = sanitizeString(
    get('imageUrl') ||
      get('image_url') ||
      get('imagePath') ||
      get('image_path') ||
      get('diagram') ||
      get('figure') ||
      row?.imageUrl ||
      row?.image_path ||
      ''
  );

  return {
    questionText,
    questionType,
    options: normalizedOptions,
    correctAnswer,
    points,
    order: index,
    passage,
    paragraphGroupId,
    imageUrl,
    sourceRowIndex: index,
  };
};

const buildFallbackImageBasedQuestion = ({ question, index, topic, imageType }) => {
  const normalizedBase =
    normalizeQuestionObject(question, index + 1) ||
    buildFallbackQuestionForType({
      type: sanitizeString(question?.questionType).toUpperCase() || 'MULTIPLE_CHOICE',
      index,
      topic,
    });
  const type = sanitizeString(normalizedBase.questionType).toUpperCase() || 'MULTIPLE_CHOICE';
  const imageLabel =
    imageType === 'graph'
      ? 'graph'
      : imageType === 'chart'
        ? 'chart'
        : imageType === 'object_identification'
          ? 'object image'
          : 'diagram';
  const imageAwareQuestionText =
    type === 'TRUE_FALSE'
      ? `Based on the ${imageLabel}, determine whether the following statement is true or false: ${normalizedBase.questionText}`
      : `Refer to the ${imageLabel} and answer: ${normalizedBase.questionText}`;

  const normalizedVariant = normalizeToRequestedType({
    question: {
      ...normalizedBase,
      questionText: imageAwareQuestionText,
      points: normalizedBase.points,
    },
    type,
    index,
    topic,
  });

  return {
    ...normalizedVariant,
    imagePrompt: buildFallbackImagePrompt({
      topic,
      questionText: normalizedVariant.questionText,
      imageType,
    }),
    diagramType: imageType,
  };
};

const buildFallbackImageBasedQuestionGroup = ({
  questions,
  indexes,
  topic,
  imageType,
}) => {
  const normalizedQuestions = (Array.isArray(questions) ? questions : []).map((question, localIndex) =>
    buildFallbackImageBasedQuestion({
      question,
      index: Array.isArray(indexes) && Number.isInteger(indexes[localIndex]) ? indexes[localIndex] : localIndex,
      topic,
      imageType,
    })
  );

  return {
    questions: normalizedQuestions,
    imagePrompt: buildSharedFallbackImagePrompt({
      topic,
      questions: normalizedQuestions,
      imageType,
    }),
    diagramType: imageType,
  };
};

const generateImageBasedQuestionVariant = async ({
  question,
  index,
  topic,
  difficulty,
  uploadedContent,
  examTitle,
  examDescription,
  imageType,
  tenantId = null,
  userId = null,
}) => {
  const fallbackVariant = buildFallbackImageBasedQuestion({
    question,
    index,
    topic,
    imageType,
  });

  if (!client) {
    return fallbackVariant;
  }

  const normalizedBase = normalizeQuestionObject(question, index + 1);
  if (!normalizedBase) {
    return fallbackVariant;
  }

  const safeImageType = pickRandomImageType([imageType]);
  const baseQuestionPayload = {
    questionText: normalizedBase.questionText,
    questionType: normalizedBase.questionType,
    options: Array.isArray(normalizedBase.options) ? normalizedBase.options : [],
    correctAnswer: normalizedBase.correctAnswer,
    passage: normalizedBase.passage || '',
    points: normalizedBase.points || 1,
  };

  const systemPrompt = `You create image-dependent exam questions.

Return JSON with:
- questionText
- questionType
- options
- correctAnswer
- passage
- points
- imagePrompt
- diagramType

Rules:
- Keep questionType EXACTLY as ${normalizedBase.questionType}
- The question MUST require the student to inspect a ${safeImageType.replace(/_/g, ' ')}
- Keep the question academically aligned with the topic and requested difficulty
- For MULTIPLE_CHOICE and TRUE_FALSE, correctAnswer must be a single option string from options
- For MULTIPLE_OPTIONS, correctAnswer must be an array of exact option strings
- For SHORT_ANSWER, PARAGRAPH, ESSAY, ESSAY_LETTER, ESSAY_STORY, and NUMBER do not invent options
- Preserve any provided passage/context when the base question includes one
- imagePrompt must be a concise but specific prompt for generating the educational image
- diagramType must be one of: ${VALID_IMAGE_QUESTION_TYPES.join(', ')}
- Do not mention missing images, placeholders, or instructions for the test creator`;

  const uploadedExcerpt = sanitizeString(uploadedContent).slice(0, 1200);

  const userPrompt = `Convert this question into an image-based question.

Topic: ${sanitizeString(topic)}
Difficulty: ${sanitizeString(difficulty)}
Requested image type: ${safeImageType}
${sanitizeString(examTitle) ? `Exam title: ${sanitizeString(examTitle)}` : ''}
${sanitizeString(examDescription) ? `Exam description: ${sanitizeString(examDescription).slice(0, 400)}` : ''}
${uploadedExcerpt ? `Relevant source content:\n${uploadedExcerpt}` : ''}

Base question:
${JSON.stringify(baseQuestionPayload)}

Create one improved image-based variant now.`;

  try {
    const completion = await createTrackedChatCompletion({
      client,
      feature: 'question_generation',
      tenantId,
      userId,
      request: {
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      },
    });

    const responseContent = completion?.choices?.[0]?.message?.content || '{}';
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseContent);
    } catch {
      const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      parsedResponse = jsonMatch ? JSON.parse(jsonMatch[1]) : {};
    }

    const normalizedVariant = normalizeToRequestedType({
      question: {
        ...parsedResponse,
        questionType: normalizedBase.questionType,
        passage: sanitizeString(parsedResponse?.passage || normalizedBase.passage),
        paragraphGroupId: sanitizeString(parsedResponse?.paragraphGroupId || normalizedBase.paragraphGroupId),
        points: Number.isFinite(Number(parsedResponse?.points))
          ? Number(parsedResponse.points)
          : normalizedBase.points,
      },
      type: normalizedBase.questionType,
      index,
      topic,
    });

    return {
      ...normalizedVariant,
      imagePrompt:
        sanitizeString(parsedResponse?.imagePrompt) ||
        buildFallbackImagePrompt({
          topic,
          questionText: normalizedVariant.questionText,
          imageType: safeImageType,
        }),
      diagramType:
        sanitizeString(parsedResponse?.diagramType).toLowerCase() && VALID_IMAGE_QUESTION_TYPES.includes(sanitizeString(parsedResponse?.diagramType).toLowerCase())
          ? sanitizeString(parsedResponse.diagramType).toLowerCase()
          : safeImageType,
    };
  } catch (error) {
    console.warn('Falling back to local image-based question variant:', error?.message || error);
    return fallbackVariant;
  }
};

const generateImageBasedQuestionGroup = async ({
  questions,
  indexes,
  topic,
  difficulty,
  uploadedContent,
  examTitle,
  examDescription,
  imageType,
  tenantId = null,
  userId = null,
}) => {
  const groupQuestions = Array.isArray(questions) ? questions : [];
  const safeIndexes = Array.isArray(indexes) ? indexes : [];
  const safeImageType = pickRandomImageType([imageType]);

  if (groupQuestions.length <= 1) {
    const variant = await generateImageBasedQuestionVariant({
      question: groupQuestions[0],
      index: Number.isInteger(safeIndexes[0]) ? safeIndexes[0] : 0,
      topic,
      difficulty,
      uploadedContent,
      examTitle,
      examDescription,
      imageType: safeImageType,
      tenantId,
      userId,
    });

    return {
      questions: [variant],
      imagePrompt:
        sanitizeString(variant.imagePrompt) ||
        buildSharedFallbackImagePrompt({
          topic,
          questions: [variant],
          imageType: safeImageType,
        }),
      diagramType: sanitizeString(variant.diagramType).toLowerCase() || safeImageType,
    };
  }

  const fallbackGroup = buildFallbackImageBasedQuestionGroup({
    questions: groupQuestions,
    indexes: safeIndexes,
    topic,
    imageType: safeImageType,
  });

  if (!client) {
    return fallbackGroup;
  }

  const normalizedBases = groupQuestions
    .map((question, localIndex) =>
      normalizeQuestionObject(
        question,
        Number.isInteger(safeIndexes[localIndex]) ? safeIndexes[localIndex] + 1 : localIndex + 1
      )
    )
    .filter(Boolean);

  if (normalizedBases.length !== groupQuestions.length) {
    return fallbackGroup;
  }

  const baseQuestionPayload = normalizedBases.map((question) => ({
    questionText: question.questionText,
    questionType: question.questionType,
    options: Array.isArray(question.options) ? question.options : [],
    correctAnswer: question.correctAnswer,
    passage: question.passage || '',
    points: question.points || 1,
  }));

  const systemPrompt = `You create sets of exam questions that all depend on one shared educational image.

Return JSON with:
- imagePrompt
- diagramType
- questions: array of exactly ${normalizedBases.length} question objects in the SAME ORDER as the input questions

Each question object must include:
- questionText
- questionType
- options
- correctAnswer
- passage
- points

Rules:
- All returned questions MUST be answerable by inspecting the SAME shared ${safeImageType.replace(/_/g, ' ')}
- Keep each questionType EXACTLY aligned to its matching input question type
- The shared image must be rich enough to support every question in the set
- For MULTIPLE_CHOICE and TRUE_FALSE, correctAnswer must be one option string from options
- For MULTIPLE_OPTIONS, correctAnswer must be an array of exact option strings from options
- For SHORT_ANSWER, PARAGRAPH, ESSAY, ESSAY_LETTER, ESSAY_STORY, and NUMBER do not invent unnecessary options
- Preserve any provided passage/context when a base question includes one
- diagramType must be one of: ${VALID_IMAGE_QUESTION_TYPES.join(', ')}
- Do not mention placeholders, missing images, or test-creator instructions
- Make each question clearly refer to the shared image`;

  const uploadedExcerpt = sanitizeString(uploadedContent).slice(0, 1200);

  const userPrompt = `Create ${normalizedBases.length} related image-based questions that all use one shared image.

Topic: ${sanitizeString(topic)}
Difficulty: ${sanitizeString(difficulty)}
Requested image type: ${safeImageType}
${sanitizeString(examTitle) ? `Exam title: ${sanitizeString(examTitle)}` : ''}
${sanitizeString(examDescription) ? `Exam description: ${sanitizeString(examDescription).slice(0, 400)}` : ''}
${uploadedExcerpt ? `Relevant source content:\n${uploadedExcerpt}` : ''}

Base questions in required order:
${JSON.stringify(baseQuestionPayload)}`;

  try {
    const completion = await createTrackedChatCompletion({
      client,
      feature: 'question_generation',
      tenantId,
      userId,
      request: {
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      },
    });

    const responseContent = completion?.choices?.[0]?.message?.content || '{}';
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseContent);
    } catch {
      const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      parsedResponse = jsonMatch ? JSON.parse(jsonMatch[1]) : {};
    }

    const parsedQuestions = Array.isArray(parsedResponse?.questions) ? parsedResponse.questions : [];
    const normalizedQuestions = normalizedBases.map((baseQuestion, localIndex) =>
      normalizeToRequestedType({
        question: {
          ...baseQuestion,
          ...(parsedQuestions[localIndex] && typeof parsedQuestions[localIndex] === 'object'
            ? parsedQuestions[localIndex]
            : {}),
          questionType: baseQuestion.questionType,
          passage: sanitizeString(parsedQuestions?.[localIndex]?.passage || baseQuestion.passage),
          paragraphGroupId: sanitizeString(
            parsedQuestions?.[localIndex]?.paragraphGroupId || baseQuestion.paragraphGroupId
          ),
          points: Number.isFinite(Number(parsedQuestions?.[localIndex]?.points))
            ? Number(parsedQuestions[localIndex].points)
            : baseQuestion.points,
        },
        type: baseQuestion.questionType,
        index: Number.isInteger(safeIndexes[localIndex]) ? safeIndexes[localIndex] : localIndex,
        topic,
      })
    );

    return {
      questions: normalizedQuestions,
      imagePrompt:
        sanitizeString(parsedResponse?.imagePrompt) ||
        buildSharedFallbackImagePrompt({
          topic,
          questions: normalizedQuestions,
          imageType: safeImageType,
        }),
      diagramType:
        sanitizeString(parsedResponse?.diagramType).toLowerCase() &&
        VALID_IMAGE_QUESTION_TYPES.includes(sanitizeString(parsedResponse?.diagramType).toLowerCase())
          ? sanitizeString(parsedResponse.diagramType).toLowerCase()
          : safeImageType,
    };
  } catch (error) {
    console.warn('Falling back to local shared image-based question group:', error?.message || error);
    return fallbackGroup;
  }
};

const attachImageBasedQuestions = async ({
  questions,
  imageConfig,
  topic,
  difficulty,
  uploadedContent,
  examTitle,
  examDescription,
  tenantId = null,
  userId = null,
}) => {
  const safeQuestions = Array.isArray(questions) ? [...questions] : [];
  if (!safeQuestions.length || !imageConfig?.enabled || imageConfig.count <= 0) {
    return safeQuestions.map((question, index) => ({ ...question, order: index + 1 }));
  }

  const candidateIndexes = shuffleArray(
    Array.from({ length: safeQuestions.length }, (_, index) => index)
  );
  const desiredImageQuestionCount = Math.min(imageConfig.count, safeQuestions.length);
  if (!candidateIndexes.length || desiredImageQuestionCount <= 0) {
    return safeQuestions.map((question, index) => ({ ...question, order: index + 1 }));
  }

  const enhancedQuestions = [...safeQuestions];
  let successfulImageQuestions = 0;
  const selectedIndexes = candidateIndexes
    .slice(0, desiredImageQuestionCount)
    .sort((left, right) => left - right);
  const imageQuestionGroups = chunkArray(
    selectedIndexes,
    Math.max(1, imageConfig.questionsPerImage || DEFAULT_IMAGE_QUESTIONS_PER_IMAGE)
  );

  for (
    let start = 0;
    start < imageQuestionGroups.length && successfulImageQuestions < desiredImageQuestionCount;
    start += MAX_PARALLEL_IMAGE_VARIANTS
  ) {
    const batchGroups = imageQuestionGroups.slice(start, start + MAX_PARALLEL_IMAGE_VARIANTS);

    const batchResults = await Promise.all(
      batchGroups.map(async (groupIndexes) => {
        const baseQuestions = groupIndexes.map((questionIndex) => enhancedQuestions[questionIndex]);
        const imageType = pickRandomImageType(imageConfig.imageTypes);
        const groupResult = await generateImageBasedQuestionGroup({
          questions: baseQuestions,
          indexes: groupIndexes,
          topic,
          difficulty,
          uploadedContent,
          examTitle,
          examDescription,
          imageType,
          tenantId,
          userId,
        });
        const imageFields = await createGeneratedQuestionImage({
          questionId: `ai-question-group-${Date.now()}-${groupIndexes[0] + 1}`,
          questionText: groupResult.questions.map((question) => sanitizeString(question.questionText)).join(' '),
          diagramType: groupResult.diagramType || imageType,
          imagePrompt: groupResult.imagePrompt,
          fileStem: `ai-${groupResult.diagramType || imageType}`,
        });
        const hasImageAsset = Boolean(
          sanitizeString(
            imageFields.imageUrl ||
            imageFields.image_path ||
            imageFields.imageBase64 ||
            imageFields.image_base64 ||
            imageFields.image
          )
        );

        return {
          groupIndexes,
          hasImageAsset,
          originalQuestions: baseQuestions,
          nextQuestions: groupIndexes.map((questionIndex, localIndex) => ({
            ...enhancedQuestions[questionIndex],
            ...(groupResult.questions[localIndex] || {}),
            ...imageFields,
            isImageBased: Boolean(
              sanitizeString(
                imageFields.imageUrl ||
                imageFields.image_path ||
                imageFields.generatedImage ||
                imageFields.imageBase64 ||
                imageFields.image
              )
            ),
            aiImageType: groupResult.diagramType || imageType,
          })),
        };
      })
    );

    batchResults.forEach(({ groupIndexes, nextQuestions, hasImageAsset, originalQuestions }) => {
      groupIndexes.forEach((questionIndex, localIndex) => {
        if (hasImageAsset && successfulImageQuestions < desiredImageQuestionCount) {
          enhancedQuestions[questionIndex] = nextQuestions[localIndex];
          successfulImageQuestions += 1;
          return;
        }

        enhancedQuestions[questionIndex] = {
          ...originalQuestions[localIndex],
          isImageBased: false,
        };
      });
    });
  }

  return enhancedQuestions.map((question, index) => ({ ...question, order: index + 1 }));
};

const extractQuestionsFallback = ({ content, structuredRows }) => {
  if (Array.isArray(structuredRows) && structuredRows.length) {
    const normalizedFromRows = structuredRows
      .map((row, idx) => normalizeStructuredRow(row, idx))
      .filter(Boolean);
    if (normalizedFromRows.length) {
      return normalizedFromRows;
    }
  }

  const parsedFromNumbering = extractQuestionsFromNumberedText(content);
  if (parsedFromNumbering.length) {
    return parsedFromNumbering;
  }

  const blocks = content
    .split(/\n{2,}/)
    .map((block) => sanitizeString(block))
    .filter((block) => block.length > 0)
    .slice(0, 20);

  if (!blocks.length) {
    return [];
  }

  return blocks.map((text, idx) => ({
    questionText: text,
    questionType: text.length > 220 ? 'PARAGRAPH' : 'SHORT_ANSWER',
    points: 1,
    correctAnswer: '',
    order: idx,
    passage: text.length > 220 ? text : '',
  }));
};

const generateFallbackQuestions = async (params) => {
  const {
    topic,
    count,
    questionTypes = ['MULTIPLE_CHOICE'],
    scenarioQuestionTypes = ['PARAGRAPH'],
    questionTypeDistribution,
    questionSorting = 'MIX_ALL',
    questionSortPattern = [],
    difficulty,
    uploadedContent,
    examTitle,
    examDescription,
    enableImageQuestions = false,
    imageQuestionCount = 0,
    imageQuestionRatio = 0,
    imageQuestionPerCount = 5,
    imageQuestionsPerImage = DEFAULT_IMAGE_QUESTIONS_PER_IMAGE,
    questionsPerParagraph = DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH,
    imageQuestionMode = 'percentage',
    imageQuestionTypes = [],
    metadata = null,
    tenantId = null,
    userId = null,
  } = params || {};
  const trackingContext = resolveTrackingContext({ tenantId, userId, metadata });

  const safeCount = Math.max(1, parseCount(count, 5));
  const imageConfig = normalizeImageQuestionConfig({
    enableImageQuestions,
    imageQuestionCount,
    imageQuestionRatio,
    imageQuestionPerCount,
    imageQuestionsPerImage,
    imageQuestionMode,
    imageQuestionTypes,
    count: safeCount,
  });
  const normalizedTypes = normalizeRequestedQuestionTypes(questionTypes);
  const effectiveImageConfig =
    normalizedTypes.length === 0 && imageConfig.enabled
      ? {
          ...imageConfig,
          enabled: true,
          count: safeCount,
          ratioPercent: 100,
          perCount: 1,
        }
      : imageConfig;
  const safeQuestionTypes = (() => {
    if (normalizedTypes.length > 0) {
      return normalizedTypes;
    }
    return ['MULTIPLE_CHOICE'];
  })();
  const typeDistribution = buildQuestionTypeDistribution({
    questionTypes: safeQuestionTypes,
    questionTypeDistribution,
    count: safeCount,
  });

  const questions = [];
  typeDistribution.forEach(({ type, count: typeCount }) => {
    for (let i = 0; i < typeCount; i += 1) {
      questions.push(
        buildFallbackQuestionForType({
          type,
          index: questions.length,
          topic,
        })
      );
    }
  });

  const distributedQuestions = enforceQuestionDistribution({
    questions,
    typeDistribution,
    count: safeCount,
    topic,
  });
  const paragraphEnhancedQuestions = await enhanceParagraphScenarioQuestions({
    questions: distributedQuestions,
    questionsPerParagraph: normalizeQuestionsPerParagraph(
      questionsPerParagraph,
      DEFAULT_PARAGRAPH_QUESTIONS_PER_PARAGRAPH,
      safeCount
    ),
    scenarioQuestionTypes,
    topic,
    difficulty,
    uploadedContent,
    examTitle,
    examDescription,
    tenantId: trackingContext.tenantId,
    userId: trackingContext.userId,
  });

  const imageEnhancedQuestions = await attachImageBasedQuestions({
    questions: paragraphEnhancedQuestions,
    imageConfig: effectiveImageConfig,
    topic,
    difficulty,
    uploadedContent,
    examTitle,
    examDescription,
    tenantId: trackingContext.tenantId,
    userId: trackingContext.userId,
  });
  return applyQuestionSorting({
    questions: imageEnhancedQuestions,
    questionSorting,
    questionSortPattern,
    questionTypes: safeQuestionTypes,
  });
};

/**
 * Fallback answer evaluation using keyword matching
 */
const evaluateFallbackAnswer = (params) => {
  const {
    correctAnswer,
    studentAnswer,
    points,
    rubric = [],
    evaluationConfig = {},
    questionType = '',
  } = params;
  const maxPoints = Math.max(Number(points) || 0, 0);
  const effectiveRubric = buildSemanticRubric({ evaluationConfig, rubric, points: maxPoints, questionType });
  const config = evaluationConfig && typeof evaluationConfig === 'object' ? evaluationConfig : {};

  if (!correctAnswer || !studentAnswer) {
    return {
      score: 0,
      feedback: 'Unable to evaluate - missing reference answer',
      strengths: [],
      weaknesses: ['Reference answer or student answer is missing.'],
      confidence: 0.5,
      isCorrect: false,
      pointsEarned: 0,
      needsReview: true,
      mode: 'semantic_rubric_fallback',
      evaluationMethod: 'fallback_reference_similarity',
      rubric: effectiveRubric,
      rubricScores: [],
      rubricTotal: 0,
      correctConcepts: [],
      missingConcepts: normalizeEvaluationList(config.expectedConcepts || config.keyPoints),
      incorrectStatements: [],
    };
  }

  // A conservative offline fallback: exact normalized alternatives are accepted,
  // otherwise it reports limited lexical overlap and requests human review. It
  // deliberately does not pretend to perform semantic AI evaluation offline.
  const correctLower = normalizeEvaluationText(correctAnswer);
  const studentLower = normalizeEvaluationText(studentAnswer);
  const alternatives = [
    correctLower,
    ...normalizeEvaluationList(config.acceptableAnswers || config.acceptableAlternatives)
      .map(normalizeEvaluationText),
  ].filter(Boolean);
  const equivalentConfiguredAnswer = alternatives.includes(studentLower);
  const correctWords = new Set(correctLower.split(/\s+/).filter((word) => word.length > 1));
  const studentWords = new Set(studentLower.split(/\s+/).filter((word) => word.length > 1));
  const matchingWords = Array.from(correctWords).filter((word) => studentWords.has(word));
  const similarity = equivalentConfiguredAnswer
    ? 1
    : matchingWords.length / Math.max(correctWords.size, 1);

  const isCorrect = similarity > 0.6;
  const pointsEarned = Number((maxPoints * similarity).toFixed(2));
  const confidence = equivalentConfiguredAnswer ? 0.9 : Math.min(similarity + 0.1, 0.7);
  const feedback = isCorrect
    ? 'Answer appears to be correct based on keyword matching.'
    : 'Answer may need review. Consider providing more detail.';
  const fallbackResult = {
    score: pointsEarned,
    feedback,
    strengths: isCorrect
      ? ['Covers key expected terms from the reference answer.']
      : ['Shows partial overlap with expected keywords.'],
    weaknesses: isCorrect
      ? ['Could include clearer explanation for stronger confidence.']
      : ['Missing important expected keywords and concepts.'],
    confidence,
    isCorrect,
    pointsEarned,
    needsReview: confidence < 0.8,
    mode: 'semantic_rubric_fallback',
    evaluationMethod: equivalentConfiguredAnswer
      ? 'configured_alternative_exact_match'
      : 'fallback_reference_similarity',
    rubric: effectiveRubric,
    rubricScores: [],
    rubricTotal: pointsEarned,
    correctConcepts: equivalentConfiguredAnswer ? ['Matched a configured acceptable answer.'] : [],
    missingConcepts: similarity < 1 ? normalizeEvaluationList(config.expectedConcepts || config.keyPoints) : [],
    incorrectStatements: [],
  };

  if (effectiveRubric.length > 0) {
    fallbackResult.rubricScores = effectiveRubric.map((item) => {
      const maxScore = Number(item.maxScore || 0);
      return {
        criterion: item.criterion,
        weight: Number(item.weight || 0),
        score: Number((maxScore * similarity).toFixed(2)),
        maxScore,
        rationale: equivalentConfiguredAnswer
          ? 'Matched a configured acceptable answer.'
          : 'Fallback score based on limited reference overlap; manual review is recommended.',
      };
    });
  }

  return fallbackResult;
};
