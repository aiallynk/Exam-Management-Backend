import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { aiRateLimiter } from '../middleware/rateLimiter.js';
import { generateQuestions, extractQuestionsFromContent } from '../services/aiService.js';
import {
  parseQuestionImportFile,
  attachImagesToImportedQuestions,
  extractTextFromImageArtifacts,
  extractTextFromPdfBufferWithVision,
} from '../services/questionImportImageService.js';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import path from 'path';
import pdfParse from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';
import OpenAI from 'openai';
import config from '../config/env.js';
import { normalizeQuestionFormat } from '../utils/questionTypes.js';
import {
  createTrackedChatCompletion,
  getAIQuestionCountForTenantByWindow,
  getAIUsageCountForTenantByWindow,
  trackAIUsageEvent,
} from '../services/aiTokenUsageService.js';
import Tenant from '../models/Tenant.js';
import { getCurrentMonthRange, getQuestionCountForExam } from '../utils/planUsage.js';
import {
  FREE_PLAN_MESSAGES,
  FREE_TRIAL_LIMITS,
  PLAN_LIMIT_MESSAGES,
  getSubscriptionPlanDefinition,
  isFreePlan,
  isTrialRestrictedPlan,
  isPlanFeatureEnabled,
} from '../config/planLimits.js';
import {
  resolveUserEffectivePlanType,
  sendPlanRestriction,
} from '../middleware/planRestrictions.js';
import {
  CREDIT_REQUEST_TYPES,
  normalizeTenantExtraCredits,
} from '../utils/creditSystem.js';
import Exam from '../models/Exam.js';

const handleMulterUploadError = (err, req, res, next) => {
  if (!err) {
    return next();
  }

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }

    return res.status(400).json({ error: err.message || 'File upload failed' });
  }

  return res.status(400).json({ error: err.message || 'File upload failed' });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.txt', '.csv', '.xlsx', '.xls', '.docx', '.png', '.jpg', '.jpeg', '.svg'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, TXT, CSV, XLSX, XLS, DOCX, PNG, JPG, JPEG, SVG'));
    }
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.xlsx', '.xls', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, Excel, JPG, JPEG, PNG'));
    }
  },
});

const router = express.Router();
const OPENAI_MODEL = config.openaiModel || 'gpt-4o-mini';

const normalizeAiQuestionType = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (['MCQ', 'MULTIPLE_CHOICE', 'MULTIPLE CHOICE'].includes(normalized)) {
    return 'MULTIPLE_CHOICE';
  }
  if (['TRUE_FALSE', 'TRUEFALSE'].includes(normalized)) return 'TRUE_FALSE';
  if (['SHORT_ANSWER', 'SHORTANSWER'].includes(normalized)) return 'SHORT_ANSWER';
  if (['IMAGE', 'IMAGE_BASED', 'IMAGE-BASED'].includes(normalized)) return 'IMAGE';
  if (['MULTI_SELECT_MCQ', 'MULTI_SELECT MCQ'].includes(normalized)) {
    return 'MULTIPLE_OPTIONS';
  }
  if (['MULTIPLE_OPTIONS', 'MULTI_SELECT', 'MULTISELECT'].includes(normalized)) {
    return 'MULTIPLE_OPTIONS';
  }
  if (['PARAGRAPH', 'SCENARIO'].includes(normalized)) return normalized;
  if (['ESSAY', 'LONG_ANSWER', 'LONGANSWER', 'DESCRIPTIVE'].includes(normalized)) {
    return 'ESSAY';
  }
  if (['ESSAY_LETTER', 'LETTER_WRITING', 'LETTER'].includes(normalized)) {
    return 'ESSAY_LETTER';
  }
  if (['ESSAY_STORY', 'STORY_WRITING', 'STORY'].includes(normalized)) {
    return 'ESSAY_STORY';
  }
  if (['CODING', 'CODE'].includes(normalized)) return 'CODING';
  if (['NUMBER', 'NUMERIC'].includes(normalized)) return 'NUMBER';
  return normalized;
};

const FREE_PLAN_ALLOWED_AI_TYPES = new Set([
  'MULTIPLE_CHOICE',
  'MULTIPLE_OPTIONS',
  'TRUE_FALSE',
  'SHORT_ANSWER',
]);
const FREE_PLAN_AI_TYPE_LOCKED_MESSAGE =
  'Free plan AI question generation supports only MCQ, Multi Select, True/False, and Short Answer question types.';
const WRITING_AI_TYPES = new Set(['ESSAY', 'ESSAY_LETTER', 'ESSAY_STORY']);

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const resolveFiniteLimit = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const parseOptionalNonNegativeInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const IMPORT_PLACEHOLDER_ROW_HINT_REGEX =
  /\b(?:ocr review required|manual review required|scanned question block|scanned pdf page|imported scanned question)\b/i;
const IMPORT_HEADER_HINT_REGEX = /\b(?:quiz|name|date|section)\b/i;
const IMPORT_NUMBER_MARKER_REGEX =
  /(?:^|\s)(?:q(?:uestion)?\s*)?\d{1,3}\s*[\).:\-]\s+/gi;

const normalizeImportTextValue = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const extractStructuredRowText = (row = {}) =>
  normalizeImportTextValue(
    row?.questionText ||
      row?.question ||
      row?.prompt ||
      row?.title ||
      row?.text ||
      ''
  );

const countNumberedQuestionMarkers = (value) => {
  const normalized = normalizeImportTextValue(value);
  if (!normalized) return 0;
  const matches = normalized.match(IMPORT_NUMBER_MARKER_REGEX);
  return Array.isArray(matches) ? matches.length : 0;
};

