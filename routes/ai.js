import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { aiRateLimiter, uploadRateLimiter } from '../middleware/rateLimiter.js';
import { enforceContextSourceLimit } from '../middleware/planLimits.js';
import {
  QuestionDistributionError,
  generateQuestions,
  extractQuestionsFromContent,
} from '../services/aiService.js';
import {
  requireTenantFeature,
  resolveTenantFeature,
  assertImageGenerationAllowed,
} from '../services/tenantFeatureService.js';
import {
  ingestFileSource,
  ingestUrlSource,
  getOrCreateContextSet,
} from '../services/contextIngestionService.js';
import { generateWithNoveltyAndGrounding } from '../services/candidatePoolOrchestratorService.js';
import { mapFrameworkMemoryPolicy } from '../services/questionMemoryService.js';
import { buildTenantOwnedSourceFilter } from '../services/contextRetrievalService.js';
import { assertContentSourcesSelectable, ContentLibraryError } from '../services/contentLibraryService.js';
import { resolveLibraryResourcesToContextSourceIds } from '../services/libraryResourceService.js';
import { buildGenerationContext, CONTEXT_MODES, InsufficientContextError } from '../services/generationContextOrchestrator.js';
import { resolveGenerationStrategy } from '../services/groundedGenerationService.js';
import { computeShortfallDistribution } from '../utils/sourceGroundedFulfilment.js';
import { buildFrozenSourceReferences, buildQuestionProvenance } from '../services/questionProvenanceService.js';
import { buildGenerationEvidencePlan, summarizeEvidencePlan } from '../services/sourceDiscoveryService.js';
import { recordGenerationEvent } from '../services/questionHistoryService.js';
import { qualityGateQuestionsAgainstSpecification, resolveAssessmentSpecification } from '../services/assessmentSpecificationResolver.js';
import ContextSet from '../models/ContextSet.js';
import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import AIGenerationRun from '../models/AIGenerationRun.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import {
  parseQuestionImportFile,
  attachImagesToImportedQuestions,
  extractTextFromImageArtifacts,
  extractTextFromPdfBufferWithVision,
} from '../services/questionImportImageService.js';
import {
  assertImportCoverageOrThrow,
  buildDocumentMapFromImportData,
  buildImportExtractionReport,
  documentMapQuestionsToImportRows,
} from '../services/questionImportExtractionService.js';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import path from 'path';
import pdfParse from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';
import config from '../config/env.js';
import { runEngineChatCompletion, isOpenAIEngineConfigured, isEngineOperationAvailable } from '../services/aiEngine/aiEngineClient.js';
import { AI_OPERATIONS } from '../services/aiEngine/aiOperations.js';
import { normalizeQuestionFormat } from '../utils/questionTypes.js';
import {
  computeDistributionDiagnostics,
  normalizeQuestionType,
} from '../utils/questionTypeRegistry.js';
import {
  resolveEffectiveCognitiveDemandDistribution,
  resolveCognitiveDemandMapping,
  deriveCognitiveDemandFromBloom,
  validateCognitiveDemandDistribution,
  computeCognitiveDemandDiagnostics,
} from '../utils/cognitiveDemand.js';
import {
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

// Source-Grounded AI Question Generation — one file per upload request
// (the 10-source cap is enforced per contextSetId inside
// contextIngestionService, not by multer's `files` count, since sources
// are uploaded one at a time with independent per-row progress in the UI).
const contextSourceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.txt', '.csv', '.xlsx', '.xls', '.docx', '.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, TXT, CSV, XLSX, XLS, DOCX, PNG, JPG, JPEG'));
    }
  },
});

const router = express.Router();
const OPENAI_MODEL = config.openaiModel || 'gpt-4o-mini';

