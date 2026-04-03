import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import {
  FREE_PLAN_MESSAGES,
  PLAN_LIMIT_REDIRECT,
  isPlanFeatureEnabled,
  resolveSubscriptionStatus,
  resolveEffectivePlanType,
  resolveSubscriptionPlanType,
} from '../config/planLimits.js';
import {
  normalizeQuestionFormat,
  normalizeQuestionTypeForStorage,
} from '../utils/questionTypes.js';
import { hasCodingConfiguration } from '../utils/codingQuestions.js';

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const normalizeUpper = (value) => normalizeString(value).toUpperCase();

const FREE_PLAN_ALLOWED_STORAGE_TYPES = new Set([
  'MULTIPLE_CHOICE',
  'MULTIPLE_OPTIONS',
  'TRUE_FALSE',
  'SHORT_ANSWER',
]);

const FREE_PLAN_WRITING_TYPES = new Set(['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY']);
const FREE_PLAN_BLOCKED_FORMATS = new Set([
  'PARAGRAPH',
  'SCENARIO',
  'ESSAY',
  'ESSAY_LETTER',
  'ESSAY_STORY',
  'CODING',
]);

export const sendPlanRestriction = (res, message, extra = {}) =>
  res.status(403).json({
    success: false,
    message,
    showUpgradeModal: true,
    redirectTo: PLAN_LIMIT_REDIRECT,
    ...extra,
  });

export const resolveExamPlanContext = async (examId) => {
  if (!examId) return null;
  const exam = await Exam.findById(examId).select('_id createdBy tenantId examType').lean();
  if (!exam) return null;

  let planOwner = null;
  if (exam.createdBy) {
    planOwner = await User.findById(exam.createdBy).select('_id planType tenantId').lean();
  }

  const tenantId = exam.tenantId || planOwner?.tenantId || null;
  let planType = planOwner?.planType || null;
  let subscriptionStatus = 'ACTIVE';
  let subscriptionPlanType = null;
  if (tenantId) {
    const tenant = await Tenant.findById(tenantId).select('subscription').lean();
    const subscription = tenant?.subscription || {};
    subscriptionStatus = resolveSubscriptionStatus(subscription);
    subscriptionPlanType = resolveSubscriptionPlanType(subscription.planType || null);
    planType = resolveEffectivePlanType(subscription.planType || planType, subscriptionStatus);
  }
  return {
    exam,
    planOwner,
    planType,
    tenantId,
    subscriptionStatus,
    subscriptionPlanType,
  };
};

export const resolveAttemptPlanContext = async (attemptId) => {
  if (!attemptId) return null;
  const attempt = await ExamAttempt.findById(attemptId).select('_id examId').lean();
  if (!attempt) return null;
  const context = await resolveExamPlanContext(attempt.examId);
  if (!context) return null;
  return {
    ...context,
    attempt,
  };
};

export const resolveQuestionPlanContext = async (questionId) => {
  if (!questionId) return null;
  const question = await Question.findById(questionId).select('_id questionPaperId').lean();
  if (!question) return null;
  const questionPaper = await QuestionPaper.findById(question.questionPaperId)
    .select('_id examId')
    .lean();
  if (!questionPaper) return null;
  const context = await resolveExamPlanContext(questionPaper.examId);
  if (!context) return null;
  return {
    ...context,
    question,
    questionPaper,
  };
};

export const resolveUserEffectivePlanType = async (user = null) => {
  if (!user || typeof user !== 'object') {
    return resolveSubscriptionPlanType(null);
  }

  const userPlanType = resolveSubscriptionPlanType(user.planType || null);
  const tenantId = user.tenantId || null;
  if (!tenantId) {
    return userPlanType;
  }

  const tenant = await Tenant.findById(tenantId).select('subscription').lean();
  const subscription = tenant?.subscription || {};
  const subscriptionStatus = resolveSubscriptionStatus(subscription);
  return resolveEffectivePlanType(subscription.planType || userPlanType, subscriptionStatus);
};

