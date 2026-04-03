import {
  FREE_PLAN_MESSAGES,
  FREE_TRIAL_LIMITS,
  PLAN_LIMIT_MESSAGE,
  PLAN_LIMIT_MESSAGES,
  SUBSCRIPTION_PLAN_TYPES,
  isFreePlan,
  isTrialRestrictedPlan,
  getSubscriptionPlanDefinition,
  resolveSubscriptionStatus,
  resolveEffectivePlanType,
} from '../config/planLimits.js';
import ExamAttempt from '../models/ExamAttempt.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import { emitTenantQuotaExceededAlert } from '../services/systemAlertService.js';
import {
  getExamByIdForPlan,
  getExamCountByCreator,
  getExamUsageSnapshot,
  getCurrentMonthRange,
  getPlanOwnerUser,
  getExamCountForTenantByWindow,
  getAttemptCountForTenantByWindow,
} from '../utils/planUsage.js';
import {
  applyExtraCreditsToPlanLimits,
  resolveCreditTypeByLimitType,
} from '../utils/creditSystem.js';

const USER_ROLE_LIMITS = Object.freeze({
  EXAM_CREATOR: FREE_TRIAL_LIMITS.maxExamCreators,
  CANDIDATE: FREE_TRIAL_LIMITS.maxCandidates,
});

const ROLE_LIMIT_ALIASES = Object.freeze({
  ORG_ADMIN: 'EXAM_CREATOR',
  INSTITUTE_ADMIN: 'EXAM_CREATOR',
  ADMIN: 'EXAM_CREATOR',
  DESIGNER: 'EXAM_CREATOR',
  TEACHER: 'EXAM_CREATOR',
  USER: 'CANDIDATE',
  STUDENT: 'CANDIDATE',
});

const ROLE_LIMIT_QUERY_VALUES = Object.freeze({
  EXAM_CREATOR: ['EXAM_CREATOR', 'ORG_ADMIN', 'INSTITUTE_ADMIN', 'ADMIN', 'DESIGNER', 'TEACHER'],
  CANDIDATE: ['CANDIDATE', 'USER', 'STUDENT'],
});

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const hasOwn = (target, key) =>
  Boolean(target && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key));

const normalizeOptionalObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const normalizeRole = (value) => String(value || '').trim().toUpperCase();

const normalizeRoleForLimits = (value) => {
  const normalized = normalizeRole(value);
  return ROLE_LIMIT_ALIASES[normalized] || normalized;
};

const resolveFinitePlanLimit = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const isCountedTenantUser = (status) => normalizeRole(status) !== 'INACTIVE';

const resolveRoleLimit = (planType, planLimits, role) => {
  if (!role) return null;

  if (isTrialRestrictedPlan(planType)) {
    return USER_ROLE_LIMITS[role] ?? null;
  }

  if (role === 'EXAM_CREATOR') {
    return resolveFinitePlanLimit(planLimits?.maxExamCreators);
  }

  if (role === 'CANDIDATE') {
    return resolveFinitePlanLimit(planLimits?.maxCandidates);
  }

  return null;
};

const resolveRoleQueryFilter = (role) => {
  const queryValues = ROLE_LIMIT_QUERY_VALUES[role];
  if (Array.isArray(queryValues) && queryValues.length > 0) {
    return { $in: queryValues };
  }
  return role;
};

const isValidObjectId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());

const resolveTenantSubscriptionContext = async (tenantId, fallbackPlanType) => {
  if (!tenantId) {
    return {
      planType: fallbackPlanType || null,
      subscriptionStatus: 'ACTIVE',
      subscription: null,
      tenant: null,
    };
  }

  const tenant = await Tenant.findById(tenantId)
    .select('subscription examLimit attemptLimit aiUsageLimit extraCredits')
    .lean();
  const subscription = tenant?.subscription || null;
  const subscriptionStatus = resolveSubscriptionStatus(subscription || {});
  const assignedPlan = subscription?.planType || fallbackPlanType || null;
  const planType = resolveEffectivePlanType(assignedPlan, subscriptionStatus);

  return {
    planType,
    subscriptionStatus,
    subscription,
    tenant,
  };
};