const shouldPreferNumberedTextOverSingleStructuredRow = ({
  text,
  structuredRows,
}) => {
  const safeRows = Array.isArray(structuredRows) ? structuredRows : [];
  if (safeRows.length !== 1) return false;

  const rowText = extractStructuredRowText(safeRows[0]);
  if (!rowText) return false;

  const combinedText = normalizeImportTextValue(`${text || ''} ${rowText}`);
  const markerCount = countNumberedQuestionMarkers(combinedText);
  if (markerCount < 2) return false;

  const hasHeaderHint = IMPORT_HEADER_HINT_REGEX.test(combinedText);
  const hasMcqHint = /(?:^|\s)A[\).:\-]\s+\S+/i.test(combinedText);
  const hasTrueFalseHint = /\btrue\s*\/\s*false\b/i.test(combinedText);
  return hasHeaderHint || hasMcqHint || hasTrueFalseHint;
};

const buildAiUsageWindow = (subscription = null) => {
  const { start, end } = getCurrentMonthRange();
  const resetAt = subscription?.usageResetAt ? new Date(subscription.usageResetAt) : null;
  if (resetAt && !Number.isNaN(resetAt.getTime()) && resetAt > start && resetAt < end) {
    return { start: resetAt, end };
  }
  return { start, end };
};

const resolveTenantAiQuestionLimit = (effectivePlanType, tenant = null) => {
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const normalizedExtraCredits = normalizeTenantExtraCredits(tenant?.extraCredits);
  const customLimits =
    tenant?.subscription?.customLimits &&
    typeof tenant.subscription.customLimits === 'object' &&
    !Array.isArray(tenant.subscription.customLimits)
      ? tenant.subscription.customLimits
      : {};
  const hasCustomAiLimit = Object.prototype.hasOwnProperty.call(
    customLimits,
    'maxAiQuestionsPerMonth'
  );
  const customLimit = hasCustomAiLimit
    ? resolveFiniteLimit(customLimits.maxAiQuestionsPerMonth)
    : null;
  const legacyLimit = resolveFiniteLimit(tenant?.aiUsageLimit);
  const planLimit = resolveFiniteLimit(planDefinition?.limits?.maxAiQuestionsPerMonth);

  let resolvedLimit = null;
  if (hasCustomAiLimit && customLimit !== null) {
    resolvedLimit = customLimit;
  } else if (legacyLimit !== null) {
    resolvedLimit = legacyLimit;
  } else {
    resolvedLimit = planLimit;
  }

  if (resolvedLimit === null) return null;
  return resolvedLimit + normalizedExtraCredits.ai;
};

const resolveTenantImportFileLimit = (effectivePlanType, tenant = null) => {
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const customLimits =
    tenant?.subscription?.customLimits &&
    typeof tenant.subscription.customLimits === 'object' &&
    !Array.isArray(tenant.subscription.customLimits)
      ? tenant.subscription.customLimits
      : {};
  const hasCustomImportQuestionLimit = Object.prototype.hasOwnProperty.call(
    customLimits,
    'importQuestionsPerMonth'
  );
  const hasCustomImportFileLimit = Object.prototype.hasOwnProperty.call(
    customLimits,
    'maxImportFiles'
  );
  const customLimit = hasCustomImportQuestionLimit
    ? resolveFiniteLimit(customLimits.importQuestionsPerMonth)
    : hasCustomImportFileLimit
      ? resolveFiniteLimit(customLimits.maxImportFiles)
      : null;
  const planLimit = resolveFiniteLimit(
    planDefinition?.limits?.importQuestionsPerMonth ??
      planDefinition?.limits?.maxImportFiles
  );

  if (hasCustomImportQuestionLimit || hasCustomImportFileLimit) {
    return customLimit;
  }

  return planLimit;
};

const resolveTenantMaxQuestionsPerExam = (effectivePlanType, tenant = null) => {
  const planDefinition = getSubscriptionPlanDefinition(effectivePlanType);
  const customLimits =
    tenant?.subscription?.customLimits &&
    typeof tenant.subscription.customLimits === 'object' &&
    !Array.isArray(tenant.subscription.customLimits)
      ? tenant.subscription.customLimits
      : {};
  const hasCustomQuestionLimit = Object.prototype.hasOwnProperty.call(
    customLimits,
    'maxQuestionsPerExam'
  );
  const customLimit = hasCustomQuestionLimit
    ? resolveFiniteLimit(customLimits.maxQuestionsPerExam)
    : null;
  const planLimit = resolveFiniteLimit(planDefinition?.limits?.maxQuestionsPerExam);

  if (hasCustomQuestionLimit) {
    return customLimit;
  }

  if (planLimit !== null) {
    return planLimit;
  }

  if (isTrialRestrictedPlan(effectivePlanType)) {
    return resolveFiniteLimit(FREE_TRIAL_LIMITS.maxQuestions);
  }

  return planLimit;
};

const buildAiQuestionLimitMessage = (effectivePlanType, limit) => {
  const baseMessage = isFreePlan(effectivePlanType)
    ? FREE_PLAN_MESSAGES.AI_QUESTION_LIMIT
    : PLAN_LIMIT_MESSAGES.AI_QUESTION_LIMIT;

  if (!Number.isFinite(Number(limit))) {
    return baseMessage;
  }

  return `${baseMessage} Monthly limit: ${limit} questions.`;
};

const buildImportFileLimitMessage = (limit) => {
  if (!Number.isFinite(Number(limit))) {
    return 'Monthly import limit reached. Upgrade your plan to continue.';
  }

  return `Monthly import limit reached. Your plan allows ${limit} file${Number(limit) === 1 ? '' : 's'} this month. Upgrade to increase limit.`;
};

