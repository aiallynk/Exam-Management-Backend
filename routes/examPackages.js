import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { hasExamPermission, requireExamPermission } from '../middleware/examPermissions.js';
import { body, validationResult } from 'express-validator';
import { validateObjectId } from '../middleware/validation.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import {
  generateExamPackage,
  getExamPackage,
  getPackageInfo,
  validatePackageHash,
  decryptPackage,
} from '../services/examPackageService.js';
import { isExamPackageRegenerationInFlight } from '../services/examPackageRegenerationService.js';
import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import ExamPackage from '../models/ExamPackage.js';

const router = express.Router();

const PACKAGE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  GENERATED: 'GENERATED', // legacy persisted value
  FAILED: 'FAILED',
});
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const MIN_ENCRYPTED_PACKAGE_LENGTH = IV_LENGTH + TAG_LENGTH + 1;
const MIN_QUESTIONS_PER_DOWNLOAD = 10;
const RECOMMENDED_QUESTIONS_PER_DOWNLOAD = 10;

const normalizePackageStatus = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === PACKAGE_STATUS.GENERATED || normalized === PACKAGE_STATUS.READY) {
    return PACKAGE_STATUS.READY;
  }
  if (normalized === PACKAGE_STATUS.PROCESSING) return PACKAGE_STATUS.PROCESSING;
  if (normalized === PACKAGE_STATUS.FAILED) return PACKAGE_STATUS.FAILED;
  return PACKAGE_STATUS.PENDING;
};

const normalizeOptionalObjectId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (['null', 'undefined', 'all', 'latest', 'none'].includes(lowered)) {
    return null;
  }
  return /^[a-fA-F0-9]{24}$/.test(raw) ? raw : null;
};

const normalizeTenantId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (['null', 'undefined'].includes(lowered)) {
    return null;
  }
  return raw;
};

const getBinaryLength = (value) => {
  if (!value) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (value?._bsontype === 'Binary' && Buffer.isBuffer(value.buffer)) {
    const sourceLength = value.buffer.length;
    let rawLengthSource = sourceLength;
    try {
      rawLengthSource = typeof value.length === 'function' ? value.length() : value.position;
    } catch {
      rawLengthSource = sourceLength;
    }
    const rawLength = Number(rawLengthSource || sourceLength);
    return Number.isFinite(rawLength)
      ? Math.max(0, Math.min(rawLength, sourceLength))
      : sourceLength;
  }
  if (typeof value.length === 'number') return value.length;
  if (value?.buffer && typeof value.buffer.length === 'number') return value.buffer.length;
  if (ArrayBuffer.isView(value) && typeof value.byteLength === 'number') {
    return value.byteLength;
  }
  const fallback = Number(value?.byteLength || 0);
  return Number.isFinite(fallback) ? fallback : 0;
};

const markPackageFailed = async (examId, errorMessage) => {
  if (!examId) return;
  await Exam.updateOne(
    { _id: examId },
    {
      $set: {
        packageStatus: PACKAGE_STATUS.FAILED,
        packageLastError: String(errorMessage || 'Package generation failed').slice(0, 500),
        latestPackageUrl: '',
      },
    }
  ).catch(() => {});
};

const toSafeEncryptedBuffer = (value, contextLabel = 'Package Download') => {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;

  if (value?._bsontype === 'Binary' && Buffer.isBuffer(value.buffer)) {
    const sourceLength = value.buffer.length;
    let rawLengthSource = sourceLength;
    try {
      rawLengthSource = typeof value.length === 'function' ? value.length() : value.position;
    } catch {
      rawLengthSource = sourceLength;
    }
    const rawLength = Number(rawLengthSource || sourceLength);
    const safeLength = Number.isFinite(rawLength)
      ? Math.max(0, Math.min(rawLength, sourceLength))
      : sourceLength;

    console.log(
      `[${contextLabel}] bson-binary offsets rawOffset=0 rawLength=${rawLength} safeOffset=0 safeLength=${safeLength} sourceByteLength=${sourceLength}`
    );

    return value.buffer.subarray(0, safeLength);
  }

  if (ArrayBuffer.isView(value)) {
    const sourceByteLength = Number(value.buffer?.byteLength || 0);
    const rawOffset = Number(value.byteOffset || 0);
    const rawLength = Number(value.byteLength || 0);
    const safeOffset = Number.isFinite(rawOffset)
      ? Math.max(0, Math.min(rawOffset, sourceByteLength))
      : 0;
    const maxLengthFromOffset = Math.max(0, sourceByteLength - safeOffset);
    const safeLength = Number.isFinite(rawLength)
      ? Math.max(0, Math.min(rawLength, maxLengthFromOffset))
      : 0;

    console.log(
      `[${contextLabel}] binary-view offsets rawOffset=${rawOffset} rawLength=${rawLength} safeOffset=${safeOffset} safeLength=${safeLength} sourceByteLength=${sourceByteLength}`
    );

    if (safeLength <= 0) {
      return Buffer.alloc(0);
    }

    try {
      // Buffer.from(view) safely copies only the visible window and avoids offset overflow.
      return Buffer.from(value).subarray(0, safeLength);
    } catch (error) {
      console.warn(
        `[${contextLabel}] Failed to normalize binary view via Buffer.from(view): ${error?.message || error}`
      );
      return Buffer.from(value.buffer.slice(safeOffset, safeOffset + safeLength));
    }
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  return null;
};

const splitEncryptedBuffer = (encryptedBuffer, contextLabel = 'Package Download') => {
  const totalLength = Number(encryptedBuffer?.length || 0);
  const ivStart = 0;
  const ivEnd = Math.min(IV_LENGTH, totalLength);
  const tagStart = ivEnd;
  const tagEnd = Math.min(tagStart + TAG_LENGTH, totalLength);
  const cipherStart = tagEnd;
  const cipherEnd = totalLength;

  console.log(
    `[${contextLabel}] payload offsets total=${totalLength} iv=[${ivStart},${ivEnd}) tag=[${tagStart},${tagEnd}) cipher=[${cipherStart},${cipherEnd})`
  );

  if (
    totalLength < MIN_ENCRYPTED_PACKAGE_LENGTH ||
    ivEnd - ivStart !== IV_LENGTH ||
    tagEnd - tagStart !== TAG_LENGTH ||
    cipherStart < 0 ||
    cipherStart >= totalLength
  ) {
    throw new Error('Corrupted package payload offsets');
  }

  return {
    ivBuffer: encryptedBuffer.subarray(ivStart, ivEnd),
    authTagBuffer: encryptedBuffer.subarray(tagStart, tagEnd),
    cipherTextBuffer: encryptedBuffer.subarray(cipherStart, cipherEnd),
  };
};

const prefersBinaryPackageResponse = (req) => {
  const packageFormat = String(req.headers['x-package-format'] || '')
    .trim()
    .toLowerCase();
  if (packageFormat === 'binary') {
    return true;
  }

  const acceptHeader = String(req.headers.accept || '').toLowerCase();
  return acceptHeader.includes('application/octet-stream');
};

const isValidPackageTiming = (timing) => {
  if (!timing || typeof timing !== 'object') return false;
  const duration = Number(timing.duration);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const startTime = Date.parse(String(timing.startTime || '').trim());
  const endTime = Date.parse(String(timing.endTime || '').trim());
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime;
};

const toFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return fallback;
};