const buildUsageWindow = (subscription = null) => {
  const { start, end } = getCurrentMonthRange();
  const resetAt = subscription?.usageResetAt ? new Date(subscription.usageResetAt) : null;
  if (resetAt && !Number.isNaN(resetAt.getTime()) && resetAt > start && resetAt < end) {
    return { start: resetAt, end };
  }
  return { start, end };
};

const resolvePlanLimitWithOverride = ({
  customLimits,
  key,
  legacyValue,
  baseValue,
  aliasKeys = [],
}) => {
  const resolveCustomLimitOverride = (targetKey) => {
    if (!hasOwn(customLimits, targetKey)) return undefined;
    const rawValue = customLimits[targetKey];
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      return undefined;
    }
    if (Number(rawValue) === -1) {
      return null;
    }
    return resolveFinitePlanLimit(rawValue);
  };

  const directOverride = resolveCustomLimitOverride(key);
  if (directOverride !== undefined) {
    return directOverride;
  }

  if (Array.isArray(aliasKeys)) {
    for (const aliasKey of aliasKeys) {
      const aliasOverride = resolveCustomLimitOverride(aliasKey);
      if (aliasOverride !== undefined) {
        return aliasOverride;
      }
    }
  }
  const legacyLimit = resolveFinitePlanLimit(legacyValue);
  if (legacyLimit !== null) {
    return legacyLimit;
  }
  return resolveFinitePlanLimit(baseValue);
};

const resolvePlanLimits = (planType, tenant = null) => {
  const plan = getSubscriptionPlanDefinition(planType);
  const baseLimits = { ...(plan?.limits || {}) };

  const subscription = tenant?.subscription || {};
  const customLimits = normalizeOptionalObject(subscription.customLimits);

  const limits = {
    ...baseLimits,
    maxExamsPerMonth: resolvePlanLimitWithOverride({
      customLimits,
      key: 'maxExamsPerMonth',
      legacyValue: tenant?.examLimit,
      baseValue: baseLimits?.maxExamsPerMonth,
    }),
    maxAttemptsPerMonth: resolvePlanLimitWithOverride({
      customLimits,
      key: 'maxAttemptsPerMonth',
      legacyValue: tenant?.attemptLimit,
      baseValue: baseLimits?.maxAttemptsPerMonth,
    }),
    maxAiQuestionsPerMonth: resolvePlanLimitWithOverride({
      customLimits,
      key: 'maxAiQuestionsPerMonth',
      legacyValue: tenant?.aiUsageLimit,
      baseValue: baseLimits?.maxAiQuestionsPerMonth,
    }),
    maxImportFiles: resolvePlanLimitWithOverride({
      customLimits,
      key: 'maxImportFiles',
      aliasKeys: ['importQuestionsPerMonth'],
      legacyValue: null,
      baseValue: baseLimits?.maxImportFiles,
    }),
    maxQuestionsPerExam: resolvePlanLimitWithOverride({
      customLimits,
      key: 'maxQuestionsPerExam',
      legacyValue: null,
      baseValue: baseLimits?.maxQuestionsPerExam,
    }),
    maxCandidates: resolvePlanLimitWithOverride({
      customLimits,
      key: 'maxCandidates',
      legacyValue: null,
      baseValue: baseLimits?.maxCandidates,
    }),
  };

  return applyExtraCreditsToPlanLimits(limits, tenant?.extraCredits);
};

const buildUsagePayload = (
  { examsUsed = 0, questionsUsed = 0, candidatesUsed = 0, limits = {}, period = null } = {}
) => {
  const payload = {
    exams: {
      used: examsUsed,
      limit: toNonNegativeInt(limits.exams, FREE_TRIAL_LIMITS.maxExams),
    },
    questions: {
      used: questionsUsed,
      limit: toNonNegativeInt(limits.questions, FREE_TRIAL_LIMITS.maxQuestions),
    },
    candidates: {
      used: candidatesUsed,
      limit: toNonNegativeInt(limits.candidates, FREE_TRIAL_LIMITS.maxAttempts),
    },
  };

  if (period) {
    payload.period = period;
  }

  return payload;
};