const buildExamQuestionLimitMessage = (limit) => {
  if (!Number.isFinite(Number(limit))) {
    return PLAN_LIMIT_MESSAGES.QUESTION_LIMIT;
  }
  return `${PLAN_LIMIT_MESSAGES.QUESTION_LIMIT} Per exam limit: ${limit} questions.`;
};

const buildExamQuestionPartialImportWarning = ({
  allowedCount = 0,
  detectedCount = 0,
  maxQuestionsPerExam = null,
}) => {
  const safeAllowed = Math.max(0, Number(allowedCount) || 0);
  const safeDetected = Math.max(0, Number(detectedCount) || 0);
  if (!safeAllowed || safeAllowed >= safeDetected) return '';
  if (!Number.isFinite(Number(maxQuestionsPerExam))) {
    return `Only ${safeAllowed} question${safeAllowed === 1 ? '' : 's'} imported due to exam question limit.`;
  }
  return `Only ${safeAllowed} question${safeAllowed === 1 ? '' : 's'} imported due to exam question limit (${maxQuestionsPerExam} max per exam).`;
};

const IMPORT_GENERIC_FAILURE_MESSAGE = 'Import failed. No questions were added.';
const IMPORT_EMPTY_RESULT_MESSAGE = 'No valid questions found in file';
const IMPORT_INVALID_FILE_MESSAGE = 'Invalid file format';

const normalizeImportFailureMessage = (rawMessage) => {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return IMPORT_GENERIC_FAILURE_MESSAGE;
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes('unsupported file type') ||
    normalized.includes('invalid file type') ||
    normalized.includes('invalid file format') ||
    normalized.includes('no file uploaded')
  ) {
    return IMPORT_INVALID_FILE_MESSAGE;
  }

  if (
    normalized.includes('no extractable content') ||
    normalized.includes('no questions extracted') ||
    normalized.includes('no questions detected')
  ) {
    return IMPORT_EMPTY_RESULT_MESSAGE;
  }

  return message;
};

const buildImportFailurePayload = (rawMessage, extra = {}) => {
  const message = normalizeImportFailureMessage(rawMessage);
  return {
    success: false,
    importedCount: 0,
    message,
    error: message,
    ...extra,
  };
};

const buildImportSuccessPayload = ({
  questions = [],
  detectedCount = null,
  importReport = {},
  importLimitPerMonth = null,
  updatedImportUsage = null,
  remainingImports = null,
  examQuestionCount = null,
  maxQuestionsPerExam = null,
  partialImportWarning = '',
} = {}) => {
  const importedCount = Array.isArray(questions) ? questions.length : 0;
  const normalizedDetectedCount = Number.isFinite(Number(detectedCount))
    ? Math.max(importedCount, Math.floor(Number(detectedCount)))
    : importedCount;
  const warning = String(partialImportWarning || '').trim();
  const message =
    importedCount > 0
      ? `Successfully imported ${importedCount} question${importedCount === 1 ? '' : 's'}.`
      : IMPORT_EMPTY_RESULT_MESSAGE;

  return {
    success: true,
    importedCount,
    detectedCount: normalizedDetectedCount,
    message,
    questions: Array.isArray(questions) ? questions : [],
    importReport: importReport || {},
    warning,
    partialImportWarning: warning || null,
    warnings: warning ? [warning] : [],
    importLimitPerMonth,
    updatedImportUsage,
    remainingImports,
    importUsed: updatedImportUsage,
    importLimit: importLimitPerMonth,
    examQuestionCount,
    maxQuestionsPerExam,
    // Backward compatibility aliases
    importUsedThisMonth: updatedImportUsage,
    importFilesUsed: updatedImportUsage,
    importFilesRemaining: remainingImports,
    importQuestionsUsed: updatedImportUsage,
    importQuestionsRemaining: remainingImports,
  };
};

const resolveTenantAiUsageSummary = async ({ tenantId, effectivePlanType }) => {
  if (!tenantId) {
    return {
      aiQuestionsLimit: null,
      aiQuestionsUsed: 0,
      aiQuestionsRemaining: null,
      importQuestionsLimit: null,
      importQuestionsUsed: 0,
      importQuestionsRemaining: null,
      importFilesLimit: null,
      importFilesUsed: 0,
      importFilesRemaining: null,
      period: null,
    };
  }

  const tenant = await Tenant.findById(tenantId)
    .select('subscription aiUsageLimit extraCredits')
    .lean();
  const usageWindow = buildAiUsageWindow(tenant?.subscription || null);
  const aiQuestionsUsed = await getAIQuestionCountForTenantByWindow(
    tenantId,
    usageWindow.start,
    usageWindow.end
  );
  const importFilesUsed = await getAIUsageCountForTenantByWindow(
    tenantId,
    usageWindow.start,
    usageWindow.end,
    {
      features: ['question_import_file'],
      requestStatus: 'SUCCESS',
      field: 'events',
    }
  );
  const aiQuestionsLimit = resolveTenantAiQuestionLimit(effectivePlanType, tenant);
  const importQuestionsLimit = resolveTenantImportFileLimit(effectivePlanType, tenant);
  const maxQuestionsPerExam = resolveTenantMaxQuestionsPerExam(effectivePlanType, tenant);
  const aiQuestionsRemaining =
    aiQuestionsLimit === null
      ? null
      : Math.max((Number(aiQuestionsLimit) || 0) - (Number(aiQuestionsUsed) || 0), 0);
  const importFilesRemaining =
    importQuestionsLimit === null
      ? null
      : Math.max(
          (Number(importQuestionsLimit) || 0) - (Number(importFilesUsed) || 0),
          0
        );

  return {
    aiQuestionsLimit,
    aiQuestionsUsed,
    aiQuestionsRemaining,
    aiQuestionsPerMonth: aiQuestionsLimit,
    importQuestionsLimit,
    importQuestionsUsed: importFilesUsed,
    importQuestionsRemaining: importFilesRemaining,
    importLimitPerMonth: importQuestionsLimit,
    importUsedThisMonth: importFilesUsed,
    // Backward-compatibility aliases for older frontend/API consumers.
    importFilesLimit: importQuestionsLimit,
    importFilesUsed: importFilesUsed,
    importFilesRemaining: importFilesRemaining,
    maxQuestionsPerExam,
    period: {
      type: 'month',
      start: usageWindow.start,
      end: usageWindow.end,
    },
  };
};

