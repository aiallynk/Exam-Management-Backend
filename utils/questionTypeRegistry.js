/**
 * Canonical question-type registry — the single authoritative source for
 * question-type shape rules on the backend (mirrors
 * Exam-Management-Frontend/src/lib/questionTypeRegistry.js). `id` matches
 * models/Question.js's `questionType` enum exactly, so this introduces no
 * schema/migration change — it only centralizes the alias/shape knowledge
 * that was previously scattered across normalizeQuestionTypeToken,
 * normalizeQuestionCorrectAnswer, and enforceQuestionDistribution.
 */
export const QUESTION_TYPE_REGISTRY = [
  {
    id: 'MULTIPLE_CHOICE',
    canonicalId: 'single_choice',
    label: 'Multiple Choice',
    requiresOptions: true,
    minimumOptions: 2,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['mcq', 'multiple_choice', 'single_choice', 'single_choice_mcq', 'radio', 'image_based', 'image-based', 'image'],
  },
  {
    id: 'MULTIPLE_OPTIONS',
    canonicalId: 'multiple_select',
    label: 'Multiple Select',
    requiresOptions: true,
    minimumOptions: 2,
    allowsMultipleCorrectAnswers: true,
    // A "multiple select" question with only one correct option is
    // structurally indistinguishable from single-choice — the master
    // requirement is explicit that this must never happen silently.
    minimumCorrectAnswers: 2,
    requiresNumericAnswer: false,
    aliases: [
      'multiple_select', 'multi_select', 'multiple_select_mcq', 'multi_select_mcq',
      'multiple_correct', 'checkbox', 'multi_choice', 'multiselect', 'multi_select_mcq',
    ],
  },
  {
    id: 'TRUE_FALSE',
    canonicalId: 'true_false',
    label: 'True / False',
    requiresOptions: true,
    minimumOptions: 2,
    maximumOptions: 2,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['true_false', 'truefalse', 'tf', 'true/false'],
  },
  {
    id: 'FILL_IN_THE_BLANK',
    canonicalId: 'fill_blank',
    label: 'Fill in the Blank',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['fill_blank', 'fill_in_the_blank', 'fill_in_blank', 'fillintheblank', 'fib'],
  },
  {
    id: 'SHORT_ANSWER',
    canonicalId: 'short_answer',
    label: 'Short Answer',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['short_answer', 'short', 'shortanswer'],
  },
  {
    id: 'PARAGRAPH',
    canonicalId: 'long_answer',
    label: 'Paragraph',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['long_answer', 'longanswer', 'descriptive', 'paragraph', 'scenario'],
  },
  {
    id: 'ESSAY',
    canonicalId: 'essay',
    label: 'Essay',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['essay'],
  },
  {
    id: 'ESSAY_LETTER',
    canonicalId: 'essay_letter',
    label: 'Letter Writing',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['essay_letter', 'letter_writing', 'letter'],
  },
  {
    id: 'ESSAY_STORY',
    canonicalId: 'essay_story',
    label: 'Story Writing',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['essay_story', 'story_writing', 'story'],
  },
  {
    id: 'NUMBER',
    canonicalId: 'numeric',
    label: 'Numeric',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: true,
    aliases: ['numeric', 'numerical', 'numeric_answer', 'number'],
  },
  {
    id: 'MATCHING',
    canonicalId: 'matching',
    label: 'Matching',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['matching', 'match', 'match_the_following', 'matching_pairs'],
  },
  {
    id: 'CODING',
    canonicalId: 'coding',
    label: 'Coding Question',
    requiresOptions: false,
    allowsMultipleCorrectAnswers: false,
    requiresNumericAnswer: false,
    aliases: ['coding', 'code'],
  },
];

const normalizeKey = (value) =>
  String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const ALIAS_INDEX = new Map();
