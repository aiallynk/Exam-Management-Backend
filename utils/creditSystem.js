export const CREDIT_REQUEST_TYPES = Object.freeze({
  AI: 'AI',
  ATTEMPTS: 'ATTEMPTS',
  EXAMS: 'EXAMS',
});

export const CREDIT_REQUEST_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export const EXTRA_CREDIT_UNIT_PRICE_INR = Object.freeze({
  [CREDIT_REQUEST_TYPES.AI]: 0.5,
  [CREDIT_REQUEST_TYPES.ATTEMPTS]: 2,
  [CREDIT_REQUEST_TYPES.EXAMS]: 50,
});

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const toFiniteMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
};

export const normalizeCreditRequestType = (value) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return Object.values(CREDIT_REQUEST_TYPES).includes(normalized) ? normalized : null;
};

export const normalizeTenantExtraCredits = (extraCredits = {}) => {
  const source =
    extraCredits && typeof extraCredits === 'object' && !Array.isArray(extraCredits)
      ? extraCredits
      : {};

  return {
    ai: toNonNegativeInt(source.ai, 0),
    attempts: toNonNegativeInt(source.attempts, 0),
    exams: toNonNegativeInt(source.exams, 0),
  };
};

const resolveExtraCreditsByLimitKey = (extraCredits, limitKey) => {
  const normalized = normalizeTenantExtraCredits(extraCredits);
  if (limitKey === 'maxAiQuestionsPerMonth') return normalized.ai;
  if (limitKey === 'maxAttemptsPerMonth') return normalized.attempts;
  if (limitKey === 'maxExamsPerMonth') return normalized.exams;
  return 0;
};

export const applyExtraCreditsToPlanLimits = (planLimits = {}, extraCredits = {}) => {
  const normalizedLimits =
    planLimits && typeof planLimits === 'object' && !Array.isArray(planLimits)
      ? { ...planLimits }
      : {};
  const keys = ['maxAiQuestionsPerMonth', 'maxAttemptsPerMonth', 'maxExamsPerMonth'];

  keys.forEach((limitKey) => {
    const baseLimit = normalizedLimits[limitKey];
    if (baseLimit === null || baseLimit === undefined || baseLimit === '') {
      return;
    }

    const finiteBase = toNonNegativeInt(baseLimit, 0);
    const extra = resolveExtraCreditsByLimitKey(extraCredits, limitKey);
    normalizedLimits[limitKey] = finiteBase + extra;
  });

  return normalizedLimits;
};

export const resolveCreditTypeByLimitType = (limitType = '') => {
  const normalized = String(limitType || '')
    .trim()
    .toLowerCase();
  if (normalized === 'ai' || normalized === 'ai_question') {
    return CREDIT_REQUEST_TYPES.AI;
  }
  if (normalized === 'attempt' || normalized === 'candidate') {
    return CREDIT_REQUEST_TYPES.ATTEMPTS;
  }
  if (normalized === 'exam') {
    return CREDIT_REQUEST_TYPES.EXAMS;
  }
  return null;
};

export const resolveTenantExtraCreditFieldByType = (type) => {
  const normalized = normalizeCreditRequestType(type);
  if (normalized === CREDIT_REQUEST_TYPES.AI) return 'extraCredits.ai';
  if (normalized === CREDIT_REQUEST_TYPES.ATTEMPTS) return 'extraCredits.attempts';
  if (normalized === CREDIT_REQUEST_TYPES.EXAMS) return 'extraCredits.exams';
  return null;
};

export const resolveExtraCreditUnitPrice = (type) => {
  const normalized = normalizeCreditRequestType(type);
  if (!normalized) return 0;
  return toFiniteMoney(EXTRA_CREDIT_UNIT_PRICE_INR[normalized] || 0);
};

export const computeExtraUsageCost = ({
  usage = 0,
  baseLimit = null,
  type = null,
} = {}) => {
  const normalizedUsage = toNonNegativeInt(usage, 0);
  const normalizedBase =
    baseLimit === null || baseLimit === undefined || baseLimit === ''
      ? null
      : toNonNegativeInt(baseLimit, 0);
  const unitPrice = resolveExtraCreditUnitPrice(type);

  if (normalizedBase === null) {
    return {
      extraUsage: 0,
      unitPrice,
      extraCost: 0,
    };
  }

  const extraUsage = Math.max(0, normalizedUsage - normalizedBase);
  return {
    extraUsage,
    unitPrice,
    extraCost: toFiniteMoney(extraUsage * unitPrice),
  };
};