router.get(
  '/usage-summary',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      const usageSummary = await resolveTenantAiUsageSummary({
        tenantId: req.user?.tenantId || null,
        effectivePlanType,
      });
      const requestedExamId = String(req.query?.examId || '').trim();
      const hasValidRequestedExamId = /^[a-fA-F0-9]{24}$/.test(requestedExamId);
      let examQuestionCount = null;
      if (hasValidRequestedExamId) {
        const scopedExamFilter = { _id: requestedExamId };
        if (req.user?.tenantId) {
          scopedExamFilter.tenantId = req.user.tenantId;
        } else if (req.user?._id) {
          scopedExamFilter.createdBy = req.user._id;
        }
        const scopedExam = await Exam.findOne(scopedExamFilter).select('_id').lean();
        if (scopedExam?._id) {
          examQuestionCount = await getQuestionCountForExam(scopedExam._id);
        }
      }

      return res.json({
        planType: String(effectivePlanType || '').trim().toUpperCase(),
        aiQuestionsLimit: usageSummary.aiQuestionsLimit,
        aiQuestionsUsed: usageSummary.aiQuestionsUsed,
        aiQuestionsRemaining: usageSummary.aiQuestionsRemaining,
        importQuestionsLimit: usageSummary.importQuestionsLimit,
        importQuestionsUsed: usageSummary.importQuestionsUsed,
        importQuestionsRemaining: usageSummary.importQuestionsRemaining,
        importLimitPerMonth: usageSummary.importLimitPerMonth,
        importUsedThisMonth: usageSummary.importUsedThisMonth,
        importFilesLimit: usageSummary.importFilesLimit,
        importFilesUsed: usageSummary.importFilesUsed,
        importFilesRemaining: usageSummary.importFilesRemaining,
        importUsed: usageSummary.importQuestionsUsed,
        importLimit: usageSummary.importQuestionsLimit,
        remainingImports: usageSummary.importQuestionsRemaining,
        examQuestionCount,
        maxQuestionsPerExam: usageSummary.maxQuestionsPerExam,
        aiQuestionsPerMonth: usageSummary.aiQuestionsPerMonth,
        period: usageSummary.period,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  }
);

// Generate questions using AI (available to EXAM_CREATOR)
router.post(
  '/import-questions',
  aiRateLimiter, // Rate limit AI operations
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can generate questions
  upload.single('file'),
  handleMulterUploadError,
  async (req, res, next) => {
    try {
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      const tenantId = req.user?.tenantId || null;
      let preImportUsageSummary = null;

      if (!req.file) {
        return res
          .status(400)
          .json(buildImportFailurePayload('No file uploaded. Please upload a valid file.'));
      }

      if (tenantId) {
        preImportUsageSummary = await resolveTenantAiUsageSummary({
          tenantId,
          effectivePlanType,
        });
        const monthlyImportLimit = preImportUsageSummary.importQuestionsLimit;
        const importFilesUsed = Number(preImportUsageSummary.importQuestionsUsed) || 0;

        if (monthlyImportLimit !== null && importFilesUsed >= monthlyImportLimit) {
          return sendPlanRestriction(res, buildImportFileLimitMessage(monthlyImportLimit), {
            code: 'LIMIT_EXCEEDED',
            usage: {
              importQuestions: {
                used: importFilesUsed,
                requested: 0,
                remaining: 0,
                limit: monthlyImportLimit,
              },
              // Backward-compatibility alias used by older modal parsers.
              importFiles: {
                used: importFilesUsed,
                requested: 0,
                remaining: 0,
                limit: monthlyImportLimit,
              },
              period: {
                type: 'month',
                start: preImportUsageSummary.period?.start || null,
                end: preImportUsageSummary.period?.end || null,
              },
            },
          });
        }
      }

      const importData = await parseQuestionImportFile(req.file);
      let { text, structuredRows } = importData;

      const structuredRowCount = Array.isArray(structuredRows)
        ? structuredRows.length
        : 0;
      const placeholderOnlyStructuredRows =
        structuredRowCount > 0 &&
        structuredRows.every((row) =>
          IMPORT_PLACEHOLDER_ROW_HINT_REGEX.test(extractStructuredRowText(row))
        );
      const shouldBypassSingleStructuredRow =
        !placeholderOnlyStructuredRows &&
        shouldPreferNumberedTextOverSingleStructuredRow({
          text,
          structuredRows,
        });

      if (placeholderOnlyStructuredRows || shouldBypassSingleStructuredRow) {
        console.log(
          '[question-import-debug] STRUCTURED ROW FILTER:',
          {
            structuredRowCount,
            placeholderOnlyStructuredRows,
            shouldBypassSingleStructuredRow,
          }
        );
        structuredRows = [];
      }

      if (placeholderOnlyStructuredRows) {
        const normalizedText = normalizeImportTextValue(text);
        const shouldDiscardText =
          IMPORT_PLACEHOLDER_ROW_HINT_REGEX.test(normalizedText) &&
          countNumberedQuestionMarkers(normalizedText) <= 1;
        if (shouldDiscardText) {
          text = '';
        }
        if (Array.isArray(importData.extractionErrors)) {
          importData.extractionErrors.push({
            stage: 'structured-row-filter',
            message:
              'Discarded placeholder scanned rows so OCR/text fallback can extract real questions.',
          });
        }
      }

      let hasText = typeof text === 'string' && text.trim().length > 0;
      let hasStructuredRows =
        Array.isArray(structuredRows) && structuredRows.length > 0;

      if (!hasText && !hasStructuredRows) {
        if (importData.extension === '.pdf') {
          const pdfOcr = await extractTextFromPdfBufferWithVision({
            pdfBuffer: req.file.buffer,
          });
          if (Array.isArray(pdfOcr.warnings) && pdfOcr.warnings.length) {
            importData.extractionErrors.push(...pdfOcr.warnings);
          }
          if (typeof pdfOcr.text === 'string' && pdfOcr.text.trim().length > 0) {
            text = pdfOcr.text;
            hasText = true;
          }
        }
      }

      if (!hasText && !hasStructuredRows && Array.isArray(importData.extractedArtifacts) && importData.extractedArtifacts.length) {
        const imageOcr = await extractTextFromImageArtifacts({
          artifacts: importData.extractedArtifacts,
        });
        if (Array.isArray(imageOcr.warnings) && imageOcr.warnings.length) {
          importData.extractionErrors.push(...imageOcr.warnings);
        }
        if (typeof imageOcr.text === 'string' && imageOcr.text.trim().length > 0) {
          text = imageOcr.text;
          hasText = true;
        }
      }

      if (!hasText && !hasStructuredRows) {
        return res.status(400).json({
          ...buildImportFailurePayload(IMPORT_EMPTY_RESULT_MESSAGE),
          importReport: {
            extractionErrors: Array.isArray(importData.extractionErrors)
              ? importData.extractionErrors
              : [],
          },
        });
      }

      const questions = await extractQuestionsFromContent({
        content: text,
        structuredRows,
        filename: req.file.originalname,
        tenantId: req.user?.tenantId || null,
        userId: req.user?._id || null,
        metadata: {
          tenantId: req.user?.tenantId || null,
          userId: req.user?._id || null,
        },
      });

      const imageAttachmentResult = await attachImagesToImportedQuestions({
        questions: Array.isArray(questions) ? questions : [],
        structuredRows,
        extractedArtifacts: importData.extractedArtifacts,
        rowImageReferences: importData.rowImageReferences,
        rowEmbeddedArtifacts: importData.rowEmbeddedArtifacts,
        extractionErrors: importData.extractionErrors,
        importSessionId: importData.importSessionId,
      });

      if (Array.isArray(imageAttachmentResult?.report?.extractionErrors) && imageAttachmentResult.report.extractionErrors.length) {
        console.warn(
          '[import-questions] completed with extraction warnings:',
          imageAttachmentResult.report.extractionErrors
        );
      }

      const detectedQuestions = Array.isArray(imageAttachmentResult?.questions)
        ? imageAttachmentResult.questions
        : [];
      const detectedQuestionCount = detectedQuestions.length;
      let importedQuestions = [...detectedQuestions];
      let importedQuestionCount = importedQuestions.length;
      let partialImportWarning = '';
      const skipUsageTracking =
        String(req.body?.skipUsageTracking || '').trim().toLowerCase() === 'true';
      let responseExamQuestionCount = null;
      let responseMaxQuestionsPerExam = null;

      if (tenantId) {
        const requestedExamId = String(req.body?.examId || '').trim();
        const hasValidRequestedExamId = /^[a-fA-F0-9]{24}$/.test(requestedExamId);
        const requestedCurrentQuestionCount = parseOptionalNonNegativeInt(
          req.body?.currentQuestionCount
        );
        let currentQuestionCount = requestedCurrentQuestionCount;

        if (hasValidRequestedExamId) {
          const scopedExamFilter = { _id: requestedExamId };
          if (tenantId) {
            scopedExamFilter.tenantId = tenantId;
          } else if (req.user?._id) {
            scopedExamFilter.createdBy = req.user._id;
          }
          const scopedExam = await Exam.findOne(scopedExamFilter).select('_id').lean();
          if (scopedExam?._id) {
            currentQuestionCount = await getQuestionCountForExam(scopedExam._id);
          }
        }

        if (currentQuestionCount !== null) {
          responseExamQuestionCount =
            Number(currentQuestionCount || 0) + Number(importedQuestionCount || 0);
        }

        const tenantForQuestionLimit = await Tenant.findById(tenantId)
          .select('subscription')
          .lean();
        responseMaxQuestionsPerExam = resolveTenantMaxQuestionsPerExam(
          effectivePlanType,
          tenantForQuestionLimit
        );

        if (currentQuestionCount !== null) {
          const maxQuestionsPerExam = responseMaxQuestionsPerExam;
          const availableQuestionSlots =
            maxQuestionsPerExam === null
              ? null
              : Math.max(Number(maxQuestionsPerExam || 0) - Number(currentQuestionCount || 0), 0);

          if (
            maxQuestionsPerExam !== null &&
            availableQuestionSlots <= 0
          ) {
            return sendPlanRestriction(
              res,
              buildExamQuestionLimitMessage(maxQuestionsPerExam),
              {
                code: 'LIMIT_EXCEEDED',
                usage: {
                  questions: {
                    used: Number(currentQuestionCount || 0),
                    requested: importedQuestionCount,
                    remaining: 0,
                    limit: maxQuestionsPerExam,
                  },
                },
              }
            );
          }

          if (
            maxQuestionsPerExam !== null &&
            Number(currentQuestionCount || 0) + importedQuestionCount > maxQuestionsPerExam
          ) {
            importedQuestions = importedQuestions.slice(0, availableQuestionSlots || 0);
            importedQuestionCount = importedQuestions.length;
            partialImportWarning = buildExamQuestionPartialImportWarning({
              allowedCount: importedQuestionCount,
              detectedCount: detectedQuestionCount,
              maxQuestionsPerExam,
            });
          }

          responseExamQuestionCount =
            Number(currentQuestionCount || 0) + Number(importedQuestionCount || 0);
        }
      }

      if (tenantId && importedQuestionCount > 0) {
        const usageSummary = preImportUsageSummary || (await resolveTenantAiUsageSummary({
          tenantId,
          effectivePlanType,
        }));
        const monthlyImportLimit = usageSummary.importQuestionsLimit;

        if (monthlyImportLimit !== null) {
          const importFilesUsed = Number(usageSummary.importQuestionsUsed) || 0;
          const wouldUse = importFilesUsed + 1;

          if (wouldUse > monthlyImportLimit) {
            const remaining = Math.max(monthlyImportLimit - importFilesUsed, 0);
            return sendPlanRestriction(res, buildImportFileLimitMessage(monthlyImportLimit), {
              code: 'LIMIT_EXCEEDED',
              usage: {
                importQuestions: {
                  used: importFilesUsed,
                  requested: 1,
                  remaining,
                  limit: monthlyImportLimit,
                },
                // Backward-compatibility alias used by older modal parsers.
                importFiles: {
                  used: importFilesUsed,
                  requested: 1,
                  remaining,
                  limit: monthlyImportLimit,
                },
                period: {
                  type: 'month',
                  start: usageSummary.period?.start || null,
                  end: usageSummary.period?.end || null,
                },
              },
            });
          }
        }
      }

      let importUsageIncrement = 0;
      if (tenantId && importedQuestionCount > 0 && !skipUsageTracking) {
        try {
          await trackAIUsageEvent({
            feature: 'question_import_file',
            tenantId,
            userId: req.user?._id || null,
            model: 'upload',
            usageCount: 1,
            questionCount: importedQuestionCount,
            requestStatus: 'SUCCESS',
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          });
          importUsageIncrement = 1;
        } catch (usageTrackError) {
          console.warn(
            '[import-questions] failed to track import file usage:',
            usageTrackError?.message || usageTrackError
          );
        }
      }

      let updatedImportUsage = null;
      let remainingImports = null;
      let importLimitPerMonth = null;
      if (tenantId) {
        const usageSummaryForResponse =
          preImportUsageSummary ||
          (await resolveTenantAiUsageSummary({
            tenantId,
            effectivePlanType,
          }));
        const importsUsedBefore = Number(usageSummaryForResponse?.importQuestionsUsed) || 0;
        importLimitPerMonth = usageSummaryForResponse?.importQuestionsLimit ?? null;
        updatedImportUsage =
          importedQuestionCount > 0 ? importsUsedBefore + importUsageIncrement : importsUsedBefore;
        remainingImports =
          importLimitPerMonth === null
            ? null
            : Math.max((Number(importLimitPerMonth) || 0) - Number(updatedImportUsage || 0), 0);
      }

      const responseQuestions = Array.isArray(importedQuestions)
        ? importedQuestions.map((question) => {
            const questionFormat =
              normalizeQuestionFormat({
                ...question,
                questionText: question?.questionText || question?.question_text || '',
              }) || '';

            return {
              ...question,
              questionFormat,
              question_type: questionFormat,
            };
          })
        : [];

      console.log('[question-import-debug] DETECTED TOTAL:', detectedQuestionCount);
      responseQuestions.forEach((question, index) => {
        console.log(
          `[question-import-debug] PREVIEW Q${index + 1}: questionType=${question?.questionType || ''} questionFormat=${question?.questionFormat || ''} hasImage=${Boolean(question?.imageUrl || question?.image_path || question?.generatedImage || question?.generated_image)}`
        );
      });

      return res.json(
        buildImportSuccessPayload({
          questions: responseQuestions,
          detectedCount: detectedQuestionCount,
          importReport: imageAttachmentResult?.report || {},
          importLimitPerMonth,
          updatedImportUsage,
          remainingImports,
          examQuestionCount: responseExamQuestionCount,
          maxQuestionsPerExam: responseMaxQuestionsPerExam,
          partialImportWarning,
        })
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json(buildImportFailurePayload(error.message));
      }
      console.error('[import-questions] unexpected error:', error);
      return res
        .status(500)
        .json(buildImportFailurePayload(error?.message || IMPORT_GENERIC_FAILURE_MESSAGE));
    }
  }
);

router.post(
  '/generate-questions',
  aiRateLimiter, // Rate limit AI operations
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can generate questions
  [
    body('topic').trim().notEmpty().withMessage('Topic/Domain is required'), // Universal: clarified as Topic/Domain
    body('count').isInt({ min: 1, max: 50 }).withMessage('Count must be between 1 and 50'),
    body('difficulty').isIn(['easy', 'medium', 'hard', 'ultra_hard']).withMessage('Invalid difficulty'),
    body('questionTypes').isArray().withMessage('Question types must be an array'),
    body('enableImageQuestions').optional().isBoolean().withMessage('enableImageQuestions must be boolean'),
    body('imageQuestionCount').optional().isInt({ min: 0, max: 50 }).withMessage('imageQuestionCount must be between 0 and 50'),
    body('imageQuestionRatio').optional().isFloat({ min: 0, max: 100 }).withMessage('imageQuestionRatio must be between 0 and 100'),
    body('imageQuestionPerCount').optional().isInt({ min: 1, max: 50 }).withMessage('imageQuestionPerCount must be between 1 and 50'),
    body('imageQuestionsPerImage').optional().isInt({ min: 1, max: 50 }).withMessage('imageQuestionsPerImage must be between 1 and 50'),
    body('questionsPerParagraph').optional().isInt({ min: 1, max: 50 }).withMessage('questionsPerParagraph must be between 1 and 50'),
    body('scenarioQuestionTypes').optional().isArray().withMessage('scenarioQuestionTypes must be an array'),
    body('imageQuestionMode').optional().isIn(['percentage', 'per_count']).withMessage('Invalid imageQuestionMode'),
    body('imageQuestionTypes').optional().isArray().withMessage('imageQuestionTypes must be an array'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        topic,
        count,
        difficulty,
        questionTypes,
        questionTypeDistribution, // NEW: Array of { type, count } objects for specific distribution
        duration,
        uploadedContent,
        examTitle,
        examDescription,
        existingQuestions, // Array of existing question texts to avoid duplicates
        enableImageQuestions,
        imageQuestionCount,
        imageQuestionRatio,
        imageQuestionPerCount,
        imageQuestionsPerImage,
        questionsPerParagraph,
        scenarioQuestionTypes,
        imageQuestionMode,
        imageQuestionTypes,
      } = req.body;
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);

      if (isFreePlan(effectivePlanType)) {
        const normalizeList = (list) =>
          Array.isArray(list) ? list.map(normalizeAiQuestionType).filter(Boolean) : [];
        const normalizedQuestionTypes = normalizeList(questionTypes);
        const includesParagraphType = normalizedQuestionTypes.includes('PARAGRAPH');
        const normalizedScenarioTypes = includesParagraphType
          ? normalizeList(scenarioQuestionTypes)
          : [];
        const imageGenerationRequested =
          enableImageQuestions === true || toNonNegativeInt(imageQuestionCount, 0) > 0;

        if (imageGenerationRequested) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.QUESTION_TYPE_LOCKED);
        }

        const allTypes = [
          ...normalizedQuestionTypes,
          ...normalizedScenarioTypes,
        ];
        const disallowed = allTypes.find((type) => !FREE_PLAN_ALLOWED_AI_TYPES.has(type));
        if (disallowed) {
          const message =
            disallowed === 'CODING'
              ? FREE_PLAN_MESSAGES.CODING_LOCKED
              : WRITING_AI_TYPES.has(disallowed)
                ? FREE_PLAN_MESSAGES.WRITING_AI_LOCKED
              : FREE_PLAN_AI_TYPE_LOCKED_MESSAGE;
          return sendPlanRestriction(res, message);
        }
      }

      const tenantId = req.user?.tenantId || null;
      const requestedQuestionCount = toNonNegativeInt(count, 0);
      if (tenantId && requestedQuestionCount > 0) {
        const usageSummary = await resolveTenantAiUsageSummary({
          tenantId,
          effectivePlanType,
        });
        const monthlyAiQuestionLimit = usageSummary.aiQuestionsLimit;

        if (monthlyAiQuestionLimit !== null) {
          const aiQuestionsUsed = Number(usageSummary.aiQuestionsUsed) || 0;
          const wouldUse = aiQuestionsUsed + requestedQuestionCount;

          if (wouldUse > monthlyAiQuestionLimit) {
            const remaining = Math.max(monthlyAiQuestionLimit - aiQuestionsUsed, 0);
            return sendPlanRestriction(
              res,
              buildAiQuestionLimitMessage(effectivePlanType, monthlyAiQuestionLimit),
              {
                code: 'LIMIT_EXCEEDED',
                usage: {
                  aiQuestions: {
                    used: aiQuestionsUsed,
                    requested: requestedQuestionCount,
                    remaining,
                    limit: monthlyAiQuestionLimit,
                  },
                  period: {
                    type: 'month',
                    start: usageSummary.period?.start || null,
                    end: usageSummary.period?.end || null,
                  },
                },
                ...(String(req.user?.role || '').trim().toUpperCase() === 'TENANT_ADMIN'
                  ? {
                      requestCredits: {
                        enabled: true,
                        type: CREDIT_REQUEST_TYPES.AI,
                      },
                    }
                  : {}),
              }
            );
          }
        }
      }

      // Store tenant metadata for AI generation tracking
      const aiMetadata = {
        tenantId,
        inputSource: uploadedContent ? 'DETAILED_CONTENT' : 'TOPIC_ONLY',
        generatedBy: req.user._id,
        generatedAt: new Date(),
      };

      const questions = await generateQuestions({
        topic,
        count,
        difficulty,
        questionTypes,
        questionTypeDistribution: Array.isArray(questionTypeDistribution) ? questionTypeDistribution : undefined,
        duration,
        uploadedContent,
        examTitle,
        examDescription,
        existingQuestions: Array.isArray(existingQuestions) ? existingQuestions : [],
        enableImageQuestions: enableImageQuestions === true,
        imageQuestionCount,
        imageQuestionRatio,
        imageQuestionPerCount,
        imageQuestionsPerImage,
        questionsPerParagraph,
        scenarioQuestionTypes: Array.isArray(scenarioQuestionTypes) ? scenarioQuestionTypes : undefined,
        imageQuestionMode,
        imageQuestionTypes: Array.isArray(imageQuestionTypes) ? imageQuestionTypes : [],
        tenantId,
        userId: req.user?._id || null,
        metadata: aiMetadata, // Pass metadata to AI service for logging
      });

      res.json({ 
        questions,
        metadata: aiMetadata, // Return metadata for frontend to store with exam
      });
    } catch (error) {
      next(error);
    }
  }
);