QUESTION_TYPE_REGISTRY.forEach((definition) => {
  const keys = new Set(
    [definition.id, definition.canonicalId, ...(definition.aliases || [])]
      .filter(Boolean)
      .map(normalizeKey)
  );
  keys.forEach((key) => ALIAS_INDEX.set(key, definition));
});

/** Resolve any spelling to its registry entry, or null if genuinely unknown. */
export function getQuestionTypeDefinition(input) {
  if (!input) return null;
  return ALIAS_INDEX.get(normalizeKey(input)) || null;
}

/** The canonical backend storage id (e.g. 'MULTIPLE_OPTIONS') for any spelling, or null if unknown. */
export function normalizeQuestionType(input) {
  return getQuestionTypeDefinition(input)?.id || null;
}

export const STORABLE_TYPE_IDS = QUESTION_TYPE_REGISTRY.map((definition) => definition.id);

/**
 * Structural validation for a just-generated/normalized question against
 * its OWN claimed questionType — independent of whether it matches what
 * was requested. Used to keep genuinely well-shaped AI candidates separate
 * from mislabeled/malformed ones before they are pooled by type.
 *
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateGeneratedQuestionShape(question) {
  const definition = getQuestionTypeDefinition(question?.questionType);
  if (!definition) {
    return { valid: false, reason: `Unknown question type: ${question?.questionType}` };
  }

  if (definition.requiresOptions) {
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < (definition.minimumOptions || 2)) {
      return { valid: false, reason: `${definition.label} requires at least ${definition.minimumOptions || 2} options` };
    }
  } else if (Array.isArray(question.options) && question.options.length > 0) {
    return { valid: false, reason: `${definition.label} must not have options` };
  }

  if (definition.allowsMultipleCorrectAnswers) {
    const answers = Array.isArray(question.correctAnswer) ? question.correctAnswer : [];
    if (answers.length < (definition.minimumCorrectAnswers || 1)) {
      return { valid: false, reason: `${definition.label} requires at least ${definition.minimumCorrectAnswers || 1} correct answers, got ${answers.length}` };
    }
  }

  if (definition.requiresNumericAnswer) {
    const answer = question.correctAnswer;
    if (answer === undefined || answer === null || answer === '' || !Number.isFinite(Number(answer))) {
      return { valid: false, reason: `${definition.label} requires a numeric correct answer` };
    }
  }

  return { valid: true };
}

/**
 * Compares a requested per-type distribution (e.g. from questionTypeDistribution
 * in the generation request) against what was actually generated. Pure and
 * side-effect-free so it's independently unit-testable from the route layer.
 *
 * @param {{type:string, count:number}[]} requestedDistribution
 * @param {{questionType:string}[]} generatedQuestions
 * @returns {{ requested: Record<string,number>, generated: Record<string,number>, validationStatus: 'unspecified'|'valid'|'mismatch' }}
 */
export function computeDistributionDiagnostics(requestedDistribution, generatedQuestions) {
  const requested = {};
  (Array.isArray(requestedDistribution) ? requestedDistribution : []).forEach((item) => {
    const type = normalizeQuestionType(item?.type) || String(item?.type || '').trim().toUpperCase();
    const itemCount = Math.max(0, Number.parseInt(item?.count, 10) || 0);
    if (type && itemCount > 0) {
      requested[type] = (requested[type] || 0) + itemCount;
    }
  });

  const generated = {};
  (Array.isArray(generatedQuestions) ? generatedQuestions : []).forEach((question) => {
    const type = question?.questionType || 'UNKNOWN';
    generated[type] = (generated[type] || 0) + 1;
  });

  const requestedTypes = Object.keys(requested);
  const countsMatch = requestedTypes.every((type) => requested[type] === (generated[type] || 0));
  const noUnexpectedTypes = Object.keys(generated).every((type) => requested[type] !== undefined);
  const validationStatus = requestedTypes.length === 0
    ? 'unspecified'
    : (countsMatch && noUnexpectedTypes ? 'valid' : 'mismatch');

  return { requested, generated, validationStatus };
}