const toValidDate = (value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const buildFallbackTiming = ({
  payload,
  exam,
  packageData,
}) => {
  const sourceTiming =
    payload?.timing && typeof payload.timing === 'object' ? payload.timing : {};

  let duration = toFiniteNumber(
    sourceTiming.duration,
    toFiniteNumber(
      payload?.duration,
      toFiniteNumber(payload?.exam?.duration, toFiniteNumber(exam?.duration, 0))
    )
  );

  let startAt =
    toValidDate(sourceTiming.startTime) ||
    toValidDate(payload?.startTime) ||
    toValidDate(payload?.metadata?.createdAt) ||
    toValidDate(packageData?.createdAt) ||
    new Date();

  let endAt =
    toValidDate(sourceTiming.endTime) ||
    toValidDate(payload?.endTime) ||
    toValidDate(payload?.metadata?.expiresAt) ||
    toValidDate(packageData?.expiresAt);

  if ((!endAt || endAt < startAt) && Number.isFinite(duration) && duration > 0) {
    endAt = new Date(startAt.getTime() + duration * 60 * 1000);
  }

  if ((!duration || duration <= 0) && endAt && endAt >= startAt) {
    duration = Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / 60000));
  }

  if (!Number.isFinite(duration) || duration <= 0 || !startAt || !endAt || endAt < startAt) {
    return null;
  }

  return {
    duration,
    startTime: startAt.toISOString(),
    endTime: endAt.toISOString(),
  };
};

const normalizeDecryptedPayloadForDownload = ({
  payload,
  exam,
  examTenantId,
  packageData,
  resolvedQuestionPaperId,
}) => {
  const sourcePayload = payload && typeof payload === 'object' ? payload : {};
  const sourceQuestions = Array.isArray(sourcePayload.questions)
    ? sourcePayload.questions
    : [];
  const sourceExam =
    sourcePayload.exam && typeof sourcePayload.exam === 'object'
      ? sourcePayload.exam
      : {};
  const sourceMetadata =
    sourcePayload.metadata && typeof sourcePayload.metadata === 'object'
      ? sourcePayload.metadata
      : {};

  let usedFallback = false;

  const normalizedExam = { ...sourceExam };
  if (!normalizedExam.title && (sourcePayload.title || exam?.title)) {
    normalizedExam.title = String(sourcePayload.title || exam?.title || '').trim();
    usedFallback = true;
  }
  if (!normalizedExam.description && (sourcePayload.description || exam?.description)) {
    normalizedExam.description = String(
      sourcePayload.description || exam?.description || ''
    ).trim();
    usedFallback = true;
  }
  if (!Number.isFinite(Number(normalizedExam.duration)) || Number(normalizedExam.duration) <= 0) {
    const fallbackDuration = toFiniteNumber(
      sourcePayload.duration,
      toFiniteNumber(exam?.duration, 0)
    );
    if (fallbackDuration > 0) {
      normalizedExam.duration = fallbackDuration;
      usedFallback = true;
    }
  }
  if (!Number.isFinite(Number(normalizedExam.gracePeriod))) {
    normalizedExam.gracePeriod = toFiniteNumber(sourcePayload.gracePeriod, toFiniteNumber(exam?.gracePeriod, 0));
  }
  if (!Number.isFinite(Number(normalizedExam.maxAttempts)) || Number(normalizedExam.maxAttempts) <= 0) {
    normalizedExam.maxAttempts = toFiniteNumber(
      sourcePayload.maxAttempts,
      toFiniteNumber(exam?.maxAttempts, 1)
    );
  }
  if (!Number.isFinite(Number(normalizedExam.passingPercentage))) {
    normalizedExam.passingPercentage = toFiniteNumber(
      exam?.passingPercentage,
      toFiniteNumber(sourcePayload.passingPercentage, 0)
    );
  }

  const normalizedMetadata = { ...sourceMetadata };
  if (!normalizedMetadata.questionPaperId && (resolvedQuestionPaperId || packageData?.questionPaperId)) {
    normalizedMetadata.questionPaperId = String(
      resolvedQuestionPaperId || packageData?.questionPaperId || ''
    ).trim();
    usedFallback = true;
  }
  if (!normalizedMetadata.tenantId && examTenantId) {
    normalizedMetadata.tenantId = examTenantId;
    usedFallback = true;
  }
  if (!normalizedMetadata.createdAt && packageData?.createdAt) {
    const createdAt = toValidDate(packageData.createdAt);
    if (createdAt) {
      normalizedMetadata.createdAt = createdAt.toISOString();
      usedFallback = true;
    }
  }
  if (!normalizedMetadata.expiresAt && packageData?.expiresAt) {
    const expiresAt = toValidDate(packageData.expiresAt);
    if (expiresAt) {
      normalizedMetadata.expiresAt = expiresAt.toISOString();
      usedFallback = true;
    }
  }
  const metadataQuestionCount = Number(normalizedMetadata.questionCount);
  if (!Number.isFinite(metadataQuestionCount) || metadataQuestionCount <= 0) {
    normalizedMetadata.questionCount = sourceQuestions.length;
    usedFallback = true;
  }

  let normalizedTiming =
    sourcePayload.timing && typeof sourcePayload.timing === 'object'
      ? sourcePayload.timing
      : null;
  if (!isValidPackageTiming(normalizedTiming)) {
    normalizedTiming = buildFallbackTiming({
      payload: sourcePayload,
      exam,
      packageData,
    });
    if (normalizedTiming) {
      usedFallback = true;
    }
  }

  return {
    payload: {
      ...sourcePayload,
      exam: normalizedExam,
      metadata: normalizedMetadata,
      timing: normalizedTiming,
      questions: sourceQuestions,
    },
    usedFallback,
  };
};