const emitQuotaAlertSafely = ({
  req,
  message,
  usage,
  limitType = 'general',
}) => {
  if (!req) return;

  const tenantId =
    req.planLimitContext?.exam?.tenantId ||
    req.planLimitContext?.planOwner?.tenantId ||
    req.user?.tenantId ||
    req.body?.tenantId ||
    null;
  if (!tenantId) return;

  emitTenantQuotaExceededAlert({
    tenantId,
    tenantName: req.user?.tenantName || '',
    message,
    limitType,
    usage,
  }).catch((error) => {
    console.error(
      '[PLAN LIMITS] Failed to emit tenant quota exceeded alert:',
      error?.message || error
    );
  });
};

const sendLimitResponse = (
  res,
  usage,
  extra = {},
  message = PLAN_LIMIT_MESSAGE,
  alertContext = {}
) => {
  emitQuotaAlertSafely({
    req: alertContext?.req,
    message,
    usage,
    limitType: alertContext?.limitType || 'general',
  });

  const requestCreditType = resolveCreditTypeByLimitType(alertContext?.limitType);
  const currentUserRole = String(alertContext?.req?.user?.role || '').trim().toUpperCase();
  const canRequestCredits = currentUserRole === 'TENANT_ADMIN' && Boolean(requestCreditType);

  return res.status(403).json({
    message,
    showUpgradeModal: true,
    usage,
    ...(canRequestCredits
      ? {
          requestCredits: {
            enabled: true,
            type: requestCreditType,
          },
        }
      : {}),
    ...extra,
  });
};

const getExamIdFromRequest = (req) => req.params.examId || req.body.examId || null;

const setPlanContext = (req, context = {}) => {
  req.planLimitContext = {
    ...(req.planLimitContext || {}),
    ...context,
  };
};

const getCurrentActor = async (req) => {
  if (!req.user?._id) return null;
  return User.findById(req.user._id).select('_id tenantId planType examsCreated role');
};

