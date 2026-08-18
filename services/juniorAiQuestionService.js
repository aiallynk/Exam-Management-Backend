import { generateDeterministicQuestion } from './wizKidsQuestionGeneratorService.js';

const DIFFICULTY_DIGIT_BONUS = Object.freeze({ easy: 0, medium: 0, hard: 1, ultra_hard: 1 });

const resolveStrategy = ({ topic, domains }) => {
  const normalizedTopic = String(topic || '').toLowerCase();
  if (domains.includes('VEDIC_MATHS')) {
    if (normalizedTopic.includes('11')) return 'VEDIC_TIMES_ELEVEN';
    if (normalizedTopic.includes('square') || normalizedTopic.includes('ending')) return 'VEDIC_SQUARE_ENDING_FIVE';
    return 'VEDIC_NEAR_BASE';
  }
  if (domains.includes('SUPER_MATHS')) return 'SUPER_CHALLENGE';
  if (normalizedTopic.includes('mixed') || normalizedTopic.includes('chain')) return 'CHAIN';
  if (normalizedTopic.includes('subtract')) return 'ARITHMETIC_SUBTRACTION';
  if (normalizedTopic.includes('multiply') || normalizedTopic.includes('multiplication')) return 'ARITHMETIC_MULTIPLICATION';
  if (normalizedTopic.includes('divide') || normalizedTopic.includes('division')) return 'ARITHMETIC_DIVISION';
  return 'ARITHMETIC_ADDITION';
};

const buildTemplate = ({ gradeLevel, difficulty, domains, topic }) => {
  const strategyKey = resolveStrategy({ topic, domains });
  const baseDigits = gradeLevel <= 2 ? 1 : gradeLevel <= 4 ? 2 : 3;
  const maximumDigits = Math.min(4, baseDigits + (DIFFICULTY_DIGIT_BONUS[difficulty] || 0));
  const operation = strategyKey.replace('ARITHMETIC_', '');
  const strategy = strategyKey.startsWith('ARITHMETIC_') ? 'ARITHMETIC' : strategyKey;
  return {
    templateKey: `JUNIOR_AI_${strategyKey}_G${gradeLevel}_${String(difficulty).toUpperCase()}`,
    version: 1,
    domain: domains[0] || 'MENTAL_MATHS',
    gradeLevel,
    topic,
    difficulty: String(difficulty || 'medium').toUpperCase(),
    strategy,
    rules: strategy === 'CHAIN'
      ? { operandCount: difficulty === 'ultra_hard' ? 6 : 4, digits: { minimum: 1, maximum: maximumDigits }, negativeAnswers: { allowed: false } }
      : { operation, digits: { minimum: 1, maximum: maximumDigits }, negativeAnswers: { allowed: false }, carry: { allowed: difficulty !== 'easy' } },
  };
};

export const generateJuniorDeterministicNumberQuestions = ({
  count,
  difficulty,
  juniorContext,
  topic,
  seedBase,
}) => {
  const gradeLevel = Number(juniorContext?.gradeLevel);
  const domains = Array.isArray(juniorContext?.domains) ? juniorContext.domains : [];
  const template = buildTemplate({ gradeLevel, difficulty, domains, topic });
  return Array.from({ length: Number(count) || 0 }, (_, index) => {
    const generated = generateDeterministicQuestion({
      template,
      seed: `${seedBase}:${index + 1}`,
    });
    return {
      questionText: generated.questionContent,
      questionType: 'NUMBER',
      correctAnswer: generated.correctAnswer,
      points: 1,
      order: index + 1,
      difficulty: String(difficulty || 'medium'),
      explanation: generated.explanation,
      solution: generated.solution,
      generatorMetadata: generated.generatorMetadata,
    };
  });
};