const resolveReadyPackage = async ({ examId, questionPaperId = null }) => {
  const baseQuery = {
    examId,
    isActive: true,
    expiresAt: { $gt: new Date() },
  };

  const findPackage = async (query) =>
    ExamPackage.findOne(query)
      .select('_id questionPaperId version size packageHash encryptedData expiresAt createdAt')
      .sort({ version: -1 });

  let pkg = null;
  if (questionPaperId) {
    pkg = await findPackage({ ...baseQuery, questionPaperId });
  }
  if (!pkg) {
    pkg = await findPackage(baseQuery);
  }

  if (
    !pkg?._id ||
    !pkg.packageHash ||
    !Number.isFinite(Number(pkg.size)) ||
    Number(pkg.size) <= 0
  ) {
    return null;
  }

  const encryptedDataLength = getBinaryLength(pkg.encryptedData);
  if (encryptedDataLength < MIN_ENCRYPTED_PACKAGE_LENGTH) {
    return null;
  }

  return pkg;
};

/**
 * Generate exam package
 * POST /exam-packages/:examId/generate
 * Requires: EXAM_CREATOR or TENANT_ADMIN role
 * questionPaperId is optional - if not provided, uses first active question paper
 * expiresAt is optional - defaults to 30 days from now
 */
router.post(
  '/:examId/generate',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  [
    body('questionPaperId').optional().notEmpty().withMessage('Question paper ID must not be empty if provided'),
    body('expiresAt').optional().isISO8601().withMessage('Expiry date must be a valid ISO 8601 date'),
  ],
  auditLog(AUDIT_ACTIONS.EXAM_PACKAGE_GENERATED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    const { examId } = req.params;
    const { questionPaperId, expiresAt } = req.body;

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[Package Generation] Validation errors for exam ${examId}:`, errors.array());
        return res.status(400).json({ errors: errors.array() });
      }

      console.log(
        `[Package Generation] Starting package generation for exam ${examId} by user ${req.user._id}`
      );

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        console.error(`[Package Generation] Exam ${examId} not found`);
        return res.status(404).json({ error: 'Exam not found' });
      }

      const examTenantId = normalizeTenantId(exam.tenantId);
      const userTenantId = normalizeTenantId(req.user?.tenantId);
      console.log(
        `[Package Generation] Exam found: ${exam.title} (Active: ${exam.isActive}, tenantId=${examTenantId || 'missing'}, userTenantId=${userTenantId || 'missing'})`
      );

      if (!examTenantId) {
        const tenantError = `Exam ${examId} is missing tenantId`;
        console.error(`[Package Generation] ${tenantError}`);
        await markPackageFailed(examId, tenantError);
        return res.status(422).json({
          error: 'Exam tenantId is missing. Please assign a tenant before generating packages.',
        });
      }

      // Check tenant boundary
      if (req.user.role !== 'SUPER_ADMIN' && examTenantId !== userTenantId) {
        console.error(`[Package Generation] Tenant mismatch for exam ${examId}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check permission (TENANT_ADMIN or EXAM_CREATOR)
      const canManagePackageRole = ['TENANT_ADMIN', 'EXAM_CREATOR'].includes(req.user.role);
      const hasCreatePermission = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION');
      const canCreate = canManagePackageRole && (req.user.role === 'TENANT_ADMIN' || hasCreatePermission);

      if (!canCreate) {
        console.error(`[Package Generation] Permission denied for user ${req.user._id} on exam ${examId}`);
        return res.status(403).json({ error: 'You do not have permission to generate exam packages' });
      }

      // Get question paper (if not provided, use first active one)
      const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
      let resolvedQuestionPaperId = questionPaperId;

      if (!resolvedQuestionPaperId) {
        console.log(`[Package Generation] No questionPaperId provided, finding first active question paper for exam ${examId}`);
        const questionPapers = await QuestionPaper.find({ examId, isActive: true });
        if (questionPapers.length === 0) {
          console.error(`[Package Generation] No active question papers found for exam ${examId}`);
          return res.status(400).json({ 
            error: 'No active question papers found for this exam. Please create a question paper first.' 
          });
        }
        resolvedQuestionPaperId = questionPapers[0]._id.toString();
        console.log(`[Package Generation] Using question paper: ${resolvedQuestionPaperId} (${questionPapers[0].setName})`);
      }

      // Validate question paper exists and belongs to exam
      const questionPaper = await QuestionPaper.findById(resolvedQuestionPaperId);
      if (!questionPaper) {
        console.error(`[Package Generation] Question paper ${resolvedQuestionPaperId} not found`);
        return res.status(404).json({ error: 'Question paper not found' });
      }

      if (questionPaper.examId.toString() !== examId) {
        console.error(`[Package Generation] Question paper ${resolvedQuestionPaperId} does not belong to exam ${examId}`);
        return res.status(400).json({ error: 'Question paper does not belong to this exam' });
      }

      // Validate questions exist
      const Question = (await import('../models/Question.js')).default;
      const Section = (await import('../models/Section.js')).default;
      
      // Get all sections (both active and inactive) for debugging
      const allSections = await Section.find({ questionPaperId: resolvedQuestionPaperId });
      const activeSections = await Section.find({ questionPaperId: resolvedQuestionPaperId, isActive: true });
      const questions = await Question.find({
        questionPaperId: resolvedQuestionPaperId,
        $or: [{ isActive: { $exists: false } }, { isActive: true }],
      });
      const minimumRequiredQuestions = 10;
      const recommendedQuestions = 10;

      console.log(`[Package Generation] Validation for question paper ${resolvedQuestionPaperId}:`);
      console.log(`  - Total sections: ${allSections.length} (Active: ${activeSections.length}, Inactive: ${allSections.length - activeSections.length})`);
      console.log(`  - Total questions: ${questions.length}`);
      console.log(`  - Tenant ID: ${examTenantId}`);

      // Validate that question volume is sufficient for package generation.
      if (questions.length < minimumRequiredQuestions) {
        console.error(
          `[Package Generation] Insufficient questions for question paper ${resolvedQuestionPaperId}: ${questions.length}/${minimumRequiredQuestions}`
        );
        await markPackageFailed(
          examId,
          `Insufficient questions for question paper ${resolvedQuestionPaperId}: ${questions.length}/${minimumRequiredQuestions}`
        );
        return res.status(400).json({ 
          error: `At least ${minimumRequiredQuestions} active questions are required. Current count: ${questions.length}.` 
        });
      }
      if (questions.length < recommendedQuestions) {
        console.warn(
          `[Package Generation] Low question count warning for question paper ${resolvedQuestionPaperId}: ${questions.length}/${recommendedQuestions}`
        );
      }

      // Check if this is a section-based exam (questions have sectionId)
      const questionsWithSections = questions.filter(q => q.sectionId);
      const questionsWithoutSections = questions.filter(q => !q.sectionId);
      
      console.log(`  - Questions with sections: ${questionsWithSections.length}`);
      console.log(`  - Questions without sections: ${questionsWithoutSections.length}`);

      // For section-based exams, validate sections exist
      // For non-section-based exams, questions can exist without sections
      if (questionsWithSections.length > 0 && activeSections.length === 0) {
        // Check if there are inactive sections
        if (allSections.length > 0) {
          console.error(`[Package Generation] Questions have sectionId but no ACTIVE sections found. Found ${allSections.length} inactive sections.`);
          await markPackageFailed(
            examId,
            `Question paper ${resolvedQuestionPaperId} has section-linked questions but no active sections`
          );
          return res.status(400).json({ 
            error: `This question paper has ${allSections.length} section(s), but none are active. Please activate sections or remove section assignments from questions.` 
          });
        } else {
          console.error(`[Package Generation] Questions have sectionId but no sections found at all for question paper ${resolvedQuestionPaperId}`);
          await markPackageFailed(
            examId,
            `Question paper ${resolvedQuestionPaperId} has section-linked questions but no sections`
          );
          return res.status(400).json({ 
            error: 'This question paper has questions assigned to sections, but no sections found. Please create sections or remove section assignments from questions.' 
          });
        }
      }

      // Log exam type
      if (activeSections.length > 0) {
        console.log(`[Package Generation] Section-based exam: ${activeSections.length} active sections, ${questions.length} questions`);
      } else if (questionsWithoutSections.length > 0) {
        console.log(`[Package Generation] Non-section-based exam: ${questions.length} questions (no sections required)`);
      } else {
        console.log(`[Package Generation] Mixed exam: ${questionsWithSections.length} questions with sections, ${questionsWithoutSections.length} without`);
      }

      // Set expiry date (default: 30 days from now)
      let expiryDate;
      if (expiresAt) {
        expiryDate = new Date(expiresAt);
        if (expiryDate <= new Date()) {
          console.error(`[Package Generation] Invalid expiry date: ${expiresAt}`);
          return res.status(400).json({ error: 'Expiry date must be in the future' });
        }
      } else {
        expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);
        console.log(`[Package Generation] Using default expiry: ${expiryDate.toISOString()}`);
      }

      console.log(`[Package Generation] Generating package for exam ${examId}, question paper ${resolvedQuestionPaperId}, expires ${expiryDate.toISOString()}`);

      // Generate package
      const packageInfo = await generateExamPackage(
        examId,
        resolvedQuestionPaperId,
        req.user._id,
        expiryDate
      );

      console.log(`[Package Generation] Package generated successfully: ID ${packageInfo.packageId}, Version ${packageInfo.version}, Size ${packageInfo.size} bytes`);

      res.status(201).json({
        message: 'Exam package generated successfully',
        package: packageInfo,
      });
    } catch (error) {
      console.error(`[Package Generation] Error generating package for exam ${examId}:`, error);
      console.error(`[Package Generation] Error stack:`, error.stack);
      await Exam.updateOne(
        { _id: examId },
        {
          $set: {
            packageStatus: PACKAGE_STATUS.FAILED,
            packageLastError: String(error?.message || 'Package generation failed').slice(0, 500),
            latestPackageUrl: '',
          },
        }
      ).catch(() => {});
      // Don't fail silently - return error to client
      return res.status(500).json({ 
        error: 'Failed to generate exam package',
        message: error.message || 'Unknown error occurred',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

/**
 * Get exam package status
 * GET /exam-packages/:examId/package-status
 * Returns: { status: "PENDING" | "PROCESSING" | "READY" | "FAILED" }
 */
router.get(
  '/:examId/package-status',
  requireAuth,
  requireTenant,
  requireRole('CANDIDATE', 'EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const { examId } = req.params;
      const questionPaperId = normalizeOptionalObjectId(req.query?.questionPaperId);

      const exam = await Exam.findById(examId).select(
        '_id tenantId isActive packageStatus packageGeneratedAt packageVersion packageLastError'
      );
      if (!exam) {
        return res.status(404).json({
          status: PACKAGE_STATUS.FAILED,
          error: 'Exam not found',
        });
      }
      const examTenantId = normalizeTenantId(exam.tenantId);
      const userTenantId = normalizeTenantId(req.user?.tenantId);
      if (!examTenantId) {
        await markPackageFailed(examId, 'Exam tenantId is missing. Package status cannot be resolved.');
        return res.status(422).json({
          status: PACKAGE_STATUS.FAILED,
          error: 'Exam tenantId is missing. Please assign tenant and regenerate package.',
        });
      }

      const isPackageManagerRole = ['EXAM_CREATOR', 'TENANT_ADMIN'].includes(req.user.role);
      if (isPackageManagerRole) {
        if (
          req.user.role !== 'SUPER_ADMIN' &&
          examTenantId !== userTenantId
        ) {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else {
        const canAttempt = await hasExamPermission(req.user._id, examId, 'ATTEMPT_EXAM');
        if (!canAttempt) {
          return res.status(403).json({
            error: 'You do not have permission to access this exam package',
          });
        }
      }

      const storedStatus = normalizePackageStatus(exam.packageStatus);
      const readyPackage = await resolveReadyPackage({
        examId,
        questionPaperId,
      });
      const regenerationInFlight = isExamPackageRegenerationInFlight(examId);

      let status = PACKAGE_STATUS.PENDING;
      if (storedStatus === PACKAGE_STATUS.FAILED) {
        status = PACKAGE_STATUS.FAILED;
      } else if (readyPackage) {
        status = PACKAGE_STATUS.READY;
      } else if (
        storedStatus === PACKAGE_STATUS.PROCESSING ||
        regenerationInFlight
      ) {
        status = PACKAGE_STATUS.PROCESSING;
      }

      if (
        status === PACKAGE_STATUS.READY &&
        storedStatus !== PACKAGE_STATUS.READY
      ) {
        const generatedAt = readyPackage?.createdAt ? new Date(readyPackage.createdAt) : new Date();
        await Exam.updateOne(
          { _id: examId },
          {
            $set: {
              packageStatus: PACKAGE_STATUS.READY,
              packageGeneratedAt: generatedAt,
              packageLastGeneratedAt: generatedAt,
              packageVersion: Number(readyPackage?.version || exam.packageVersion || 0),
              latestPackageUrl: `/api/exam-packages/${examId}/download`,
              packageLastError: '',
            },
          }
        );
      } else if (
        status === PACKAGE_STATUS.PENDING &&
        storedStatus === PACKAGE_STATUS.READY
      ) {
        await Exam.updateOne(
          { _id: examId },
          {
            $set: {
              packageStatus: PACKAGE_STATUS.PENDING,
              latestPackageUrl: '',
            },
          }
        );
      } else if (
        status === PACKAGE_STATUS.PROCESSING &&
        storedStatus !== PACKAGE_STATUS.PROCESSING &&
        storedStatus !== PACKAGE_STATUS.FAILED
      ) {
        await Exam.updateOne(
          { _id: examId },
          {
            $set: {
              packageStatus: PACKAGE_STATUS.PROCESSING,
              packageLastError: '',
              latestPackageUrl: `/api/exam-packages/${examId}/download`,
            },
          }
        );
      }

      const resolvedQuestionPaperId =
        normalizeOptionalObjectId(questionPaperId) ||
        normalizeOptionalObjectId(readyPackage?.questionPaperId?.toString() || null);

      return res.json({
        status,
        packageReady: status === PACKAGE_STATUS.READY,
        downloadUrl:
          status === PACKAGE_STATUS.READY
            ? `/api/exam-packages/${examId}/download${
                resolvedQuestionPaperId ? `?questionPaperId=${resolvedQuestionPaperId}` : ''
              }`
            : null,
        package: status === PACKAGE_STATUS.READY && readyPackage
          ? {
              packageId: readyPackage._id.toString(),
              questionPaperId: resolvedQuestionPaperId,
              version: readyPackage.version,
              size: readyPackage.size,
              expiresAt: readyPackage.expiresAt,
              createdAt: readyPackage.createdAt,
            }
          : null,
        message:
          status === PACKAGE_STATUS.FAILED
            ? String(exam.packageLastError || 'Exam package generation failed')
            : status === PACKAGE_STATUS.PROCESSING
              ? 'Exam package is being generated'
            : status === PACKAGE_STATUS.PENDING
              ? 'Exam package is being prepared'
            : 'Exam package is ready',
      });
    } catch (error) {
      console.error(
        `[Package Status] Failed to resolve status for exam ${req.params.examId}:`,
        error
      );
      if (res.headersSent) {
        return next(error);
      }
      return res.status(503).json({
        status: PACKAGE_STATUS.PENDING,
        packageReady: false,
        downloadUrl: null,
        package: null,
        error: 'Unable to fetch package status right now. Please retry.',
      });
    }
  }
);

/**
 * Get package info (metadata only)
 * GET /exam-packages/:examId/info
 * Requires: CANDIDATE role with ATTEMPT_EXAM permission
 */
router.get(
  '/:examId/info',
  requireAuth,
  requireTenant,
  requireRole('CANDIDATE'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const { examId } = req.params;
      const questionPaperId = normalizeOptionalObjectId(req.query?.questionPaperId);

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Check permission
      const canAttempt = await hasExamPermission(req.user._id, examId, 'ATTEMPT_EXAM');
      if (!canAttempt) {
        return res.status(403).json({ error: 'You do not have permission to access this exam package' });
      }

      // Check if user is admin (for canGenerate flag)
      const isAdmin = req.user.role === 'EXAM_CREATOR' || req.user.role === 'TENANT_ADMIN';
      const canGenerate = isAdmin && (
        await hasExamPermission(req.user._id, examId, 'CREATE_SESSION') ||
        req.user.role === 'TENANT_ADMIN'
      );

      // Check if question papers exist (for status info)
      const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
      const questionPapers = await QuestionPaper.find({ examId, isActive: true });
      const hasQuestionPapers = questionPapers.length > 0;

      // If questionPaperId provided, verify it exists
      if (questionPaperId) {
        const questionPaper = await QuestionPaper.findById(questionPaperId);
        if (!questionPaper) {
          return res.status(404).json({ error: 'Question paper not found' });
        }
      }

      // Get package info (questionPaperId is optional - if not provided, returns latest package for exam)
      const packageInfo = await getPackageInfo(examId, questionPaperId || null);

      if (!packageInfo) {
        return res.status(404).json({ 
          error: 'Exam package not found. The exam package has not been generated yet. Please contact the exam administrator.',
          examStatus: {
            isActive: exam.isActive,
            hasQuestionPapers,
          },
          canGenerate: canGenerate || undefined, // Only include if user is admin
        });
      }

      // Include exam status in response
      const response = {
        package: packageInfo,
        examStatus: {
          isActive: exam.isActive,
          hasQuestionPapers,
        }
      };

      // Add canGenerate flag for admins
      if (canGenerate) {
        response.canGenerate = true;
      }

      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Download exam package
 * GET /exam-packages/:examId/download
 * Requires: CANDIDATE role with ATTEMPT_EXAM permission
 */
router.get(
  '/:examId/download',
  requireAuth,
  requireTenant,
  requireRole('CANDIDATE', 'EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  async (req, res, next) => {
    const requestStartedAt = Date.now();
    try {
      const { examId } = req.params;
      const questionPaperId = normalizeOptionalObjectId(req.query?.questionPaperId);
      const { version } = req.query;
      console.log(
        `[Package Download] request-start exam=${examId} qp=${questionPaperId || 'latest'} at=${new Date(
          requestStartedAt
        ).toISOString()}`
      );

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }
      const examTenantId = normalizeTenantId(exam.tenantId);
      const userTenantId = normalizeTenantId(req.user?.tenantId);
      if (!examTenantId) {
        await markPackageFailed(examId, 'Exam tenantId is missing. Package download unavailable.');
        return res.status(422).json({
          status: PACKAGE_STATUS.FAILED,
          error: 'Exam tenantId is missing. Please regenerate after fixing exam tenant mapping.',
        });
      }

      const isPackageManagerRole = ['EXAM_CREATOR', 'TENANT_ADMIN'].includes(req.user.role);
      if (isPackageManagerRole) {
        if (req.user.role !== 'SUPER_ADMIN' && examTenantId !== userTenantId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else {
        // Check candidate permission
        const canAttempt = await hasExamPermission(req.user._id, examId, 'ATTEMPT_EXAM');
        if (!canAttempt) {
          return res.status(403).json({ error: 'You do not have permission to download this exam package' });
        }

        // Candidate pre-download is allowed only for active exams
        if (!exam.isActive) {
          return res.status(403).json({ 
            error: 'Exam is not active. Packages can only be downloaded for active exams.' 
          });
        }
      }

      const packageStatus = normalizePackageStatus(exam.packageStatus);
      const readyPackage = await resolveReadyPackage({
        examId,
        questionPaperId: questionPaperId || null,
      });
      if (packageStatus === PACKAGE_STATUS.FAILED && !readyPackage) {
        return res.status(409).json({
          status: PACKAGE_STATUS.FAILED,
          error: String(
            exam.packageLastError ||
              'Exam package generation failed. Please contact the exam administrator.'
          ),
        });
      }
      if (packageStatus === PACKAGE_STATUS.FAILED && readyPackage) {
        console.warn(
          `[Package Download] Recovering from FAILED status using active package exam=${examId} qp=${questionPaperId || readyPackage.questionPaperId || 'latest'}`
        );
      }

      if (!readyPackage) {
        const effectiveStatus =
          packageStatus === PACKAGE_STATUS.PROCESSING ||
          isExamPackageRegenerationInFlight(examId)
            ? PACKAGE_STATUS.PROCESSING
            : PACKAGE_STATUS.PENDING;
        await Exam.updateOne(
          { _id: examId },
          {
            $set: {
              packageStatus: effectiveStatus,
              latestPackageUrl: '',
            },
          }
        );
        return res.status(202).json({
          status: effectiveStatus,
          error:
            effectiveStatus === PACKAGE_STATUS.PROCESSING
              ? 'Exam package is being generated. Please try again shortly.'
              : 'Exam package is being prepared. Please try again shortly.',
        });
      }

      if (packageStatus !== PACKAGE_STATUS.READY) {
        const generatedAt = readyPackage.createdAt
          ? new Date(readyPackage.createdAt)
          : new Date();
        await Exam.updateOne(
          { _id: examId },
          {
            $set: {
              packageStatus: PACKAGE_STATUS.READY,
              packageGeneratedAt: generatedAt,
              packageLastGeneratedAt: generatedAt,
              packageVersion: Number(readyPackage.version || exam.packageVersion || 0),
              latestPackageUrl: `/api/exam-packages/${examId}/download`,
              packageLastError: '',
            },
          }
        );
      }

      const resolvedQuestionPaperId =
        normalizeOptionalObjectId(questionPaperId) ||
        normalizeOptionalObjectId(readyPackage.questionPaperId?.toString() || null);

      // Get package
      const packageVersion = version ? parseInt(version, 10) : null;
      const packageData = await getExamPackage(
        examId,
        resolvedQuestionPaperId || null,
        packageVersion
      );

      // Convert Buffer to base64 for JSON response.
      // Keep backward-compatible `encryptedData` (iv + tag + ciphertext),
      // and also expose iv/tag/cipherText explicitly for client-side debugging/fallback.
      const encryptedBuffer = toSafeEncryptedBuffer(
        packageData.encryptedData,
        `Package Download exam=${examId} qp=${resolvedQuestionPaperId || 'latest'}`
      );
      if (!encryptedBuffer || encryptedBuffer.length < MIN_ENCRYPTED_PACKAGE_LENGTH) {
        await markPackageFailed(examId, 'Corrupted package payload. Encrypted data length is invalid.');
        return res.status(500).json({
          error: 'Corrupted package payload. Please regenerate the exam package.',
        });
      }
      if (
        Number.isFinite(Number(packageData.size)) &&
        Number(packageData.size) > 0 &&
        encryptedBuffer.length !== Number(packageData.size)
      ) {
        await markPackageFailed(
          examId,
          `Package size mismatch. Expected ${packageData.size}, got ${encryptedBuffer.length}.`
        );
        return res.status(500).json({
          error: 'Corrupted package payload. Please regenerate the exam package.',
        });
      }
      if (!validatePackageHash(encryptedBuffer, packageData.hash)) {
        await markPackageFailed(examId, 'Package hash mismatch detected during download.');
        return res.status(500).json({
          error: 'Corrupted package payload. Please regenerate the exam package.',
        });
      }

      let ivBuffer;
      let authTagBuffer;
      let cipherTextBuffer;
      try {
        ({ ivBuffer, authTagBuffer, cipherTextBuffer } = splitEncryptedBuffer(
          encryptedBuffer,
          `Package Download exam=${examId} qp=${resolvedQuestionPaperId || 'latest'}`
        ));
      } catch (splitError) {
        await markPackageFailed(
          examId,
          `Corrupted package payload offsets for exam ${examId}: ${splitError?.message || splitError}`
        );
        return res.status(500).json({
          error: 'Corrupted package payload. Please regenerate the exam package.',
        });
      }

      let decryptedPayload;
      try {
        decryptedPayload = await decryptPackage(
          encryptedBuffer,
          examId,
          packageData.packageId,
          Number(packageData.version || 0)
        );
      } catch (decryptError) {
        await markPackageFailed(
          examId,
          `Package decrypt validation failed during download: ${decryptError?.message || decryptError}`
        );
        return res.status(500).json({
          error: 'Corrupted package payload. Please regenerate the exam package.',
        });
      }

      const normalizedPayloadResult = normalizeDecryptedPayloadForDownload({
        payload: decryptedPayload,
        exam,
        examTenantId,
        packageData,
        resolvedQuestionPaperId,
      });
      const normalizedPayload = normalizedPayloadResult.payload;
      const payloadQuestions = Array.isArray(normalizedPayload?.questions)
        ? normalizedPayload.questions
        : [];
      const payloadMetadata =
        normalizedPayload?.metadata && typeof normalizedPayload.metadata === 'object'
          ? normalizedPayload.metadata
          : null;
      const payloadTiming =
        normalizedPayload?.timing && typeof normalizedPayload.timing === 'object'
          ? normalizedPayload.timing
          : null;
      const payloadQuestionCount = payloadQuestions.length;
      if (normalizedPayloadResult.usedFallback) {
        console.warn(
          `[Package Download] Legacy payload normalization applied exam=${examId} qp=${resolvedQuestionPaperId || 'latest'} count=${payloadQuestionCount}`
        );
      }

      if (
        !normalizedPayload?.exam ||
        !payloadMetadata ||
        payloadQuestions.length === 0 ||
        !payloadTiming
      ) {
        await markPackageFailed(
          examId,
          'Package structure validation failed. Missing exam/metadata/questions/timing.'
        );
        return res.status(400).json({
          error:
            'Invalid exam package structure. Please regenerate the exam package and retry.',
        });
      }
      if (payloadQuestionCount < MIN_QUESTIONS_PER_DOWNLOAD) {
        await markPackageFailed(
          examId,
          `Package contains only ${payloadQuestionCount} question(s). Minimum ${MIN_QUESTIONS_PER_DOWNLOAD} required.`
        );
        return res.status(400).json({
          error: `Exam package has insufficient questions (${payloadQuestionCount}). Please regenerate with at least ${MIN_QUESTIONS_PER_DOWNLOAD} questions.`,
        });
      }
      if (payloadQuestionCount < RECOMMENDED_QUESTIONS_PER_DOWNLOAD) {
        console.warn(
          `[Package Download] Low question count warning exam=${examId} qp=${resolvedQuestionPaperId || 'latest'} count=${payloadQuestionCount}`
        );
      }

      const payloadQuestionPaperId = normalizeOptionalObjectId(
        payloadMetadata?.questionPaperId?.toString() || null
      );
      if (
        resolvedQuestionPaperId &&
        payloadQuestionPaperId &&
        resolvedQuestionPaperId !== payloadQuestionPaperId
      ) {
        await markPackageFailed(
          examId,
          `Question paper mismatch. Requested ${resolvedQuestionPaperId}, payload has ${payloadQuestionPaperId}.`
        );
        return res.status(500).json({
          error: 'Corrupted package payload. Please regenerate the exam package.',
        });
      }
      if (!isValidPackageTiming(payloadTiming)) {
        await markPackageFailed(
          examId,
          'Package timing payload is missing/invalid duration/startTime/endTime.'
        );
        return res.status(400).json({
          error:
            'Invalid exam package timing data. Please regenerate the exam package and retry.',
        });
      }

      const encryptedDataBase64 = encryptedBuffer.toString('base64');
      const ivBase64 = ivBuffer.toString('base64');
      const authTagBase64 = authTagBuffer.toString('base64');
      const cipherTextBase64 = cipherTextBuffer.toString('base64');
      const requestDurationMs = Date.now() - requestStartedAt;
      const serveAsBinary = prefersBinaryPackageResponse(req);

      console.log(
        `[Package Download] exam=${examId} qp=${resolvedQuestionPaperId || 'latest'} ` +
          `encryptedLen=${encryptedBuffer.length} cipherLen=${cipherTextBuffer.length} ` +
          `questionCount=${payloadQuestionCount} mode=${serveAsBinary ? 'binary' : 'json'} ` +
          `duration=${requestDurationMs}ms`
      );

      if (serveAsBinary) {
        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(encryptedBuffer.length));
        res.setHeader('Content-Encoding', 'identity');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Package-Format', 'binary');
        res.setHeader('X-Package-Id', packageData.packageId);
        res.setHeader('X-Package-Version', String(packageData.version));
        res.setHeader('X-Package-Hash', packageData.hash);
        res.setHeader('X-Package-Checksum', packageData.hash);
        res.setHeader('X-Package-Size', String(packageData.size));
        res.setHeader('X-Package-Question-Count', String(payloadQuestionCount));
        res.setHeader('X-Package-Expires-At', new Date(packageData.expiresAt).toISOString());
        res.setHeader('X-Package-Created-At', new Date(packageData.createdAt).toISOString());
        if (packageData.questionPaperId || resolvedQuestionPaperId) {
          res.setHeader(
            'X-Package-Question-Paper-Id',
            String(packageData.questionPaperId || resolvedQuestionPaperId)
          );
        }

        res.on('finish', () => {
          const elapsedMs = Date.now() - requestStartedAt;
          console.log(
            `[Package Download] sent binary exam=${examId} qp=${resolvedQuestionPaperId || 'latest'} ` +
              `bytes=${encryptedBuffer.length} duration=${elapsedMs}ms`
          );
        });

        res.send(encryptedBuffer);
        return;
      }

      res.setHeader('X-Package-Format', 'json');
      res.setHeader('X-Package-Encrypted-Size', String(encryptedBuffer.length));
      res.json({
        package: {
          packageId: packageData.packageId,
          examId: packageData.examId,
          questionPaperId: packageData.questionPaperId || resolvedQuestionPaperId,
          version: packageData.version,
          encryptedData: encryptedDataBase64,
          iv: ivBase64,
          authTag: authTagBase64,
          cipherText: cipherTextBase64,
          hash: packageData.hash,
          size: packageData.size,
          expiresAt: packageData.expiresAt,
          createdAt: packageData.createdAt,
          checksum: packageData.hash,
          metadata: {
            questionCount: payloadQuestionCount,
            packageFormat: 'json',
          },
        },
      });
    } catch (error) {
      console.error(`[Package Download] Unhandled error for exam ${req.params.examId}:`, error);
      if (res.headersSent) {
        return next(error);
      }
      return res.status(500).json({
        status: PACKAGE_STATUS.FAILED,
        error: 'Failed to download exam package',
        message: error?.message || 'Unknown package download error',
      });
    }
  }
);

/**
 * Regenerate exam package
 * POST /exam-packages/:examId/regenerate
 * Requires: EXAM_CREATOR or TENANT_ADMIN role
 */
router.post(
  '/:examId/regenerate',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  [
    body('questionPaperId').notEmpty().withMessage('Question paper ID is required'),
    body('expiresAt').optional().isISO8601().withMessage('Expiry date must be a valid ISO 8601 date'),
  ],
  auditLog(AUDIT_ACTIONS.EXAM_PACKAGE_GENERATED, (req) => ({
    resourceType: 'Exam',
    resourceId: req.params.examId,
  })),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { examId } = req.params;
      const { questionPaperId, expiresAt } = req.body;

      // Verify exam exists and user has permission
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }
      const examTenantId = normalizeTenantId(exam.tenantId);
      const userTenantId = normalizeTenantId(req.user?.tenantId);
      if (!examTenantId) {
        await markPackageFailed(examId, 'Exam tenantId is missing. Package regeneration unavailable.');
        return res.status(422).json({
          error: 'Exam tenantId is missing. Please assign tenant before regenerating package.',
        });
      }

      // Check tenant boundary
      if (req.user.role !== 'SUPER_ADMIN' && examTenantId !== userTenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check permission (TENANT_ADMIN or EXAM_CREATOR)
      const canManagePackageRole = ['TENANT_ADMIN', 'EXAM_CREATOR'].includes(req.user.role);
      const hasCreatePermission = await hasExamPermission(req.user._id, examId, 'CREATE_SESSION');
      const canCreate = canManagePackageRole && (req.user.role === 'TENANT_ADMIN' || hasCreatePermission);

      if (!canCreate) {
        return res.status(403).json({ error: 'You do not have permission to regenerate exam packages' });
      }

      // Set expiry date (default: 30 days from now)
      let expiryDate;
      if (expiresAt) {
        expiryDate = new Date(expiresAt);
        if (expiryDate <= new Date()) {
          return res.status(400).json({ error: 'Expiry date must be in the future' });
        }
      } else {
        expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);
      }

      // Deactivate old packages for this exam/question paper
      await ExamPackage.updateMany(
        {
          examId,
          questionPaperId,
          isActive: true,
        },
        {
          isActive: false,
        }
      );

      // Generate new package
      const packageInfo = await generateExamPackage(
        examId,
        questionPaperId,
        req.user._id,
        expiryDate
      );

      res.status(201).json({
        message: 'Exam package regenerated successfully',
        package: packageInfo,
      });
    } catch (error) {
      await Exam.updateOne(
        { _id: req.params.examId },
        {
          $set: {
            packageStatus: PACKAGE_STATUS.FAILED,
            packageLastError: String(error?.message || 'Package regeneration failed').slice(0, 500),
            latestPackageUrl: '',
          },
        }
      ).catch(() => {});
      next(error);
    }
  }
);

/**
 * List all packages for an exam (admin only)
 * GET /exam-packages/:examId/list
 * Requires: EXAM_CREATOR or TENANT_ADMIN role
 */
router.get(
  '/:examId/list',
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  validateObjectId('examId'),
  async (req, res, next) => {
    try {
      const { examId } = req.params;

      // Verify exam exists
      const exam = await Exam.findById(examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }
      const examTenantId = normalizeTenantId(exam.tenantId);
      const userTenantId = normalizeTenantId(req.user?.tenantId);
      if (!examTenantId) {
        return res.status(422).json({
          error: 'Exam tenantId is missing. Package list unavailable until tenant is assigned.',
        });
      }

      // Check tenant boundary (SUPER_ADMIN can access all exams)
      if (req.user.role !== 'SUPER_ADMIN' && examTenantId !== userTenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get all packages for this exam
      const packages = await ExamPackage.find({
        examId,
      })
        .populate('questionPaperId', 'setName')
        .populate('createdBy', 'name email')
        .sort({ version: -1 })
        .lean();

      res.json({
        packages: packages.map(pkg => ({
          packageId: pkg._id.toString(),
          examId: pkg.examId.toString(),
          questionPaperId: pkg.questionPaperId?._id?.toString(),
          questionPaperSetName: pkg.questionPaperId?.setName,
          version: pkg.version,
          size: pkg.size,
          hash: pkg.packageHash,
          expiresAt: pkg.expiresAt,
          isActive: pkg.isActive,
          isExpired: pkg.expiresAt < new Date(),
          createdAt: pkg.createdAt,
          createdBy: pkg.createdBy ? {
            name: pkg.createdBy.name,
            email: pkg.createdBy.email,
          } : null,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
