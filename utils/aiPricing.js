const MODEL_PRICING_USD_PER_1M = Object.freeze({
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 5, output: 15 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
});

const KNOWN_MODEL_PREFIXES = Object.freeze([
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4.1',
]);

const DEFAULT_PRICING_USD_PER_1M = Object.freeze({
  input: 0.15,
  output: 0.6,
});

export const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE || 83);

const toNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
};

const asRawModelName = (model) =>
  String(model || '')
    .trim()
    .toLowerCase();

const findKnownModelPrefix = (modelName) =>
  KNOWN_MODEL_PREFIXES.find(
    (prefix) => modelName === prefix || modelName.startsWith(`${prefix}-`)
  ) || '';

export const normalizeModelName = (model) => {
  const rawModelName = asRawModelName(model);
  if (!rawModelName) return '';

  const knownPrefix = findKnownModelPrefix(rawModelName);
  return knownPrefix || rawModelName;
};

export const getModelPricing = (model) => {
  const normalizedModel = normalizeModelName(model);
  return MODEL_PRICING_USD_PER_1M[normalizedModel] || DEFAULT_PRICING_USD_PER_1M;
};

export const estimateCostUsd = ({
  model,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
}) => {
  const pricing = getModelPricing(model);
  const safePromptTokens = toNumber(promptTokens);
  const safeCompletionTokens = toNumber(completionTokens);
  const safeTotalTokens = toNumber(totalTokens);

  if (safePromptTokens > 0 || safeCompletionTokens > 0) {
    return (
      (safePromptTokens * pricing.input) / 1_000_000 +
      (safeCompletionTokens * pricing.output) / 1_000_000
    );
  }

  const averageRate = (pricing.input + pricing.output) / 2;
  return (safeTotalTokens * averageRate) / 1_000_000;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildRawMongoModelExpression = (modelField) => ({
  $toLower: {
    $trim: {
      input: { $ifNull: [modelField, ''] },
    },
  },
});

export const getMongoNormalizedModelExpression = ({
  modelField = '$model',
  emptyValue = 'unknown',
} = {}) => {
  const rawModelExpr = buildRawMongoModelExpression(modelField);
  return {
    $switch: {
      branches: KNOWN_MODEL_PREFIXES.map((prefix) => ({
        case: {
          $regexMatch: {
            input: rawModelExpr,
            regex: `^${escapeRegex(prefix)}(?:-|$)`,
          },
        },
        then: prefix,
      })),
      default: {
        $cond: [{ $eq: [rawModelExpr, ''] }, emptyValue, rawModelExpr],
      },
    },
  };
};

const buildEstimatedCostForModelExpression = ({
  model,
  promptField,
  completionField,
  totalField,
}) => {
  const modelExpr = getMongoNormalizedModelExpression({
    modelField: model,
    emptyValue: '',
  });
  const promptTokensExpr = { $ifNull: [promptField, 0] };
  const completionTokensExpr = { $ifNull: [completionField, 0] };
  const totalTokensExpr = { $ifNull: [totalField, 0] };

  const branches = Object.entries(MODEL_PRICING_USD_PER_1M).map(([modelName, pricing]) => ({
    case: { $eq: [modelExpr, modelName] },
    then: {
      $add: [
        { $divide: [{ $multiply: [promptTokensExpr, pricing.input] }, 1_000_000] },
        { $divide: [{ $multiply: [completionTokensExpr, pricing.output] }, 1_000_000] },
      ],
    },
  }));

  const defaultAverageRate =
    (DEFAULT_PRICING_USD_PER_1M.input + DEFAULT_PRICING_USD_PER_1M.output) / 2;

  const defaultExpr = {
    $cond: [
      { $gt: [{ $add: [promptTokensExpr, completionTokensExpr] }, 0] },
      {
        $add: [
          {
            $divide: [
              { $multiply: [promptTokensExpr, DEFAULT_PRICING_USD_PER_1M.input] },
              1_000_000,
            ],
          },
          {
            $divide: [
              { $multiply: [completionTokensExpr, DEFAULT_PRICING_USD_PER_1M.output] },
              1_000_000,
            ],
          },
        ],
      },
      {
        $divide: [{ $multiply: [totalTokensExpr, defaultAverageRate] }, 1_000_000],
      },
    ],
  };

  return {
    $switch: {
      branches,
      default: defaultExpr,
    },
  };
};

export const getMongoEstimatedCostExpression = ({
  costField = '$cost_usd',
  modelField = '$model',
  promptTokensField = '$prompt_tokens',
  completionTokensField = '$completion_tokens',
  totalTokensField = '$total_tokens',
} = {}) => {
  const explicitCostExpr = { $ifNull: [costField, 0] };
  const fallbackCostExpr = buildEstimatedCostForModelExpression({
    model: modelField,
    promptField: promptTokensField,
    completionField: completionTokensField,
    totalField: totalTokensField,
  });

  // Prefer persisted cost when available (> 0). Fallback for historical rows.
  return {
    $cond: [{ $gt: [explicitCostExpr, 0] }, explicitCostExpr, fallbackCostExpr],
  };
};

export const usdToInr = (usdAmount) => toNumber(usdAmount) * USD_TO_INR_RATE;

export const MODEL_PRICING_REFERENCE = MODEL_PRICING_USD_PER_1M;