// Generate answer key from uploaded file using AI
router.post(
  '/generate-answer-key',
  aiRateLimiter,
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  imageUpload.single('file'),
  handleMulterUploadError,
  async (req, res, next) => {
    try {
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);
      if (
        isFreePlan(effectivePlanType) ||
        !isPlanFeatureEnabled(effectivePlanType, 'aiGrading')
      ) {
        return sendPlanRestriction(res, FREE_PLAN_MESSAGES.WRITING_AI_LOCKED);
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const fileExtension = path.extname(req.file.originalname || '').toLowerCase();
      let extractedContent = '';
      let structuredRows = null;

      // Handle different file types
      if (fileExtension === '.pdf') {
        const result = await pdfParse(req.file.buffer);
        extractedContent = result.text || '';
      } else if (['.xlsx', '.xls'].includes(fileExtension)) {
        const rows = await readXlsxFile(req.file.buffer);
        if (Array.isArray(rows) && rows.length > 0) {
          const headers = rows[0].map((header, idx) => {
            if (header === undefined || header === null || header === '') {
              return `Column${idx + 1}`;
            }
            return String(header).trim();
          });
          structuredRows = rows.slice(1).map((row) => {
            const obj = {};
            headers.forEach((header, idx) => {
              const value = row[idx];
              obj[header] = value === undefined || value === null ? '' : String(value);
            });
            return obj;
          });
          extractedContent = rows
            .map((row) => row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))).join(','))
            .join('\n');
        }
      } else if (['.jpg', '.jpeg', '.png'].includes(fileExtension)) {
        // For images, we'll use OpenAI Vision API if available
        // Otherwise, return error suggesting to convert to PDF
        if (!config.openaiApiKey) {
          return res.status(400).json({ 
            error: 'Image OCR requires OpenAI API key. Please convert image to PDF or use Excel format.' 
          });
        }

        const client = new OpenAI({ apiKey: config.openaiApiKey });
        
        // Convert image buffer to base64
        const base64Image = req.file.buffer.toString('base64');
        const mimeType = fileExtension === '.png' ? 'image/png' : 'image/jpeg';
        
        try {
          const response = await createTrackedChatCompletion({
            client,
            feature: 'answer_key_generation',
            tenantId: req.user?.tenantId,
            userId: req.user?._id,
            request: {
              model: OPENAI_MODEL,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'Extract all text content from this image. If this is an answer key or exam paper, extract all questions and their correct answers. Return the text in a structured format.',
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: `data:${mimeType};base64,${base64Image}`,
                      },
                    },
                  ],
                },
              ],
              max_tokens: 4000,
            },
          });
          
          extractedContent = response.choices[0].message.content || '';
        } catch (visionError) {
          console.error('OpenAI Vision API error:', visionError);
          return res.status(500).json({ 
            error: 'Failed to process image. Please convert image to PDF or use Excel format.' 
          });
        }
      } else {
        return res.status(400).json({ error: 'Unsupported file type' });
      }

      if (!extractedContent.trim() && !structuredRows) {
        return res.status(400).json({ error: 'No content extracted from file' });
      }

      // Use AI to extract answer key from content
      const systemPrompt = `You are an expert at extracting answer keys from exam papers and documents. 
Extract all questions and their correct answers from the provided content.
Return a JSON object with an "answers" object where keys are question numbers (q1, q2, q3, etc.) and values contain:
- questionText: The question text
- correctAnswer: The correct answer (string or array for multiple correct answers)
- points: Points for this question (default 1)

Format: { "answers": { "q1": { "questionText": "...", "correctAnswer": "...", "points": 1 }, ... } }`;

      const userPrompt = `Extract the answer key from the following content:\n\n${extractedContent.substring(0, 15000)}`;

      if (!config.openaiApiKey) {
        return res.status(500).json({ 
          error: 'OpenAI API key not configured. Cannot generate answer key.' 
        });
      }

      const client = new OpenAI({ apiKey: config.openaiApiKey });

      try {
        const completion = await createTrackedChatCompletion({
          client,
          feature: 'answer_key_generation',
          tenantId: req.user?.tenantId,
          userId: req.user?._id,
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
        let parsedResponse;

        try {
          parsedResponse = JSON.parse(responseContent);
        } catch (parseError) {
          const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
          if (jsonMatch) {
            parsedResponse = JSON.parse(jsonMatch[1]);
          } else {
            throw new Error('Failed to parse AI response as JSON');
          }
        }

        // Extract answers
        const answers = parsedResponse.answers || parsedResponse || {};

        // Validate and normalize answers
        const normalizedAnswers = {};
        Object.entries(answers).forEach(([key, value]) => {
          if (value && typeof value === 'object') {
            normalizedAnswers[key] = {
              questionText: String(value.questionText || '').trim(),
              correctAnswer: Array.isArray(value.correctAnswer) 
                ? value.correctAnswer 
                : String(value.correctAnswer || '').trim(),
              points: Number.isFinite(Number(value.points)) ? Number(value.points) : 1,
            };
          }
        });

        if (Object.keys(normalizedAnswers).length === 0) {
          return res.status(400).json({ error: 'No answer key found in the uploaded file' });
        }

        res.json({
          answerKey: {
            answers: normalizedAnswers,
            source: req.file.originalname,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (aiError) {
        console.error('AI answer key generation error:', aiError);
        return res.status(500).json({ 
          error: `Failed to generate answer key: ${aiError.message}` 
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;