const normalizeAiQuestionType = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (['IMAGE', 'IMAGE_BASED', 'IMAGE-BASED'].includes(normalized)) return 'IMAGE';
  return normalizeQuestionType(value);
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

      const importData = await parseQuestionImportFile(req.file, {
        tenantId: req.user?.tenantId || null,
        userId: req.user?._id || null,
      });
      const isCsvImport =
        String(importData?.extension || '').trim().toLowerCase() === '.csv';
      let { text, structuredRows } = importData;

      const documentMap = buildDocumentMapFromImportData({
        text: importData.text,
        pageTexts: importData.pageTexts,
        filename: req.file.originalname,
      });
      const documentMapRows = documentMapQuestionsToImportRows(documentMap);

      if (process.env.NODE_ENV === 'development') {
        console.log('[question-import-debug] PIPELINE INPUT:', {
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          pageCount: importData.pageCount || documentMap?.documentMetadata?.pageCount || 0,
          extractedTextLength: documentMap?.documentMetadata?.extractedTextLength || 0,
          pagesSuccessfullyParsed: documentMap?.diagnostics?.pagesSuccessfullyParsed || 0,
          deterministicCandidateCount: documentMap?.diagnostics?.deterministicCandidateCount || 0,
          documentMapAcceptedCount: documentMap?.diagnostics?.acceptedCandidateCount || 0,
          visionCandidateCount: Array.isArray(importData.visionCandidates)
            ? importData.visionCandidates.length
            : 0,
          structuredRowCountBeforeFilter: Array.isArray(structuredRows) ? structuredRows.length : 0,
        });
      }

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
        if (process.env.NODE_ENV === 'development') {
          console.log(
            '[question-import-debug] STRUCTURED ROW FILTER:',
            {
              structuredRowCount,
              placeholderOnlyStructuredRows,
              shouldBypassSingleStructuredRow,
            }
          );
        }
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
        documentMapRows,
        visionRows: importData.visionCandidates || [],
        pageCount: importData.pageCount || documentMap?.documentMetadata?.pageCount || 0,
        filename: req.file.originalname,
        tenantId: req.user?.tenantId || null,
        userId: req.user?._id || null,
        metadata: {
          tenantId: req.user?.tenantId || null,
          userId: req.user?._id || null,
        },
      });

      assertImportCoverageOrThrow({
        documentMap,
        finalQuestions: questions,
        pageCount: importData.pageCount || documentMap?.documentMetadata?.pageCount || 0,
        textLength: documentMap?.documentMetadata?.extractedTextLength || 0,
      });

      const extractionReport = buildImportExtractionReport({
        filename: req.file.originalname,
        pageCount: importData.pageCount || documentMap?.documentMetadata?.pageCount || 0,
        textLength: documentMap?.documentMetadata?.extractedTextLength || 0,
        documentMap,
        reconciliation: {
          questions,
          primarySource: 'reconciled',
          sourceCounts: {
            documentMap: documentMapRows.length,
            final: questions.length,
          },
        },
        extractionErrors: importData.extractionErrors,
        processingStages: [
          'Reading document',
          `Analyzing ${importData.pageCount || documentMap?.documentMetadata?.pageCount || 1} page(s)`,
          'Identifying sections',
          'Detecting questions',
          'Validating question types',
          `Preparing ${questions.length} question(s) for review`,
        ],
      });

      const imageAttachmentResult = await attachImagesToImportedQuestions({
        questions: Array.isArray(questions) ? questions : [],
        structuredRows,
        extractedArtifacts: importData.extractedArtifacts,
        rowImageReferences: importData.rowImageReferences,
        rowEmbeddedArtifacts: importData.rowEmbeddedArtifacts,
        extractionErrors: importData.extractionErrors,
        importSessionId: importData.importSessionId,
        tenantId: req.user?.tenantId || null,
        // Question import must only ever use images that genuinely exist
        // in the uploaded file (mapped/extracted artifacts, handled
        // above this flag inside attachImagesToImportedQuestions) — never
        // synthesize a new AI-generated or fallback-SVG diagram for a
        // question whose text merely mentions one.
        generateMissingDiagrams: false,
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

        if (currentQuestionCount !== null && !isCsvImport) {
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

      if (process.env.NODE_ENV === 'development') {
        console.log('[question-import-debug] DETECTED TOTAL:', detectedQuestionCount);
        responseQuestions.forEach((question, index) => {
          console.log(
            `[question-import-debug] PREVIEW Q${index + 1}: questionType=${question?.questionType || ''} questionFormat=${question?.questionFormat || ''} hasImage=${Boolean(question?.imageUrl || question?.image_path || question?.generatedImage || question?.generated_image)}`
          );
        });
      }

      return res.json(
        buildImportSuccessPayload({
          questions: responseQuestions,
          detectedCount: detectedQuestionCount,
          importReport: {
            ...(imageAttachmentResult?.report || {}),
            ...extractionReport,
          },
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
        return res.status(error.statusCode).json(buildImportFailurePayload(error.message, {
          code: error.code || 'IMPORT_FAILED',
          importReport: error.importReport || {},
        }));
      }
      console.error('[import-questions] unexpected error:', error);
      return res
        .status(500)
        .json(buildImportFailurePayload(error?.message || IMPORT_GENERIC_FAILURE_MESSAGE));
    }
  }
);

// ---------------------------------------------------------------------
// Source-Grounded AI Question Generation — context source ingestion.
// Gated behind the SOURCE_GROUNDED_GENERATION capability (UNRELEASED at
// introduction, see services/tenantFeatureService.js), so these routes
// exist in production but return 403 for every tenant until the platform
// capability is deliberately flipped to BETA/RELEASED.
// ---------------------------------------------------------------------

router.post(
  '/context-sources',
  uploadRateLimiter,
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  requireTenantFeature('SOURCE_GROUNDED_GENERATION'),
  enforceContextSourceLimit,
  contextSourceUpload.single('file'),
  handleMulterUploadError,
  // nullable/checkFalsy: the client sends contextSetId only in the
  // uploaded-ContextSet flow; the Content Library flow legitimately has none
  // and may serialize it as null/''. Plain .optional() only skips
  // `undefined`, so those tripped isMongoId() with "Invalid contextSetId".
  [body('contextSetId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Invalid contextSetId')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

      const tenantId = req.user.tenantId;
      const contextSet = await getOrCreateContextSet({
        tenantId,
        userId: req.user._id,
        contextSetId: req.body.contextSetId,
      });

      // 10-source cap: authoritative check, done server-side against the
      // real count before any parse/embed work — never trust a
      // client-side count (master prompt §5, §27).
      const existingCount = await ContextSource.countDocuments({ tenantId, contextSetId: contextSet._id });
      if (existingCount >= sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET) {
        return res.status(400).json({
          error: `A generation session may include at most ${sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET} sources.`,
        });
      }

      const source = await ingestFileSource({
        tenantId,
        userId: req.user._id,
        contextSetId: contextSet._id,
        file: req.file,
      });

      return res.status(source.status === 'READY' ? 201 : 200).json({
        contextSetId: contextSet._id,
        source,
      });
    } catch (error) {
      if (error?.code === 'SOURCE_CAP_EXCEEDED') {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }
);

router.post(
  '/context-sources/url',
  uploadRateLimiter,
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  requireTenantFeature('SOURCE_GROUNDED_GENERATION'),
  enforceContextSourceLimit,
  [
    body('url').isURL({ protocols: ['http', 'https'], require_protocol: true }).withMessage('A valid http(s) URL is required'),
    body('contextSetId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Invalid contextSetId'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const tenantId = req.user.tenantId;
      const contextSet = await getOrCreateContextSet({
        tenantId,
        userId: req.user._id,
        contextSetId: req.body.contextSetId,
      });

      const existingCount = await ContextSource.countDocuments({ tenantId, contextSetId: contextSet._id });
      if (existingCount >= sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET) {
        return res.status(400).json({
          error: `A generation session may include at most ${sourceGroundedConfig.MAX_CONTEXT_SOURCES_PER_SET} sources.`,
        });
      }

      const source = await ingestUrlSource({
        tenantId,
        userId: req.user._id,
        contextSetId: contextSet._id,
        url: req.body.url,
      });

      return res.status(source.status === 'READY' ? 201 : 200).json({
        contextSetId: contextSet._id,
        source,
      });
    } catch (error) {
      if (error?.code === 'SOURCE_CAP_EXCEEDED') {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }
);

router.get(
  '/context-sources',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  requireTenantFeature('SOURCE_GROUNDED_GENERATION'),
  async (req, res, next) => {
    try {
      const tenantId = req.user.tenantId;
      const { contextSetId } = req.query;
      const filter = { tenantId };
      if (contextSetId) filter.contextSetId = contextSetId;
      // Never returns chunk text/embeddings — only status metadata for the
      // source-selection UI (master prompt §17: no internal chunk IDs
      // exposed to the frontend).
      const sources = await ContextSource.find(filter)
        .select('sourceType originalFilename sourceUrl status failureReason errorCode sourceProvider chunkCount extractedCharCount createdAt')
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ sources });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/context-sources/:id',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  requireTenantFeature('SOURCE_GROUNDED_GENERATION'),
  async (req, res, next) => {
    try {
      const tenantId = req.user.tenantId;
      // tenantId baked directly into the filter — never fetch-then-check.
      const deleted = await ContextSource.findOneAndDelete({ _id: req.params.id, tenantId });
      if (!deleted) return res.status(404).json({ error: 'Source not found.' });
      await ContextChunk.deleteMany({ tenantId, sourceId: deleted._id });
      await ContextSet.updateOne(
        { _id: deleted.contextSetId, tenantId },
        { $inc: { sourceCount: -1 } }
      );
      return res.json({ success: true });
    } catch (error) {
      next(error);
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
    // Topic is required for STANDARD generation but optional for
    // Source-Grounded generation (master prompt §15/§24/§41) — the
    // uploaded/linked source material itself is sufficient context there,
    // so forcing a Topic just to satisfy validation would be an
    // artificial requirement that previously blocked legitimate
    // "generate broadly from this document" requests.
    body('topic')
      .trim()
      .custom((value, { req }) => {
        const isSourceGroundedRequest =
          String(req.body?.generationMode || '').toUpperCase() === 'SOURCE_GROUNDED';
        if (!isSourceGroundedRequest && !value) {
          throw new Error('Topic/Domain is required');
        }
        return true;
      }),
    body('instructions').optional().isString().withMessage('Instructions must be a string'),
    body('count').isInt({ min: 1, max: 50 }).withMessage('Count must be between 1 and 50'),
    body('difficulty').isIn(['easy', 'medium', 'hard', 'ultra_hard']).withMessage('Invalid difficulty'),
    body('questionTypes').isArray().withMessage('Question types must be an array'),
    body('questionTypeDistribution').optional().isArray().withMessage('Question type distribution must be an array'),
    body('questionSorting').optional().isIn(['MIX_ALL', 'GROUP_BY_TYPE', 'ALTERNATING', 'CUSTOM']).withMessage('Invalid question sorting'),
    body('questionSortPattern').optional().isArray().withMessage('Question sort pattern must be an array'),
    body('enableImageQuestions').optional().isBoolean().withMessage('enableImageQuestions must be boolean'),
    body('imageQuestionCount').optional().isInt({ min: 0, max: 50 }).withMessage('imageQuestionCount must be between 0 and 50'),
    body('imageQuestionRatio').optional().isFloat({ min: 0, max: 100 }).withMessage('imageQuestionRatio must be between 0 and 100'),
    body('imageQuestionPerCount').optional().isInt({ min: 1, max: 50 }).withMessage('imageQuestionPerCount must be between 1 and 50'),
    body('imageQuestionsPerImage').optional().isInt({ min: 1, max: 50 }).withMessage('imageQuestionsPerImage must be between 1 and 50'),
    body('questionsPerParagraph').optional().isInt({ min: 1, max: 50 }).withMessage('questionsPerParagraph must be between 1 and 50'),
    body('scenarioQuestionTypes').optional().isArray().withMessage('scenarioQuestionTypes must be an array'),
    body('imageQuestionMode').optional().isIn(['percentage', 'per_count']).withMessage('Invalid imageQuestionMode'),
    body('imageQuestionTypes').optional().isArray().withMessage('imageQuestionTypes must be an array'),
    body('generationMode').optional().isIn(['STANDARD', 'SOURCE_GROUNDED']).withMessage('Invalid generationMode'),
    // `null` is the legacy/current UI representation of Automatic. Treat it
    // exactly like an omitted field; a real custom target must still be a
    // plain object and is revalidated below for LOT/MOT/HOT totals.
    body('cognitiveDemandDistribution').optional({ nullable: true }).isObject({ strict: true }).withMessage('cognitiveDemandDistribution must be an object'),
    // nullable/checkFalsy: the Content Library flow selects libraryResourceIds
    // and has no ContextSet, so the client legitimately sends no contextSetId
    // (or a null/'' from older serialization). Plain .optional() only skips
    // `undefined`, which is what surfaced as "Invalid contextSetId".
    body('contextSetId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Invalid contextSetId'),
    body('contextSourceIds').optional().isArray({ max: 10 }).withMessage('contextSourceIds must be an array of at most 10 items'),
    body('contextSourceIds.*').optional().isMongoId().withMessage('Invalid contextSourceIds entry'),
    body('libraryResourceIds').optional().isArray({ max: 10 }).withMessage('libraryResourceIds must be an array of at most 10 items'),
    body('libraryResourceIds.*').optional().isMongoId().withMessage('Invalid libraryResourceIds entry'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        topic,
        instructions,
        count,
        difficulty,
        questionTypes,
        questionTypeDistribution, // NEW: Array of { type, count } objects for specific distribution
        questionSorting,
        questionSortPattern,
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
        generationMode,
        contextSetId,
        contextSourceIds,
        libraryResourceIds,
        contextMode,
        cognitiveDemandDistribution: requestedCognitiveDemandDistribution,
      } = req.body;
      // Quick Assessment is intentionally independent of academic framework
      // policy. Older saved browser drafts can retain a resolved specification
      // after switching modes, so ignore that stale client state here.
      const creationMode = String(req.body?.creationMode || '').toUpperCase();
      const isQuickAssessment = creationMode === 'QUICK';
      const suppliedSpecification = isQuickAssessment ? null : (req.body?.resolvedSpecification || null);
      let governedSpecification = null;
      if (!isQuickAssessment && (suppliedSpecification || req.body?.assessmentPurpose || req.body?.frameworkId || req.body?.frameworkVersionId)) {
        const specificationContext = suppliedSpecification?.academicContext || req.body?.academicContext || {};
        governedSpecification = await resolveAssessmentSpecification({
          tenantId: req.user.tenantId,
          purpose: req.body?.assessmentPurpose || suppliedSpecification?.purpose || 'OF',
          assessmentType: req.body?.assessmentType || suppliedSpecification?.assessmentType || 'QUIZ',
          academicContext: specificationContext,
          frameworkId: req.body?.frameworkId || suppliedSpecification?.framework?.id || null,
          frameworkVersionId: req.body?.frameworkVersionId || suppliedSpecification?.frameworkVersion?.id || null,
          creatorOverrides: req.body?.creatorOverrides || {},
        });
        // Framework question types guide recommendations; they are not a
        // hidden allow-list. Canonical registry shape checks and active
        // feature/capability gates remain authoritative for technical
        // compatibility.
      }

      // Cognitive demand (Blueprint section 4B): an Academic framework's
      // approved target remains authoritative. If it does not declare one,
      // Academic Assessment receives the application-owned automatic
      // 30/40/30 target. Quick stays optional; unlabeled legacy callers keep
      // their prior no-target behavior.
      const effectiveCognitiveDemandDistribution = resolveEffectiveCognitiveDemandDistribution({
        creationMode,
        requestedDistribution: requestedCognitiveDemandDistribution,
        frameworkDistribution: governedSpecification?.specification?.cognitiveDemandDistribution || null,
      });
      const effectiveCognitiveDemandMapping = resolveCognitiveDemandMapping({
        cognitiveDemandMapping: isQuickAssessment
          ? null
          : governedSpecification?.specification?.cognitiveDemandMapping,
      });
      if (effectiveCognitiveDemandDistribution) {
        const distributionCheck = validateCognitiveDemandDistribution(effectiveCognitiveDemandDistribution);
        if (!distributionCheck.valid) {
          return res.status(400).json({ error: `Invalid cognitive demand distribution: ${distributionCheck.error}` });
        }
      }

      const isSourceGrounded = resolveGenerationStrategy({ generationMode }) === 'SOURCE_GROUNDED'
        || [CONTEXT_MODES.AUTO_CONTEXT, CONTEXT_MODES.SELECTED_CONTEXT, CONTEXT_MODES.STRICT_SOURCE].includes(String(contextMode || '').toUpperCase());
      const effectivePlanType = await resolveUserEffectivePlanType(req.user);

      let orchestratedContext = null;
      const normalizedContextMode = String(contextMode || CONTEXT_MODES.STANDARD).toUpperCase();
      if (normalizedContextMode !== CONTEXT_MODES.STANDARD) {
        try {
          orchestratedContext = await buildGenerationContext({
            user: req.user,
            creationMode: req.body.creationMode || 'STANDARD',
            academicContext: req.body.academicContext || governedSpecification?.academicContext || {},
            assessmentPurpose: req.body.assessmentPurpose || governedSpecification?.purpose || null,
            resolvedSpecification: governedSpecification?.specification || suppliedSpecification || null,
            topic,
            questionBlueprint: { questionTypes },
            selectedLibraryResourceIds: libraryResourceIds,
            selectedContextSourceIds: contextSourceIds,
            contextMode: normalizedContextMode,
            creatorInstructions: instructions,
            instructions,
          });
        } catch (contextError) {
          if (contextError instanceof InsufficientContextError) {
            return res.status(400).json({ error: contextError.message, code: contextError.code });
          }
          throw contextError;
        }
      }

      // Source-Grounded AI Question Generation — feature-flag + tenant-
      // ownership validation. This check is inline because it depends on
      // request-body generationMode.
      let verifiedContextSourceIds = [];
      if (isSourceGrounded) {
        const capability = await resolveTenantFeature(req.user.tenantId, 'SOURCE_GROUNDED_GENERATION');
        if (!capability?.effectiveEnabled) {
          return res.status(403).json({ error: 'Source-Grounded AI generation is not enabled for this tenant.' });
        }
        const requestedSourceIds = Array.isArray(contextSourceIds) ? contextSourceIds : [];
        const requestedLibraryResourceIds = Array.isArray(libraryResourceIds) ? libraryResourceIds : [];
        const orchestratedSourceIds = orchestratedContext?.selectedContextSourceIds || [];
        const orchestratedLibraryIds = orchestratedContext?.selectedLibraryResourceIds || [];
        if (requestedSourceIds.length === 0 && requestedLibraryResourceIds.length === 0 && orchestratedSourceIds.length === 0) {
          return res.status(400).json({ error: 'At least one content library resource or source must be selected for Source-Grounded generation.' });
        }
        let resolvedFromLibrary = [];
        const libraryIdsToResolve = orchestratedLibraryIds.length ? orchestratedLibraryIds : requestedLibraryResourceIds;
        if (libraryIdsToResolve.length) {
          try {
            resolvedFromLibrary = await resolveLibraryResourcesToContextSourceIds(req.user, libraryIdsToResolve);
          } catch (resolveError) {
            if (resolveError instanceof ContentLibraryError) {
              return res.status(resolveError.status).json({ error: resolveError.message, code: resolveError.code });
            }
            throw resolveError;
          }
        }
        const mergedSourceIds = [...new Set([
          ...requestedSourceIds.map(String),
          ...resolvedFromLibrary.map(String),
          ...orchestratedSourceIds.map(String),
        ])];
        if (mergedSourceIds.length > 10) {
          return res.status(400).json({ error: 'At most 10 context sources may be selected for Source-Grounded generation.' });
        }
        // The exact tenant-isolation / IDOR guard: every requested source
        // ID must belong to THIS tenant and be READY. A cross-tenant or
        // unknown ID silently fails this count-equality check rather than
        // ever being fetched/compared after the fact.
        const readyOwnedSources = await ContextSource.find(
          buildTenantOwnedSourceFilter({
            tenantId: req.user.tenantId,
            sourceIds: mergedSourceIds,
            status: 'READY',
          })
        ).select('createdBy isLibraryItem visibility academicScope libraryResourceId').lean();
        if (readyOwnedSources.length !== mergedSourceIds.length) {
          return res.status(403).json({
            error: 'One or more selected sources are unavailable, still processing, or do not belong to this tenant.',
          });
        }
        // Content Library authorization (Part S): a source another user
        // uploaded must fall within this requester's own academic
        // visibility (or be a SHARED, unscoped library item) — never
        // trusted just because it passed the tenant/READY check above.
        try {
          await assertContentSourcesSelectable(req.user, readyOwnedSources);
        } catch (scopeError) {
          if (scopeError instanceof ContentLibraryError) {
            return res.status(scopeError.status).json({ error: scopeError.message });
          }
          throw scopeError;
        }
        verifiedContextSourceIds = mergedSourceIds;
      }

      const normalizedDistribution = Array.isArray(questionTypeDistribution)
        ? questionTypeDistribution.map((item) => ({
          type: normalizeAiQuestionType(item?.type),
          count: toNonNegativeInt(item?.count, 0),
        })).filter((item) => item.type && item.count > 0)
        : [];
      const normalizedRequestedTypes = Array.isArray(questionTypes)
        ? questionTypes.map(normalizeAiQuestionType).filter(Boolean)
        : [];
      if (
        Array.isArray(questionTypes) &&
        normalizedRequestedTypes.length !== questionTypes.length
      ) {
        return res.status(400).json({
          error: 'One or more requested question types are invalid.',
        });
      }
      if (Array.isArray(questionTypeDistribution) && questionTypeDistribution.length > 0) {
        if (normalizedDistribution.length !== questionTypeDistribution.length) {
          return res.status(400).json({
            error: 'One or more question-type distribution entries are invalid.',
          });
        }
        const distributionTotal = normalizedDistribution.reduce(
          (sum, item) => sum + item.count,
          0
        );
        if (distributionTotal !== toNonNegativeInt(count, 0)) {
          return res.status(400).json({
            error: `Question type distribution totals ${distributionTotal}; it must equal the requested count ${count}.`,
          });
        }
        const unexpectedDistributionType = normalizedDistribution.find(
          (item) => !normalizedRequestedTypes.includes(item.type)
        );
        if (unexpectedDistributionType) {
          return res.status(400).json({
            error: `Question type ${unexpectedDistributionType.type} is present in the distribution but not in questionTypes.`,
          });
        }
      }
      const providerQuestionCount = toNonNegativeInt(count, 0);

      // AI-generated image questions — platform-wide kill switch (master
      // prompt §36-37, Rule 10). Checked for EVERY plan, not only free:
      // this supersedes the previous free-plan-only ad-hoc block, because
      // AI_IMAGE_QUESTION_GENERATION defaults UNRELEASED for every tenant
      // regardless of plan tier (see services/tenantFeatureService.js).
      // Manually authored image questions on existing exams are entirely
      // unaffected — this only ever gates a call that would invoke the AI
      // image-generation provider.
      const imageGenerationRequested =
        enableImageQuestions === true || toNonNegativeInt(imageQuestionCount, 0) > 0;
      if (imageGenerationRequested) {
        const imageGate = await assertImageGenerationAllowed({
          tenantId: req.user?.tenantId,
          effectivePlanType,
          featureOverrides: req.user?.subscriptionCustomFeatures || null,
        });
        if (!imageGate.allowed) {
          return sendPlanRestriction(res, imageGate.reason || FREE_PLAN_MESSAGES.QUESTION_TYPE_LOCKED);
        }
      }

      // Source-Grounded image questions are out of scope for this initial
      // pass (grounding an AI-generated diagram/image in retrieved source
      // text is a separate, larger feature) — reject explicitly rather
      // than silently mishandling the request. Since
      // AI_IMAGE_QUESTION_GENERATION is UNRELEASED platform-wide anyway,
      // this branch is presently unreachable for any tenant regardless.
      if (isSourceGrounded && imageGenerationRequested) {
        return res.status(400).json({
          error: 'AI-generated image questions are not supported in Source-Grounded generation mode.',
        });
      }

      if (isFreePlan(effectivePlanType)) {
        const normalizeList = (list) =>
          Array.isArray(list) ? list.map(normalizeAiQuestionType).filter(Boolean) : [];
        const normalizedQuestionTypes = normalizeList(questionTypes);
        const includesParagraphType = normalizedQuestionTypes.includes('PARAGRAPH');
        const normalizedScenarioTypes = includesParagraphType
          ? normalizeList(scenarioQuestionTypes)
          : [];

        const allTypes = [
          ...normalizedQuestionTypes,
          ...normalizedScenarioTypes,
        ];
        const disallowed = allTypes.find((type) => !FREE_PLAN_ALLOWED_AI_TYPES.has(type));
        if (disallowed) {
          const message =
            disallowed === 'CODING'
              ? 'Upgrade to Pro to generate coding questions'
              : WRITING_AI_TYPES.has(disallowed)
                ? FREE_PLAN_MESSAGES.WRITING_AI_LOCKED
                : FREE_PLAN_AI_TYPE_LOCKED_MESSAGE;
          return sendPlanRestriction(res, message);
        }
      }

      const tenantId = req.user?.tenantId || null;
      const requestedQuestionCount = providerQuestionCount;
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

      // Source discovery (spec Parts 5, 6, 23): before generating, search
      // every selected source and drop the ones that carry no relevant
      // evidence, so an unrelated book never reaches the model or provenance.
      let evidencePlanSummary = null;
      if (isSourceGrounded && verifiedContextSourceIds.length > 1) {
        try {
          const plan = await buildGenerationEvidencePlan({
            tenantId,
            contextSourceIds: verifiedContextSourceIds,
            topic,
            instructions: instructions || examDescription || '',
            questionTypes: normalizedRequestedTypes,
          });
          if (plan.selectedContextSourceIds.length) {
            verifiedContextSourceIds = plan.selectedContextSourceIds;
          }
          evidencePlanSummary = summarizeEvidencePlan(plan);
        } catch (discoveryError) {
          console.error('[source-grounded] evidence discovery failed (non-fatal):', discoveryError?.message);
        }
      }

      // Source-grounded generation never falls through to the unconstrained
      // general-knowledge path below.
      let providerQuestions = [];
      let sourceGroundedRun = null;
      let sourceGroundedDiagnostics = null;
      if (isSourceGrounded && providerQuestionCount > 0) {
        sourceGroundedRun = await AIGenerationRun.create({
          tenantId,
          userId: req.user._id,
          generationMode: 'SOURCE_GROUNDED',
          contextSetId: contextSetId || null,
          requestedSourceIds: verifiedContextSourceIds,
          requestedCount: providerQuestionCount,
          status: 'RUNNING',
          evidencePlanSummary: evidencePlanSummary || undefined,
        });

        // STRICT_SOURCE keeps the original anti-fallback contract: report the
        // exact shortfall rather than supplementing with general knowledge.
        // SELECTED_CONTEXT / AUTO_CONTEXT (the default Source-Grounded path)
        // always fulfil the request — ground what the sources support, then
        // top up the remainder on the same topic using the retrieved source
        // text as reference context (Blueprint §4C).
        const isStrictSource = normalizedContextMode === CONTEXT_MODES.STRICT_SOURCE;

        const memoryPolicy = governedSpecification?.specification?.rules?.memory
          ? mapFrameworkMemoryPolicy(governedSpecification.specification.rules.memory)
          : null;

        let groundedResult = null;
        let groundedQuestions = [];
        try {
          groundedResult = await generateWithNoveltyAndGrounding({
            tenantId,
            userId: req.user._id,
            generationRunId: sourceGroundedRun._id,
            sourceIds: verifiedContextSourceIds,
            topic,
            instructions: instructions || examDescription || '',
            difficulty,
            questionTypes: normalizedRequestedTypes,
            questionTypeDistribution: normalizedDistribution,
            targetCount: providerQuestionCount,
            examTitle,
            examDescription,
            memoryPolicy,
          });
          groundedQuestions = Array.isArray(groundedResult.questions) ? groundedResult.questions : [];
        } catch (groundedError) {
          if (isStrictSource) {
            sourceGroundedRun.status = 'FAILED';
            sourceGroundedRun.errorMessage = groundedError?.message || 'Source-grounded generation failed.';
            sourceGroundedRun.completedAt = new Date();
            await sourceGroundedRun.save();
            throw groundedError;
          }
          // Non-strict: a grounded-pass failure is not fatal — fall through to
          // the topic top-up below so the request is still fulfilled.
          console.error('[source-grounded] grounded pass failed; supplementing from topic:', groundedError?.message);
          groundedResult = null;
          groundedQuestions = [];
        }

        if (isStrictSource) {
          providerQuestions = groundedQuestions;
          sourceGroundedDiagnostics = {
            insufficientSourceMaterial: groundedResult.insufficientSourceMaterial,
            insufficientReason: groundedResult.insufficientReason,
            dominantRejectionReason: groundedResult.dominantRejectionReason,
            requestedCount: providerQuestionCount,
            acceptedCount: groundedResult.acceptedCount,
            rejectedCount: groundedResult.rejectedCount,
            rejectionReasons: groundedResult.rejectionReasons,
            attempts: groundedResult.attempts,
            requestedDistribution: groundedResult.requestedDistribution,
            generatedDistribution: groundedResult.generatedDistribution,
            missingDistribution: groundedResult.missingDistribution,
          };
          sourceGroundedRun.acceptedCount = groundedResult.acceptedCount;
          sourceGroundedRun.rejectedCount = groundedResult.rejectedCount;
          sourceGroundedRun.rejectionReasons = groundedResult.rejectionReasons;
          sourceGroundedRun.insufficientSourceMaterial = groundedResult.insufficientSourceMaterial;
          sourceGroundedRun.status =
            groundedResult.acceptedCount >= providerQuestionCount
              ? 'COMPLETED'
              : groundedResult.acceptedCount > 0
                ? 'PARTIAL'
                : 'FAILED';
          sourceGroundedRun.completedAt = new Date();
          await sourceGroundedRun.save();

          if (groundedResult.missingDistribution.length > 0) {
            throw new QuestionDistributionError({
              requested: groundedResult.requestedDistribution,
              generated: groundedResult.generatedDistribution,
              missing: groundedResult.missingDistribution.map((item) => ({
                type: item.type,
                expected: groundedResult.requestedDistribution[item.type] || 0,
                actual: groundedResult.generatedDistribution[item.type] || 0,
                count: item.count,
              })),
            });
          }
        } else {
          const { shortfallDistribution, shortfallCount } = computeShortfallDistribution({
            requestedDistribution: normalizedDistribution,
            requestedCount: providerQuestionCount,
            generatedByType: groundedResult?.generatedDistribution || {},
            fallbackTypes: normalizedRequestedTypes,
          });

          let supplementQuestions = [];
          if (shortfallCount > 0) {
            // Reference context so the top-up still "checks the attached
            // file": the token-budgeted chunks the orchestrator already
            // retrieved, else a direct sample of this source's chunks.
            let referenceText = (orchestratedContext?.retrievedChunks || [])
              .map((chunk) => String(chunk?.text || '').trim())
              .filter(Boolean)
              .join('\n\n');
            if (!referenceText && verifiedContextSourceIds.length) {
              const sampleChunks = await ContextChunk.find({
                tenantId,
                sourceId: { $in: verifiedContextSourceIds },
              })
                .select('text')
                .sort({ sourceId: 1, chunkIndex: 1 })
                .limit(sourceGroundedConfig.RETRIEVAL_TOP_K || 12)
                .lean();
              referenceText = sampleChunks
                .map((chunk) => String(chunk?.text || '').trim())
                .filter(Boolean)
                .join('\n\n');
            }

            supplementQuestions = await generateQuestions({
              topic,
              count: shortfallCount,
              difficulty,
              questionTypes: shortfallDistribution.length
                ? shortfallDistribution.map((item) => item.type)
                : normalizedRequestedTypes,
              questionTypeDistribution: shortfallDistribution.length ? shortfallDistribution : undefined,
              uploadedContent: referenceText || uploadedContent || undefined,
              examTitle,
              examDescription,
              existingQuestions: [
                ...(Array.isArray(existingQuestions) ? existingQuestions : []),
                ...groundedQuestions.map((question) => question?.questionText).filter(Boolean),
              ],
              cognitiveDemandDistribution: effectiveCognitiveDemandDistribution,
              cognitiveDemandMapping: effectiveCognitiveDemandMapping,
              tenantId,
              userId: req.user?._id || null,
              metadata: aiMetadata,
              // Resilient by design: the shortfall distribution still steers
              // the provider toward the right types/count, but a provider or
              // distribution failure degrades to the deterministic local
              // filler rather than throwing — the request must always be
              // fulfilled for SELECTED_CONTEXT / AUTO_CONTEXT (Blueprint §4C).
              requireProviderExactDistribution: false,
            });
          }

          providerQuestions = [...groundedQuestions, ...(Array.isArray(supplementQuestions) ? supplementQuestions : [])];
          const deliveredCount = providerQuestions.length;
          sourceGroundedDiagnostics = {
            // Never surfaced as a blocking error for SELECTED_CONTEXT /
            // AUTO_CONTEXT — kept for telemetry / the "View source evidence"
            // affordance only.
            fulfilled: deliveredCount >= providerQuestionCount,
            requestedCount: providerQuestionCount,
            acceptedCount: deliveredCount,
            groundedCount: groundedQuestions.length,
            supplementedCount: Array.isArray(supplementQuestions) ? supplementQuestions.length : 0,
            attempts: groundedResult?.attempts || 0,
            requestedDistribution: groundedResult?.requestedDistribution || {},
            generatedDistribution: groundedResult?.generatedDistribution || {},
            rejectionReasons: groundedResult?.rejectionReasons || {},
          };
          sourceGroundedRun.acceptedCount = groundedQuestions.length;
          sourceGroundedRun.supplementedCount = Array.isArray(supplementQuestions) ? supplementQuestions.length : 0;
          sourceGroundedRun.rejectedCount = groundedResult?.rejectedCount || 0;
          sourceGroundedRun.rejectionReasons = groundedResult?.rejectionReasons || {};
          sourceGroundedRun.insufficientSourceMaterial = false;
          sourceGroundedRun.status = deliveredCount >= providerQuestionCount
            ? 'COMPLETED'
            : deliveredCount > 0
              ? 'PARTIAL'
              : 'FAILED';
          sourceGroundedRun.completedAt = new Date();
          await sourceGroundedRun.save();
        }
      } else if (providerQuestionCount > 0) {
        providerQuestions = await generateQuestions({
          topic,
          count: providerQuestionCount,
          difficulty,
          questionTypes: normalizedRequestedTypes,
          questionTypeDistribution: normalizedDistribution.length ? normalizedDistribution : undefined,
          questionSorting,
          questionSortPattern: Array.isArray(questionSortPattern) ? questionSortPattern : undefined,
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
          cognitiveDemandDistribution: effectiveCognitiveDemandDistribution,
          cognitiveDemandMapping: effectiveCognitiveDemandMapping,
          tenantId,
          userId: req.user?._id || null,
          metadata: aiMetadata,
          requireProviderExactDistribution: true,
        });
      }

      // --- Source-Verified provenance freeze (spec Parts 1, 2, 10) ----------
      // Xamigo assigns every educator-facing source value (resource title /
      // chapter / topic / page) from persisted LibraryResource / ContextSource
      // / ContextChunk metadata — the AI provider contributes none of it.
      // Never let provenance enrichment break generation.
      let sourceCoverage = null;
      try {
        if (isSourceGrounded) {
          const grounded = [];
          for (const q of providerQuestions) {
            const cited = q?.citedEvidence || {};
            const chunkIds = Array.isArray(q?.provenance?.chunkIds) ? q.provenance.chunkIds.map(String) : [];
            if (!chunkIds.length) {
              // A top-up (non-strict) or otherwise ungrounded question — labelled
              // honestly, never with a fabricated textbook reference.
              q.provenance = buildQuestionProvenance({
                generationMode: 'STANDARD',
                sourcePolicy: 'NONE',
                creatorInstruction: instructions || '',
                generationRunId: sourceGroundedRun?._id || null,
                generatedAt: new Date(),
              });
              continue;
            }
            const chunkUsage = new Map();
            (cited.conceptChunkIds || chunkIds).forEach((id) =>
              chunkUsage.set(String(id), [...(chunkUsage.get(String(id)) || []), 'QUESTION_CONCEPT']));
            (cited.answerChunkIds || []).forEach((id) =>
              chunkUsage.set(String(id), [...(chunkUsage.get(String(id)) || []), 'ANSWER_SUPPORT']));
            // eslint-disable-next-line no-await-in-loop
            const sourceReferences = await buildFrozenSourceReferences({ tenantId, chunkIds, chunkUsage });
            q.provenance = buildQuestionProvenance({
              generationMode: 'SOURCE_GROUNDED',
              sourcePolicy:
                normalizedContextMode === CONTEXT_MODES.STRICT_SOURCE
                  ? 'STRICT_SOURCE'
                  : normalizedContextMode === CONTEXT_MODES.AUTO_CONTEXT
                    ? 'AUTO_CONTEXT'
                    : 'SELECTED_CONTEXT',
              creatorInstruction: instructions || '',
              generationRunId: sourceGroundedRun?._id || null,
              generationOperationId: 'CONTENT_GROUNDED_QUESTION_GENERATION',
              groundingVerdict: q.groundingVerdict || (sourceReferences.length ? 'SUPPORTED' : 'UNSUPPORTED'),
              sourceReferences,
              noveltySignatures: q.provenance?.noveltySignatures,
              generatedAt: new Date(),
            });
            grounded.push(q);
            delete q.citedEvidence;
            delete q.groundingVerdict;
          }
          // Real per-resource question counts, computed from the frozen refs
          // (never a "pretty distribution that did not happen" — spec Part 24).
          const byResource = new Map();
          const chaptersUsed = new Set();
          for (const q of grounded) {
            for (const ref of q.provenance?.sourceReferences || []) {
              const key = ref.resourceTitleSnapshot || ref.fileTitleSnapshot || 'Unknown';
              byResource.set(key, (byResource.get(key) || 0) + 1);
              if (ref.chapterSnapshot) chaptersUsed.add(ref.chapterSnapshot);
            }
          }
          sourceCoverage = {
            ...(evidencePlanSummary || {}),
            sourcesSelected: evidencePlanSummary?.sourcesSelected ?? verifiedContextSourceIds.length,
            sourcesRelevant: evidencePlanSummary?.sourcesRelevant ?? byResource.size,
            chaptersUsed: chaptersUsed.size,
            questionsByResource: Object.fromEntries(byResource),
            groundedQuestionCount: grounded.length,
            supplementedQuestionCount: providerQuestions.length - grounded.length,
          };
        }
      } catch (provenanceError) {
        console.error('[source-grounded] provenance freeze failed (non-fatal):', provenanceError?.message);
      }

      // Question generation history event (spec Parts 12, 13) — tenant-scoped,
      // fire-and-forget, never blocks the response, never mutates a question.
      void recordGenerationEvent({
        tenantId,
        userId: req.user?._id || null,
        generationRunId: sourceGroundedRun?._id || null,
        generationMode: isSourceGrounded ? 'SOURCE_GROUNDED' : 'STANDARD',
        questionTypes: normalizedRequestedTypes,
        difficulty,
        topic,
        questions: providerQuestions,
      }).catch(() => {});

      // The application re-resolves policy server-side. AI receives/requested
      // constraints, but never chooses governance rules itself.
      const qualityGate = qualityGateQuestionsAgainstSpecification(
        providerQuestions,
        governedSpecification?.specification || null
      );
      // cognitiveDemand is always application-derived from bloomLevel + the
      // resolved mapping here — never trusted from any AI-provided label
      // (none of the prompts above even ask the model for cognitiveDemand
      // directly, only bloomLevel). A question with no bloomLevel keeps
      // cognitiveDemand: null rather than a guessed value.
      const questions = qualityGate.accepted
        .map((question, index) => ({
          ...question,
          order: index + 1,
          cognitiveDemand: deriveCognitiveDemandFromBloom(question.bloomLevel, effectiveCognitiveDemandMapping),
        }));

      // Requested-vs-generated distribution diagnostics: compares the exact
      // per-type counts the caller asked for against what actually came
      // back, so the frontend can show a distribution-mismatch warning
      // instead of silently trusting the count.
      const distributionDiagnostics = computeDistributionDiagnostics(
        normalizedDistribution.length ? normalizedDistribution : questionTypeDistribution,
        questions
      );
      // Same idea for cognitive demand — never trust the aggregate count
      // blindly; report target vs actual so the creator/UI can see it
      // (Post-generation validation: "Do not trust the AI's label blindly").
      const cognitiveDemandDiagnostics = computeCognitiveDemandDiagnostics({
        targetDistribution: effectiveCognitiveDemandDistribution,
        questions,
        mapping: effectiveCognitiveDemandMapping,
      });

      res.json({
        questions,
        metadata: aiMetadata, // Return metadata for frontend to store with exam
        requestedDistribution: distributionDiagnostics.requested,
        generatedDistribution: distributionDiagnostics.generated,
        totalQuestions: Array.isArray(questions) ? questions.length : 0,
        validationStatus: distributionDiagnostics.validationStatus,
        cognitiveDemandDiagnostics,
        qualityGate: { acceptedCount: questions.length, rejected: qualityGate.rejected },
        ...(governedSpecification ? { resolvedSpecification: governedSpecification } : {}),
        ...(sourceGroundedDiagnostics ? { sourceGrounded: sourceGroundedDiagnostics } : {}),
        ...(sourceCoverage ? { sourceCoverage } : {}),
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
        if (!isEngineOperationAvailable(AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE)) {
          return res.status(400).json({ 
            error: 'Image OCR requires Gemini API key. Please convert image to PDF or use Excel format.' 
          });
        }
        
        // Convert image buffer to base64
        const base64Image = req.file.buffer.toString('base64');
        const mimeType = fileExtension === '.png' ? 'image/png' : 'image/jpeg';
        
        try {
          const response = await runEngineChatCompletion({
            operation: AI_OPERATIONS.QUESTION_IMPORT_ASSISTANCE,
            feature: 'answer_key_generation',
            tenantId: req.user?.tenantId,
            userId: req.user?._id,
            request: {
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

      if (!isOpenAIEngineConfigured()) {
        return res.status(500).json({ 
          error: 'OpenAI API key not configured. Cannot generate answer key.' 
        });
      }

      try {
        const completion = await runEngineChatCompletion({
          operation: AI_OPERATIONS.QUESTION_CLASSIFICATION,
          feature: 'answer_key_generation',
          tenantId: req.user?.tenantId,
          userId: req.user?._id,
          request: {
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