export const checkTenantLimits = async (req, res, next) => {
  try {
    const actor = await getCurrentActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'User not found' });
    }

    const rawRequestedTenantId = String(req.body?.tenantId || '').trim();
    const requestedTenantId = isValidObjectId(rawRequestedTenantId) ? rawRequestedTenantId : null;

    let existingUser = null;
    const existingUserId = req.params?.userId || null;
    if (existingUserId) {
      const existingUserFilter = { _id: existingUserId };
      const scopedTenantId = requestedTenantId || actor.tenantId || req.user?.tenantId || null;
      if (scopedTenantId) {
        existingUserFilter.tenantId = scopedTenantId;
      }
      existingUser = await User.findOne(existingUserFilter).select('_id role status tenantId').lean();
      if (!existingUser && req.user?.role === 'SUPER_ADMIN') {
        existingUser = await User.findById(existingUserId).select('_id role status tenantId').lean();
      }
      if (!existingUser) {
        return next();
      }
    }

    const tenantId =
      requestedTenantId || actor.tenantId || req.user?.tenantId || existingUser?.tenantId || null;
    if (!tenantId) return next();

    const subscriptionContext = await resolveTenantSubscriptionContext(tenantId, actor.planType);
    const effectivePlanType = subscriptionContext.planType || actor.planType;
    const planLimits = resolvePlanLimits(effectivePlanType, subscriptionContext.tenant);

    const existingRole = normalizeRoleForLimits(existingUser?.role);
    const targetRole = normalizeRoleForLimits(req.body?.role || existingRole || '');
    const existingStatus = normalizeRole(existingUser?.status || '');
    const targetStatus = normalizeRole(
      req.body?.status !== undefined ? req.body.status : existingUser?.status || 'ACTIVE'
    );
    const isTenantChange =
      Boolean(existingUser) &&
      String(existingUser?.tenantId || '') !== String(tenantId || '');
    const applicableRoleLimit = resolveRoleLimit(effectivePlanType, planLimits, targetRole);

    const shouldConsumeRoleSlot =
      Boolean(targetRole) &&
      isCountedTenantUser(targetStatus) &&
      (
        !existingUser ||
        existingRole !== targetRole ||
        !isCountedTenantUser(existingStatus) ||
        isTenantChange
      );

    if (shouldConsumeRoleSlot && applicableRoleLimit !== null) {
      const roleLimit = applicableRoleLimit;
      const roleUsage = await User.countDocuments({
        tenantId,
        role: resolveRoleQueryFilter(targetRole),
        status: { $ne: 'INACTIVE' },
      });

      if (roleUsage >= roleLimit) {
        const limitMessage =
          targetRole === 'EXAM_CREATOR'
            ? PLAN_LIMIT_MESSAGES.EXAM_CREATOR_LIMIT
            : targetRole === 'CANDIDATE'
              ? PLAN_LIMIT_MESSAGES.CANDIDATE_LIMIT
              : PLAN_LIMIT_MESSAGES.USER_LIMIT;

        const examsUsed = toNonNegativeInt(actor.examsCreated, 0);
        const usagePayload = buildUsagePayload({
          examsUsed,
          candidatesUsed: targetRole === 'CANDIDATE' ? roleUsage : 0,
          limits: {
            exams: planLimits?.maxExamsPerMonth ?? null,
            questions: planLimits?.maxQuestionsPerExam ?? null,
            candidates: targetRole === 'CANDIDATE' ? roleLimit : planLimits?.maxCandidates ?? null,
          },
        });

        return sendLimitResponse(
          res,
          usagePayload,
          {
            attemptedRole: targetRole,
            tenantUsage: {
              role: targetRole,
              used: roleUsage,
              limit: roleLimit,
            },
          },
          limitMessage,
          {
            req,
            limitType:
              targetRole === 'EXAM_CREATOR'
                ? 'exam_creator'
                : targetRole === 'CANDIDATE'
                  ? 'candidate'
                  : 'user',
          }
        );
      }
    }

    const maxUsers = resolveFinitePlanLimit(planLimits?.maxUsers);
    if (maxUsers !== null && applicableRoleLimit !== null) {
      const isTargetActive = targetStatus === 'ACTIVE';
      const wasActive = existingStatus === 'ACTIVE';
      const shouldCheckUserLimit = isTargetActive && (!existingUser || !wasActive || isTenantChange);

      if (shouldCheckUserLimit) {
        const activeUsers = await User.countDocuments({
          tenantId,
          status: 'ACTIVE',
          role: { $ne: 'SUPER_ADMIN' },
        });

        if (activeUsers >= maxUsers) {
          emitQuotaAlertSafely({
            req,
            message: PLAN_LIMIT_MESSAGES.USER_LIMIT,
            usage: {
              users: {
                used: activeUsers,
                limit: maxUsers,
              },
            },
            limitType: 'user',
          });
          return res.status(403).json({
            message: PLAN_LIMIT_MESSAGES.USER_LIMIT,
            showUpgradeModal: true,
            tenantUsage: {
              users: {
                used: activeUsers,
                limit: maxUsers,
              },
            },
          });
        }
      }
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

export const checkExamCreationLimit = async (req, res, next) => {
  try {
    const user = await getPlanOwnerUser(req.user?._id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const tenantId = user.tenantId || req.user?.tenantId;
    const subscriptionContext = await resolveTenantSubscriptionContext(tenantId, user.planType);
    const effectivePlanType = subscriptionContext.planType || user.planType;
    const planLimits = resolvePlanLimits(effectivePlanType, subscriptionContext.tenant);

    if (isTrialRestrictedPlan(effectivePlanType)) {
      const [storedExamCount, actualExamCount] = await Promise.all([
        toNonNegativeInt(user.examsCreated, 0),
        getExamCountByCreator(user._id),
      ]);
      const examsUsed = Math.max(storedExamCount, actualExamCount);

      if (examsUsed >= FREE_TRIAL_LIMITS.maxExams) {
        return sendLimitResponse(
          res,
          buildUsagePayload({ examsUsed }),
          {},
          PLAN_LIMIT_MESSAGE,
          {
            req,
            limitType: 'exam',
          }
        );
      }

      setPlanContext(req, {
        planOwner: user,
        planType: user.planType,
        usage: buildUsagePayload({ examsUsed }),
      });

      return next();
    }

    const monthlyExamLimit = resolveFinitePlanLimit(planLimits?.maxExamsPerMonth);
    if (monthlyExamLimit !== null) {
      if (!tenantId) {
        setPlanContext(req, { planOwner: user, planType: effectivePlanType });
        return next();
      }

      const window = buildUsageWindow(subscriptionContext.subscription);
      const [examsUsed, attemptsUsed] = await Promise.all([
        getExamCountForTenantByWindow(tenantId, window.start, window.end),
        getAttemptCountForTenantByWindow(tenantId, window.start, window.end),
      ]);

      const usagePayload = buildUsagePayload({
        examsUsed,
        candidatesUsed: attemptsUsed,
        limits: {
          exams: monthlyExamLimit,
          questions: 0,
          candidates: planLimits?.maxAttemptsPerMonth ?? null,
        },
        period: {
          type: 'month',
          start: window.start,
          end: window.end,
        },
      });

      if (examsUsed >= monthlyExamLimit) {
        const message = isFreePlan(effectivePlanType)
          ? FREE_PLAN_MESSAGES.EXAM_LIMIT
          : PLAN_LIMIT_MESSAGES.EXAM_LIMIT;
        return sendLimitResponse(res, usagePayload, {}, message, {
          req,
          limitType: 'exam',
        });
      }

      setPlanContext(req, {
        planOwner: user,
        planType: effectivePlanType,
        usage: usagePayload,
      });

      return next();
    }

    setPlanContext(req, { planOwner: user, planType: effectivePlanType });
    return next();
  } catch (error) {
    return next(error);
  }
};

export const checkQuestionLimit = async (req, res, next) => {
  try {
    if (Boolean(req.planLimitContext?.skipExamQuestionLimit)) {
      return next();
    }

    const examId = getExamIdFromRequest(req);
    if (!examId) return next();

    const exam = await getExamByIdForPlan(examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const planOwner = await getPlanOwnerUser(exam.createdBy);
    if (!planOwner) {
      return res.status(404).json({ error: 'Plan owner not found for this exam' });
    }

    const tenantId = exam.tenantId || planOwner.tenantId || req.user?.tenantId || null;
    const subscriptionContext = await resolveTenantSubscriptionContext(tenantId, planOwner.planType);
    const effectivePlanType = subscriptionContext.planType || planOwner.planType;
    const planLimits = resolvePlanLimits(effectivePlanType, subscriptionContext.tenant);

    const { questionCount, candidateCount } = await getExamUsageSnapshot(exam);
    const examsUsed = Math.max(
      toNonNegativeInt(planOwner.examsCreated, 0),
      await getExamCountByCreator(planOwner._id)
    );
    const questionsToAdd = toNonNegativeInt(
      req.planLimitContext?.questionsToAdd ?? req.body?.questionsToAdd,
      1
    );
    const configuredMaxQuestionsPerExam = resolveFinitePlanLimit(planLimits?.maxQuestionsPerExam);
    const maxQuestionsPerExam =
      configuredMaxQuestionsPerExam !== null
        ? configuredMaxQuestionsPerExam
        : isTrialRestrictedPlan(effectivePlanType)
          ? FREE_TRIAL_LIMITS.maxQuestions
          : null;

    if (maxQuestionsPerExam !== null && questionCount + questionsToAdd > maxQuestionsPerExam) {
      const questionLimitMessage = isTrialRestrictedPlan(effectivePlanType)
        ? PLAN_LIMIT_MESSAGE
        : PLAN_LIMIT_MESSAGES.QUESTION_LIMIT;

      return sendLimitResponse(
        res,
        buildUsagePayload({
          examsUsed,
          questionsUsed: questionCount,
          candidatesUsed: candidateCount,
          limits: {
            exams: planLimits?.maxExamsPerMonth ?? null,
            questions: maxQuestionsPerExam,
            candidates: planLimits?.maxAttemptsPerMonth ?? null,
          },
        }),
        {
          attemptedAddition: questionsToAdd,
        },
        questionLimitMessage,
        {
          req,
          limitType: 'question',
        }
      );
    }

    setPlanContext(req, {
      planOwner,
      planType: effectivePlanType,
      exam,
      questionsToAdd,
      usage: buildUsagePayload({
        examsUsed,
        questionsUsed: questionCount,
        candidatesUsed: candidateCount,
      }),
    });

    return next();
  } catch (error) {
    return next(error);
  }
};

export const checkCandidateAttemptLimit = async (req, res, next) => {
  try {
    const examId = getExamIdFromRequest(req);
    if (!examId) return next();

    const exam = await getExamByIdForPlan(examId);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const planOwner = await getPlanOwnerUser(exam.createdBy);
    if (!planOwner) {
      return res.status(404).json({ error: 'Plan owner not found for this exam' });
    }

    const tenantId = exam.tenantId || planOwner.tenantId || req.user?.tenantId;
    const subscriptionContext = await resolveTenantSubscriptionContext(
      tenantId,
      planOwner.planType
    );
    const effectivePlanType = subscriptionContext.planType || planOwner.planType;
    const planLimits = resolvePlanLimits(effectivePlanType, subscriptionContext.tenant);

    const [usageSnapshot, hasExistingCandidateAttempt, hasActiveAttempt, actualExamCount] = await Promise.all([
      getExamUsageSnapshot(exam),
      ExamAttempt.exists({ examId: exam._id, userId: req.user?._id }),
      ExamAttempt.exists({
        examId: exam._id,
        userId: req.user?._id,
        isCompleted: false,
      }),
      getExamCountByCreator(planOwner._id),
    ]);

    const candidateCount = usageSnapshot.candidateCount;
    const examsUsed = Math.max(
      toNonNegativeInt(planOwner.examsCreated, 0),
      actualExamCount
    );

    if (
      isTrialRestrictedPlan(effectivePlanType) &&
      !hasExistingCandidateAttempt &&
      candidateCount >= FREE_TRIAL_LIMITS.maxAttempts
    ) {
      return sendLimitResponse(
        res,
        buildUsagePayload({
          examsUsed,
          questionsUsed: usageSnapshot.questionCount,
          candidatesUsed: candidateCount,
        }),
        {},
        PLAN_LIMIT_MESSAGE,
        {
          req,
          limitType: 'attempt',
        }
      );
    }

    const monthlyAttemptLimit = resolveFinitePlanLimit(planLimits?.maxAttemptsPerMonth);
    if (monthlyAttemptLimit !== null && tenantId) {
      const window = buildUsageWindow(subscriptionContext.subscription);
      const [attemptsUsed, examsUsedThisMonth] = await Promise.all([
        getAttemptCountForTenantByWindow(tenantId, window.start, window.end),
        getExamCountForTenantByWindow(tenantId, window.start, window.end),
      ]);

      const usagePayload = buildUsagePayload({
        examsUsed: examsUsedThisMonth,
        candidatesUsed: attemptsUsed,
        limits: {
          exams: planLimits?.maxExamsPerMonth ?? null,
          questions: 0,
          candidates: monthlyAttemptLimit,
        },
        period: {
          type: 'month',
          start: window.start,
          end: window.end,
        },
      });

      if (!hasActiveAttempt && attemptsUsed >= monthlyAttemptLimit) {
        const message = isFreePlan(effectivePlanType)
          ? FREE_PLAN_MESSAGES.ATTEMPT_LIMIT
          : PLAN_LIMIT_MESSAGES.ATTEMPT_LIMIT;
        return sendLimitResponse(res, usagePayload, {}, message, {
          req,
          limitType: 'attempt',
        });
      }

      setPlanContext(req, {
        planOwner,
        planType: effectivePlanType,
        exam,
        shouldIncrementCandidateCount: !Boolean(hasExistingCandidateAttempt),
        usage: usagePayload,
      });

      return next();
    }

    setPlanContext(req, {
      planOwner,
      planType: effectivePlanType,
      exam,
      shouldIncrementCandidateCount: !Boolean(hasExistingCandidateAttempt),
      usage: buildUsagePayload({
        examsUsed,
        questionsUsed: usageSnapshot.questionCount,
        candidatesUsed: candidateCount,
      }),
    });

    return next();
  } catch (error) {
    return next(error);
  }
};

// Backward-compatible aliases for existing imports/routes.
export const checkExamLimit = checkExamCreationLimit;
export const checkCandidateLimit = checkCandidateAttemptLimit;