export const blockFreePlanByUser =
  (message = FREE_PLAN_MESSAGES.AI_GRADING_LOCKED, featureKey = 'aiGrading') =>
  async (req, res, next) => {
    try {
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      if (!isPlanFeatureEnabled(effectivePlanType, featureKey)) {
        return sendPlanRestriction(res, message);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

export const blockFreePlanByAttemptId =
  (message = FREE_PLAN_MESSAGES.PROCTORING_LOCKED, featureKey = 'proctoring') =>
  async (req, res, next) => {
    try {
      const attemptId = req.params.attemptId || req.body?.attemptId || null;
      if (!attemptId) return next();
      const context = await resolveAttemptPlanContext(attemptId);
      if (context?.planType && !isPlanFeatureEnabled(context.planType, featureKey)) {
        return sendPlanRestriction(res, message);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

export const blockFreePlanByQuestionId =
  (message = FREE_PLAN_MESSAGES.CODING_LOCKED, featureKey = 'codingCompiler') =>
  async (req, res, next) => {
    try {
      const questionId = req.body?.questionId || req.params?.questionId || null;
      if (!questionId) return next();
      const context = await resolveQuestionPlanContext(questionId);
      if (context?.planType && !isPlanFeatureEnabled(context.planType, featureKey)) {
        return sendPlanRestriction(res, message);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

const resolveExamIdFromRequest = (req) =>
  req.params?.examId || req.query?.examId || req.query?.specificExamId || req.body?.examId || null;

export const blockFreePlanByExamId =
  (message = FREE_PLAN_MESSAGES.ANALYTICS_LOCKED, featureKey = 'analytics') =>
  async (req, res, next) => {
    try {
      const examId = resolveExamIdFromRequest(req);
      if (!examId) return next();
      const context = await resolveExamPlanContext(examId);
      if (context?.planType && !isPlanFeatureEnabled(context.planType, featureKey)) {
        return sendPlanRestriction(res, message);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

export const validateFreePlanQuestionPayload = (payload = {}) => {
  const normalizedType = normalizeQuestionTypeForStorage(payload);
  const normalizedFormat = normalizeQuestionFormat(payload);
  const explicitType = normalizeUpper(payload.questionType || payload.type);
  const explicitFormat = normalizeUpper(
    payload.questionFormat || payload.question_type || payload.type
  );
  const explicitEssayType =
    explicitType === 'LETTER_WRITING'
      ? 'ESSAY_LETTER'
      : explicitType === 'STORY_WRITING'
        ? 'ESSAY_STORY'
        : explicitType;
  const explicitEssayFormat =
    explicitFormat === 'LETTER_WRITING'
      ? 'ESSAY_LETTER'
      : explicitFormat === 'STORY_WRITING'
        ? 'ESSAY_STORY'
        : explicitFormat;
  const hasCoding =
    normalizedType === 'CODING' ||
    normalizedFormat === 'CODING' ||
    explicitType === 'CODING' ||
    explicitType === 'CODE' ||
    explicitFormat === 'CODING' ||
    explicitFormat === 'CODE' ||
    hasCodingConfiguration(payload);

  if (hasCoding) {
    return FREE_PLAN_MESSAGES.CODING_LOCKED;
  }

  const hasWritingType =
    FREE_PLAN_WRITING_TYPES.has(normalizedType) ||
    FREE_PLAN_WRITING_TYPES.has(normalizedFormat) ||
    FREE_PLAN_WRITING_TYPES.has(explicitEssayType) ||
    FREE_PLAN_WRITING_TYPES.has(explicitEssayFormat);

  if (hasWritingType) {
    return FREE_PLAN_MESSAGES.WRITING_AI_LOCKED;
  }

  const isAllowedType = FREE_PLAN_ALLOWED_STORAGE_TYPES.has(normalizedType);
  const isBlockedFormat = FREE_PLAN_BLOCKED_FORMATS.has(normalizedFormat);

  if (!isAllowedType || isBlockedFormat) {
    return FREE_PLAN_MESSAGES.QUESTION_TYPE_LOCKED;
  }

  return null;
};
