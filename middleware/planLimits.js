import {
  FREE_TRIAL_LIMITS,
  PLAN_LIMIT_MESSAGE,
  isTrialRestrictedPlan,
} from '../config/planLimits.js';
import ExamAttempt from '../models/ExamAttempt.js';
import User from '../models/User.js';
import {
  getExamByIdForPlan,
  getExamCountByCreator,
  getExamUsageSnapshot,
  getPlanOwnerUser,
} from '../utils/planUsage.js';

const USER_ROLE_LIMITS = Object.freeze({
  EXAM_CREATOR: FREE_TRIAL_LIMITS.maxExamCreators,
  CANDIDATE: FREE_TRIAL_LIMITS.maxCandidates,
});

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const normalizeRole = (value) => String(value || '').trim().toUpperCase();

const buildUsagePayload = ({ examsUsed = 0, questionsUsed = 0, candidatesUsed = 0 } = {}) => ({
  exams: { used: examsUsed, limit: FREE_TRIAL_LIMITS.maxExams },
  questions: { used: questionsUsed, limit: FREE_TRIAL_LIMITS.maxQuestions },
  candidates: { used: candidatesUsed, limit: FREE_TRIAL_LIMITS.maxAttempts },
});

const sendLimitResponse = (res, usage, extra = {}) =>
  res.status(403).json({
    message: PLAN_LIMIT_MESSAGE,
    showUpgradeModal: true,
    usage,
    ...extra,
  });

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
    const targetRole = normalizeRole(req.body?.role);
    const roleLimit = USER_ROLE_LIMITS[targetRole];
    if (!roleLimit) return next();

    const actor = await getCurrentActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!isTrialRestrictedPlan(actor.planType)) {
      return next();
    }

    const tenantId = actor.tenantId || req.user?.tenantId;
    if (!tenantId) return next();

    const baseFilter = {
      tenantId,
      status: { $ne: 'INACTIVE' },
    };

    let existingUser = null;
    if (req.params?.userId) {
      existingUser = await User.findOne({ _id: req.params.userId, tenantId }).select('_id role');

      if (!existingUser) {
        return next();
      }

      const existingRole = normalizeRole(existingUser.role);
      if (existingRole === targetRole) {
        return next();
      }
    }

    const roleUsage = await User.countDocuments({
      ...baseFilter,
      role: targetRole,
    });

    if (roleUsage >= roleLimit) {
      const examsUsed = toNonNegativeInt(actor.examsCreated, 0);
      const usagePayload = buildUsagePayload({
        examsUsed,
        candidatesUsed: targetRole === 'CANDIDATE' ? roleUsage : 0,
      });
      return sendLimitResponse(res, usagePayload, {
        attemptedRole: targetRole,
        tenantUsage: {
          role: targetRole,
          used: roleUsage,
          limit: roleLimit,
        },
      });
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

    if (!isTrialRestrictedPlan(user.planType)) {
      setPlanContext(req, { planOwner: user });
      return next();
    }

    const [storedExamCount, actualExamCount] = await Promise.all([
      toNonNegativeInt(user.examsCreated, 0),
      getExamCountByCreator(user._id),
    ]);
    const examsUsed = Math.max(storedExamCount, actualExamCount);

    if (examsUsed >= FREE_TRIAL_LIMITS.maxExams) {
      return sendLimitResponse(res, buildUsagePayload({ examsUsed }));
    }

    setPlanContext(req, {
      planOwner: user,
      usage: buildUsagePayload({ examsUsed }),
    });

    return next();
  } catch (error) {
    return next(error);
  }
};

export const checkQuestionLimit = async (req, res, next) => {
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

    const { questionCount, candidateCount } = await getExamUsageSnapshot(exam);
    const examsUsed = Math.max(
      toNonNegativeInt(planOwner.examsCreated, 0),
      await getExamCountByCreator(planOwner._id)
    );
    const questionsToAdd = toNonNegativeInt(
      req.planLimitContext?.questionsToAdd ?? req.body?.questionsToAdd,
      1
    );

    if (
      isTrialRestrictedPlan(planOwner.planType) &&
      questionCount + questionsToAdd > FREE_TRIAL_LIMITS.maxQuestions
    ) {
      return sendLimitResponse(
        res,
        buildUsagePayload({
          examsUsed,
          questionsUsed: questionCount,
          candidatesUsed: candidateCount,
        }),
        {
          attemptedAddition: questionsToAdd,
        }
      );
    }

    setPlanContext(req, {
      planOwner,
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

    const [usageSnapshot, hasExistingCandidateAttempt, actualExamCount] = await Promise.all([
      getExamUsageSnapshot(exam),
      ExamAttempt.exists({ examId: exam._id, userId: req.user?._id }),
      getExamCountByCreator(planOwner._id),
    ]);

    const candidateCount = usageSnapshot.candidateCount;
    const examsUsed = Math.max(
      toNonNegativeInt(planOwner.examsCreated, 0),
      actualExamCount
    );

    if (
      isTrialRestrictedPlan(planOwner.planType) &&
      !hasExistingCandidateAttempt &&
      candidateCount >= FREE_TRIAL_LIMITS.maxAttempts
    ) {
      return sendLimitResponse(
        res,
        buildUsagePayload({
          examsUsed,
          questionsUsed: usageSnapshot.questionCount,
          candidatesUsed: candidateCount,
        })
      );
    }

    setPlanContext(req, {
      planOwner,
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
