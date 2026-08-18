// WizKids Phases 9-10 — deterministic Mental, Vedic, and Super Maths.
//
// No provider/LLM is involved in operands, answers, or validation. The
// generator is intentionally pure: template rules + template version + seed
// always produce the same question and answer.

export class WizKidsGeneratorError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsGeneratorError';
    this.status = status;
  }
}

export const hashSeed = (value) => {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const createSeededRandom = (seed) => {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInteger = (random, min, max) => Math.floor(random() * (max - min + 1)) + min;
const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readDigits = (rules = {}) => {
  const minimum = asPositiveInteger(rules?.digits?.minimum ?? rules?.digits?.min, 1);
  const maximum = Math.max(minimum, asPositiveInteger(rules?.digits?.maximum ?? rules?.digits?.max, minimum));
  return { minimum, maximum };
};

const randomDigitsNumber = (random, { minimum, maximum }) => {
  const digits = randomInteger(random, minimum, maximum);
  const lower = digits === 1 ? 1 : 10 ** (digits - 1);
  const upper = 10 ** digits - 1;
  return randomInteger(random, lower, upper);
};

const numberWithCarry = (random, digits) => {
  // Two same-width numbers that are guaranteed to carry in at least one
  // column. This is finite/deterministic and never depends on retries from an
  // external source.
  const lower = digits === 1 ? 1 : 10 ** (digits - 1);
  const upper = 10 ** digits - 1;
  let left = randomInteger(random, lower, upper);
  // A zero units digit cannot itself force a units-column carry. Nudge it to
  // a non-zero digit while retaining the requested width.
  if (left % 10 === 0) left = left === upper ? left - 1 : left + 1;
  const unitsNeeded = 10 - (left % 10);
  const rawRight = randomInteger(random, lower, upper);
  let right = rawRight - (rawRight % 10) + randomInteger(random, unitsNeeded, 9);
  if (right > upper) right -= 10;
  if (right < lower) right += 10;
  return [left, right];
};

const formatNumber = (value) => String(value);
const formatExpression = (operands, operator) => operands.map(formatNumber).join(` ${operator} `);

const arithmetic = ({ rules, random }) => {
  const operation = String(rules.operation || 'ADDITION').toUpperCase();
  const digits = readDigits(rules);
  let left = randomDigitsNumber(random, digits);
  let right = randomDigitsNumber(random, digits);

  if (operation === 'ADDITION') {
    if (rules?.carry?.allowed === true) [left, right] = numberWithCarry(random, digits.maximum);
    const answer = left + right;
    return { question: `${left} + ${right}`, answer, solution: `${left} + ${right} = ${answer}` };
  }
  if (operation === 'SUBTRACTION') {
    if (rules?.negativeAnswers?.allowed !== true && right > left) [left, right] = [right, left];
    const answer = left - right;
    return { question: `${left} − ${right}`, answer, solution: `${left} − ${right} = ${answer}` };
  }
  if (operation === 'MULTIPLICATION') {
    right = randomInteger(random, 2, Math.max(2, Math.min(12, right)));
    const answer = left * right;
    return { question: `${left} × ${right}`, answer, solution: `${left} × ${right} = ${answer}` };
  }
  if (operation === 'DIVISION') {
    const divisor = randomInteger(random, 2, 12);
    const quotient = randomDigitsNumber(random, { minimum: 1, maximum: Math.max(1, digits.maximum - 1) });
    const dividend = divisor * quotient;
    return { question: `${dividend} ÷ ${divisor}`, answer: quotient, solution: `${dividend} ÷ ${divisor} = ${quotient}` };
  }
  throw new WizKidsGeneratorError(400, `Unsupported arithmetic operation: ${operation}.`);
};

const multiAdd = ({ rules, random }) => {
  const count = Math.max(3, Math.min(8, asPositiveInteger(rules.operandCount, 4)));
  const operands = Array.from({ length: count }, () => randomDigitsNumber(random, readDigits(rules)));
  const answer = operands.reduce((total, value) => total + value, 0);
  return { question: formatExpression(operands, '+'), answer, solution: `${formatExpression(operands, '+')} = ${answer}` };
};

const chain = ({ rules, random }) => {
  const count = Math.max(3, Math.min(8, asPositiveInteger(rules.operandCount, 4)));
  const values = Array.from({ length: count }, () => randomDigitsNumber(random, readDigits(rules)));
  let answer = values[0];
  const terms = [formatNumber(values[0])];
  for (const value of values.slice(1)) {
    const subtract = random() > 0.5 && (rules?.negativeAnswers?.allowed === true || answer >= value);
    answer = subtract ? answer - value : answer + value;
    terms.push(subtract ? `− ${value}` : `+ ${value}`);
  }
  return { question: terms.join(' '), answer, solution: `${terms.join(' ')} = ${answer}` };
};

const missingNumber = ({ rules, random }) => {
  const base = arithmetic({ rules: { ...rules, operation: rules.operation || 'ADDITION' }, random });
  const [left, operator, right] = base.question.split(' ');
  const hideLeft = random() > 0.5;
  if (operator === '+') {
    return hideLeft
      ? { question: `? + ${right} = ${base.answer}`, answer: Number(left), solution: `${base.answer} − ${right} = ${left}` }
      : { question: `${left} + ? = ${base.answer}`, answer: Number(right), solution: `${base.answer} − ${left} = ${right}` };
  }
  return { question: base.question, answer: base.answer, solution: base.solution };
};

const fraction = ({ random }) => {
  const denominator = randomInteger(random, 2, 10);
  const numerator = randomInteger(random, 1, denominator - 1);
  const remainder = denominator - numerator;
  return {
    question: `What is $\\frac{${numerator}}{${denominator}}$ taken away from 1?`,
    answer: `${remainder}/${denominator}`,
    solution: `$1 - \\frac{${numerator}}{${denominator}} = \\frac{${remainder}}{${denominator}}$`,
  };
};

const percentage = ({ random }) => {
  const percent = [10, 20, 25, 50][randomInteger(random, 0, 3)];
  const multiplier = randomInteger(random, 2, 20);
  const value = (100 / percent) * multiplier;
  const answer = (value * percent) / 100;
  return { question: `What is ${percent}% of ${value}?`, answer, solution: `${percent}% of ${value} = ${answer}` };
};

const power = ({ rules, random }) => {
  const exponent = String(rules.power || 'SQUARE').toUpperCase() === 'CUBE' ? 3 : 2;
  const base = randomInteger(random, 2, exponent === 3 ? 10 : 25);
  const answer = base ** exponent;
  return { question: `What is ${base}${exponent === 2 ? '²' : '³'}?`, answer, solution: `${base}${exponent === 2 ? '²' : '³'} = ${answer}` };
};

const sequence = ({ random }) => {
  const start = randomInteger(random, 1, 30);
  const step = randomInteger(random, 2, 12);
  const values = Array.from({ length: 4 }, (_, index) => start + index * step);
  const answer = start + 4 * step;
  return { question: `What comes next? ${values.join(', ')}, ?`, answer, solution: `Add ${step} each time, so the next number is ${answer}.` };
};

const vedicTimesEleven = ({ random }) => {
  const number = randomInteger(random, 10, 99);
  const answer = number * 11;
  return { question: `Use the ×11 method: ${number} × 11`, answer, solution: `${number} × 11 = ${answer}` };
};

const vedicNearBase = ({ random }) => {
  const base = random() > 0.5 ? 100 : 10;
  const firstOffset = randomInteger(random, -Math.floor(base / 5), Math.floor(base / 5));
  const secondOffset = randomInteger(random, -Math.floor(base / 5), Math.floor(base / 5));
  const left = base + firstOffset;
  const right = base + secondOffset;
  const answer = left * right;
  return { question: `Use the near-${base} method: ${left} × ${right}`, answer, solution: `${left} × ${right} = ${answer}` };
};

const vedicSquareEndingFive = ({ random }) => {
  const tens = randomInteger(random, 1, 30);
  const number = tens * 10 + 5;
  const answer = number * number;
  return { question: `Find ${number}² using the ending-in-5 method.`, answer, solution: `${number}² = ${answer}` };
};

const superChallenge = ({ random }) => {
  const first = randomInteger(random, 20, 99);
  const second = randomInteger(random, 2, 12);
  const third = randomInteger(random, 10, 60);
  const answer = first * second + third;
  return { question: `Solve: (${first} × ${second}) + ${third}`, answer, solution: `(${first} × ${second}) + ${third} = ${answer}` };
};

const logicOddOneOut = ({ random }) => {
  const start = randomInteger(random, 2, 20);
  const step = randomInteger(random, 2, 7);
  const values = [start, start + step, start + step * 2];
  const odd = start + step * randomInteger(random, 4, 8) + 1;
  const options = [...values, odd];
  for (let index = options.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(random, 0, index);
    [options[index], options[swapIndex]] = [options[swapIndex], options[index]];
  }
  return {
    question: 'Which number does not belong to the pattern?',
    answer: odd,
    interactionType: 'MCQ',
    options: options.map(String),
    solution: `${start}, ${start + step}, and ${start + step * 2} increase by ${step}; ${odd} does not follow that pattern.`,
  };
};

const STRATEGIES = Object.freeze({
  ARITHMETIC: arithmetic,
  MULTI_ADD: multiAdd,
  CHAIN: chain,
  MISSING_NUMBER: missingNumber,
  FRACTION: fraction,
  PERCENTAGE: percentage,
  POWER: power,
  SEQUENCE: sequence,
  VEDIC_TIMES_ELEVEN: vedicTimesEleven,
  VEDIC_NEAR_BASE: vedicNearBase,
  VEDIC_SQUARE_ENDING_FIVE: vedicSquareEndingFive,
  SUPER_CHALLENGE: superChallenge,
  LOGIC_ODD_ONE_OUT: logicOddOneOut,
});

export const generateDeterministicQuestion = ({ template, seed }) => {
  if (!template?.strategy) throw new WizKidsGeneratorError(400, 'A template strategy is required.');
  const strategy = STRATEGIES[template.strategy];
  if (!strategy) throw new WizKidsGeneratorError(400, `Unsupported template strategy: ${template.strategy}.`);
  const stableSeed = String(seed ?? '').trim();
  if (!stableSeed) throw new WizKidsGeneratorError(400, 'A non-empty seed is required.');

  const random = createSeededRandom(`${template.templateKey}|${template.version}|${stableSeed}`);
  const generated = strategy({ rules: template.rules || {}, random });
  if (!generated?.question || generated.answer === undefined || generated.answer === null) {
    throw new WizKidsGeneratorError(500, 'Generator strategy returned an invalid question.');
  }
  return {
    domain: template.domain,
    gradeLevel: template.gradeLevel,
    topic: template.topic || '',
    subTopic: template.subTopic || '',
    skill: template.skill || '',
    difficulty: template.difficulty || 'MEDIUM',
    interactionType: generated.interactionType || 'NUMBER',
    options: generated.options,
    questionContent: generated.question,
    correctAnswer: String(generated.answer),
    solution: generated.solution || '',
    explanation: generated.solution || '',
    seed: stableSeed,
    templateVersion: template.version,
    generatorMetadata: {
      templateId: template._id ? String(template._id) : null,
      templateKey: template.templateKey,
      templateVersion: template.version,
      strategy: template.strategy,
      seed: stableSeed,
    },
  };
};

export const INITIAL_TEMPLATE_DEFINITIONS = Object.freeze([
  { templateKey: 'MENTAL_ADDITION', name: 'Mental Addition', domain: 'MENTAL_MATHS', strategy: 'ARITHMETIC', rules: { operation: 'ADDITION', digits: { minimum: 1, maximum: 2 }, carry: { allowed: true } } },
  { templateKey: 'MENTAL_SUBTRACTION', name: 'Mental Subtraction', domain: 'MENTAL_MATHS', strategy: 'ARITHMETIC', rules: { operation: 'SUBTRACTION', digits: { minimum: 1, maximum: 2 }, negativeAnswers: { allowed: false } } },
  { templateKey: 'MENTAL_MULTIPLICATION', name: 'Mental Multiplication', domain: 'MENTAL_MATHS', strategy: 'ARITHMETIC', rules: { operation: 'MULTIPLICATION', digits: { minimum: 1, maximum: 2 } } },
  { templateKey: 'MENTAL_DIVISION', name: 'Mental Division', domain: 'MENTAL_MATHS', strategy: 'ARITHMETIC', rules: { operation: 'DIVISION', digits: { minimum: 1, maximum: 2 } } },
  { templateKey: 'MENTAL_MULTI_ADD', name: 'Multi-number Addition', domain: 'MENTAL_MATHS', strategy: 'MULTI_ADD', rules: { operandCount: 4, digits: { minimum: 1, maximum: 2 } } },
  { templateKey: 'MENTAL_CHAIN', name: 'Addition and Subtraction Chains', domain: 'MENTAL_MATHS', strategy: 'CHAIN', rules: { operandCount: 4, digits: { minimum: 1, maximum: 2 }, negativeAnswers: { allowed: false } } },
  { templateKey: 'MENTAL_MISSING_NUMBER', name: 'Missing Number', domain: 'MENTAL_MATHS', strategy: 'MISSING_NUMBER', rules: { operation: 'ADDITION', digits: { minimum: 1, maximum: 2 } } },
  { templateKey: 'MENTAL_FRACTIONS', name: 'Simple Fractions', domain: 'MENTAL_MATHS', strategy: 'FRACTION', rules: {} },
  { templateKey: 'MENTAL_PERCENTAGES', name: 'Simple Percentages', domain: 'MENTAL_MATHS', strategy: 'PERCENTAGE', rules: {} },
  { templateKey: 'MENTAL_SQUARES', name: 'Squares', domain: 'MENTAL_MATHS', strategy: 'POWER', rules: { power: 'SQUARE' } },
  { templateKey: 'MENTAL_CUBES', name: 'Cubes', domain: 'MENTAL_MATHS', strategy: 'POWER', rules: { power: 'CUBE' } },
  { templateKey: 'MENTAL_SEQUENCES', name: 'Number Sequences', domain: 'MENTAL_MATHS', strategy: 'SEQUENCE', rules: {} },
  { templateKey: 'VEDIC_TIMES_ELEVEN', name: 'Vedic Multiplication by 11', domain: 'VEDIC_MATHS', strategy: 'VEDIC_TIMES_ELEVEN', rules: {} },
  { templateKey: 'VEDIC_NEAR_BASE', name: 'Vedic Near-base Multiplication', domain: 'VEDIC_MATHS', strategy: 'VEDIC_NEAR_BASE', rules: {} },
  { templateKey: 'VEDIC_SQUARE_ENDING_FIVE', name: 'Vedic Squares Ending in 5', domain: 'VEDIC_MATHS', strategy: 'VEDIC_SQUARE_ENDING_FIVE', rules: {} },
  { templateKey: 'SUPER_CHALLENGE', name: 'Super Maths Challenge', domain: 'SUPER_MATHS', strategy: 'SUPER_CHALLENGE', rules: {} },
  { templateKey: 'LOGIC_ODD_ONE_OUT', name: 'Logic Odd One Out', domain: 'LOGIC', strategy: 'LOGIC_ODD_ONE_OUT', rules: {} },
]);
