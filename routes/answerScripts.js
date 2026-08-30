import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamParticipant from '../models/ExamParticipant.js';
import QuestionPaper from '../models/QuestionPaper.js';
import AnswerScript from '../models/AnswerScript.js';
import AnswerScriptPage from '../models/AnswerScriptPage.js';
import AnswerSegment from '../models/AnswerSegment.js';
import Question from '../models/Question.js';
import {
  putPrivateObject,
  getPrivateSignedUrl,
  buildPrivateObjectLocation,
  getPrivateUploadUrl,
  createPrivateMultipartUpload,
  getPrivateMultipartPartUrl,
  completePrivateMultipartUpload,
  abortPrivateMultipartUpload,
  headPrivateObject,
} from '../services/storage/imageStorage.js';
import { materializeFromScript, finalizeAnswerScript } from '../services/offlineEvaluation/attemptMaterializationService.js';
import { deleteAnswerScript } from '../services/offlineEvaluation/answerScriptDeleteService.js';
import { buildProcessingStatusPayload } from '../services/offlineEvaluation/answerScriptProcessingStatus.js';
import { loadFinalizeReadiness } from '../services/offlineEvaluation/answerScriptFinalizeReadiness.js';
import { routeAndEvaluate } from '../services/offlineEvaluation/evaluationRouterService.js';
import { suggestCandidates } from '../services/offlineEvaluation/candidateMappingService.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import offlineEvaluationConfig from '../config/offlineEvaluationConfig.js';
import { canOperateExam, canMonitorTenantOperations } from '../services/academicAccessService.js';
import { hasActiveExaminerAssignment, requireEvaluatorAccess } from '../middleware/examPermissions.js';
import { Enrollment, CourseOffering } from '../models/academic/index.js';
import { hasAnyRole, hasRole } from '../utils/userRoles.js';
import { isExamResultsReleased } from '../utils/resultVisibility.js';
import AnswerScriptBatch from '../models/AnswerScriptBatch.js';
import { refreshAnswerScriptBatchCounters } from '../services/offlineEvaluation/answerScriptBatchService.js';
import { ANSWER_SCRIPT_JOB, enqueueAnswerScriptStage } from '../services/offlineEvaluation/answerScriptQueueService.js';
import {
  createAnswerScriptMappingToken,
  resolveAnswerScriptMappingToken,
} from '../services/offlineEvaluation/machineReadableMappingService.js';
import {
  listOfflineIntakeAssessments,
  assertCandidateOnAssessmentRoster,
} from '../services/offlineEvaluation/offlineIntakeEligibilityService.js';

// Master Phase 4 — offline answer-script upload/status/mapping/finalize.
// Evaluation itself and result materialization live in
// services/offlineEvaluation/*; this file is upload security + orchestration
// triggers + read endpoints only, per Part G's "do not scatter OCR calls
// through routes" (the same principle applies to evaluation logic).

const router = express.Router();
const staff = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR')];
const intake = [requireAuth, requireTenant, enforceTenantBoundaries, requireRole('ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR')];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: offlineEvaluationConfig.MAX_ANSWER_SCRIPT_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (offlineEvaluationConfig.ALLOWED_ANSWER_SCRIPT_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Invalid file type "${file.mimetype}". Allowed: PDF, JPEG, PNG.`));
  },
});

const handleMulterError = (err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File too large. Maximum size is ${Math.round(offlineEvaluationConfig.MAX_ANSWER_SCRIPT_SIZE_BYTES / (1024 * 1024))}MB.` });
    return res.status(400).json({ error: err.message });
  }
  return res.status(400).json({ error: err.message || 'Upload failed.' });
};

const batchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: offlineEvaluationConfig.MAX_ANSWER_SCRIPT_SIZE_BYTES, files: offlineEvaluationConfig.MAX_FILES_PER_BATCH },
  fileFilter: (req, file, cb) => {
    if (offlineEvaluationConfig.ALLOWED_ANSWER_SCRIPT_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Invalid file type "${file.mimetype}". Allowed: PDF, JPEG, PNG.`));
  },
});

const createScriptFromUpload = async ({
  req, exam, questionPaperId, machineMapping, mappingSymbology, batchId = null,
}) => {
  const tenantId = req.user.tenantId;
  const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const duplicate = await AnswerScript.findOne({ tenantId, examId: exam._id, 'sourceFile.checksum': checksum }).select('_id status createdAt').lean();
  if (duplicate && req.query.override !== 'true') {
    return { error: { status: 409, code: 'DUPLICATE_UPLOAD', existingAnswerScriptId: duplicate._id, fileName: req.file.originalname } };
  }
  const ext = path.extname(req.file.originalname || '').toLowerCase() || (req.file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
  const stored = await putPrivateObject({
    tenantId, category: 'answer-scripts', subpath: ['originals'],
    fileStem: sanitizeFileName(path.basename(req.file.originalname || 'script', ext)),
    extension: ext, buffer: req.file.buffer, contentType: req.file.mimetype,
  });
  const script = await AnswerScript.create({
    tenantId, examId: exam._id, questionPaperId,
    batchId,
    courseOfferingId: exam.academicContext?.courseOfferingId || null,
    examSessionId: machineMapping?.sessionId || null,
    mappingTokenId: machineMapping?._id || null,
    candidateId: machineMapping?.candidateId || null,
    enrollmentId: machineMapping?.enrollmentId || null,
    mappingMethod: machineMapping ? (String(mappingSymbology || '').toUpperCase() === 'BARCODE' ? 'BARCODE' : 'QR') : null,
    mappingConfidence: machineMapping ? 1 : null,
    sourceFile: { key: stored.key, checksum, sizeBytes: req.file.size, url: '' },
    originalObject: {
      key: stored.key, checksum, sizeBytes: req.file.size, mimeType: req.file.mimetype,
      uploadedAt: new Date(), storageClass: 'STANDARD',
    },
    originalFileName: req.file.originalname,
    mimeType: req.file.mimetype,
    status: 'QUEUED',
    retention: { policyKey: offlineEvaluationConfig.RETENTION_POLICY_KEY, lifecycleState: 'HOT' },
    createdBy: req.user._id,
  });
  await logAuditEvent(AUDIT_ACTIONS.OFFLINE_SCRIPT_UPLOADED, {
    userId: req.user._id, userEmail: req.user.email, userRole: req.user.role, tenantId,
    resourceType: 'AnswerScript', resourceId: script._id, examId: exam._id, fileName: req.file.originalname, sizeBytes: req.file.size,
  });
  const queued = await enqueueAnswerScriptStage({
    stage: ANSWER_SCRIPT_JOB.NORMALIZE,
    answerScriptId: script._id,
    tenantId,
    uploaderId: req.user._id,
    batchId,
  });
  script.processingMeta.activeJobId = queued.jobId;
  script.processingMeta.stage = 'QUEUED';
  await script.save();
  return { script };
};

const sanitizeFileName = (name) => String(name || 'script').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);


const resolveCandidateEnrollment = async ({ tenantId, candidateId, examId, courseOfferingId }) => {
  if (!candidateId) return { candidateId: null, enrollmentId: null };
  const User = (await import('../models/User.js')).default;
  const [candidate, participant] = await Promise.all([
    User.findOne({
      _id: candidateId,
      tenantId,
      status: 'ACTIVE',
      $or: [{ role: 'CANDIDATE' }, { roles: 'CANDIDATE' }],
    }).select('_id').lean(),
    ExamParticipant.findOne({ examId, userId: candidateId, examRole: 'CANDIDATE' }).select('_id').lean(),
  ]);
  if (!candidate || !participant) {
    throw Object.assign(new Error('Candidate is not assigned to this assessment.'), { statusCode: 403 });
  }
  if (!courseOfferingId) return { candidateId: candidate._id, enrollmentId: null };
  const offering = await CourseOffering.findOne({ _id: courseOfferingId, tenantId }).lean();
  if (!offering) throw Object.assign(new Error('The assessment course offering is unavailable.'), { statusCode: 409 });
  const enrollment = await Enrollment.findOne({
    tenantId,
    userId: candidate._id,
    academicSessionId: offering.academicSessionId,
    programId: offering.programId,
    status: 'ACTIVE',
    ...(offering.cohortId ? { cohortId: offering.cohortId } : {}),
    ...(offering.academicSectionId ? { academicSectionId: offering.academicSectionId } : {}),
  }).select('_id').lean();
  if (!enrollment) {
    throw Object.assign(new Error('Candidate is not enrolled in this assessment class/course offering.'), { statusCode: 403 });
  }
  return { candidateId: candidate._id, enrollmentId: enrollment._id };
};

// Verifies the exam (and its question paper) belong to this tenant and
// actually accept offline scripts — the same tenant-ownership check
// pattern used throughout the app, kept local since this route's
// requirements (deliveryMode check) are specific to it.
const loadOwnedExamForOfflineUpload = async ({ tenantId, examId, questionPaperId }) => {
  const exam = await Exam.findOne({ _id: examId, tenantId }).select('_id tenantId createdBy academicContext deliveryMode examType').lean();
  if (!exam) return { error: { status: 404, message: 'Exam not found in this tenant.' } };
  if (exam.deliveryMode === 'ONLINE') return { error: { status: 400, message: 'This exam is configured for online delivery only — enable OFFLINE or HYBRID delivery mode before uploading answer scripts.' } };
  const paper = await QuestionPaper.findOne({ _id: questionPaperId, examId }).select('_id').lean();
  if (!paper) return { error: { status: 404, message: 'Question paper not found for this exam.' } };
  return { exam, paper };
};

const loadAuthorizedScript = async (req, { allowTenantMonitor = false } = {}) => {
  const script = await AnswerScript.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
  if (!script) throw Object.assign(new Error('Answer script not found.'), { statusCode: 404 });
  const exam = await Exam.findOne({ _id: script.examId, tenantId: req.user.tenantId })
    .select('_id tenantId createdBy academicContext deliveryMode examType')
    .lean();
  if (!exam) throw Object.assign(new Error('Exam not found in this tenant.'), { statusCode: 404 });
  if (allowTenantMonitor && canMonitorTenantOperations(req.user)) return { script, exam, monitorOnly: true };
  if (!await canOperateExam(req.user, exam)) {
    throw Object.assign(new Error('This answer script is outside your assigned academic or assessment scope.'), { statusCode: 403 });
  }
  return { script, exam, monitorOnly: false };
};

// Creates one opaque bearer token that can be rendered as either QR or Code
// 128 on a printed paper. Only opaque ids are linked server-side; the symbol
// itself contains no name, email, phone, roll number, or other direct PII.
router.get('/intake-eligibility', ...staff, async (req, res, next) => {
  try {
    const monitorOnly = hasRole(req.user, 'TENANT_ADMIN') && !hasAnyRole(req.user, ['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR']);
    const items = await listOfflineIntakeAssessments({
      user: req.user,
      tenantId: req.user.tenantId,
      monitorOnly,
    });
    return res.json({
      items,
      summary: {
        total: items.length,
        ready: items.filter((item) => item.eligibleForOfflineIntake).length,
        setupRequired: items.filter((item) => !item.eligibleForOfflineIntake).length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/mapping-tokens',
  ...intake,
  [
    body('examId').notEmpty(),
    body('questionPaperId').notEmpty(),
    body('candidateId').optional({ nullable: true }).isMongoId(),
    body('sessionId').optional({ nullable: true }).isMongoId(),
    body('validDays').optional().isInt({ min: 1, max: 90 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const tenantId = req.user.tenantId;
      const { exam, error } = await loadOwnedExamForOfflineUpload({
        tenantId,
        examId: req.body.examId,
        questionPaperId: req.body.questionPaperId,
      });
      if (error) return res.status(error.status).json({ error: error.message });
      if (!await canOperateExam(req.user, exam)) {
        return res.status(403).json({ error: 'You may generate paper mapping tokens only for an assigned class or an assessment you own.' });
      }

      let sessionId = null;
      if (req.body.sessionId) {
        const session = await ExamSession.findOne({
          _id: req.body.sessionId,
          tenantId,
          examId: exam._id,
          $or: [
            { questionPaperId: req.body.questionPaperId },
            { questionPaperIds: req.body.questionPaperId },
          ],
        }).select('_id').lean();
        if (!session) return res.status(400).json({ error: 'Session does not belong to this assessment and question paper.' });
        sessionId = session._id;
      }

      const candidateScope = await resolveCandidateEnrollment({
        tenantId,
        candidateId: req.body.candidateId || null,
        examId: exam._id,
        courseOfferingId: exam.academicContext?.courseOfferingId || null,
      });
      const validDays = Number(req.body.validDays || 30);
      const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
      const created = await createAnswerScriptMappingToken({
        tenantId,
        examId: exam._id,
        questionPaperId: req.body.questionPaperId,
        sessionId,
        candidateId: candidateScope.candidateId,
        enrollmentId: candidateScope.enrollmentId,
        createdBy: req.user._id,
        expiresAt,
      });

      await logAuditEvent('ANSWER_SCRIPT_MAPPING_TOKEN_CREATED', {
        userId: req.user._id,
        tenantId,
        resourceType: 'AnswerScriptMappingToken',
        resourceId: created.record._id,
        examId: exam._id,
        candidateId: candidateScope.candidateId,
      });
      return res.status(201).json({
        tokenId: created.record._id,
        token: created.token,
        qrImage: created.qrImage,
        barcodeImage: created.barcodeImage,
        expiresAt,
        scope: {
          examId: exam._id,
          questionPaperId: req.body.questionPaperId,
          sessionId,
          candidateSpecific: Boolean(candidateScope.candidateId),
        },
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  },
);

const validateDirectUploadFile = (file) => {
  const name = String(file?.name || '').trim();
  const mimeType = String(file?.mimeType || '').trim().toLowerCase();
  const sizeBytes = Number(file?.sizeBytes);
  const checksum = String(file?.sha256 || '').trim().toLowerCase();
  if (!name || name.length > 255) return 'Each file needs a valid name (maximum 255 characters).';
  if (!offlineEvaluationConfig.ALLOWED_ANSWER_SCRIPT_MIME_TYPES.includes(mimeType)) return `${name}: unsupported file type.`;
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > offlineEvaluationConfig.MAX_ANSWER_SCRIPT_SIZE_BYTES) {
    return `${name}: file size must be within the configured answer-sheet limit.`;
  }
  if (!/^[a-f0-9]{64}$/.test(checksum)) return `${name}: a SHA-256 checksum is required.`;
  return null;
};

// Scalable intake: metadata/authorization stays on the API, file bytes go
// directly from the browser to a server-generated private S3 key.
router.post('/batches', ...intake, async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { examId, questionPaperId } = req.body || {};
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length || files.length > offlineEvaluationConfig.MAX_FILES_PER_BATCH) {
      return res.status(400).json({ error: `Select between 1 and ${offlineEvaluationConfig.MAX_FILES_PER_BATCH} answer-sheet files.` });
    }
    const invalid = files.map(validateDirectUploadFile).find(Boolean);
    if (invalid) return res.status(400).json({ error: invalid });
    const { exam, error } = await loadOwnedExamForOfflineUpload({ tenantId, examId, questionPaperId });
    if (error) return res.status(error.status).json({ error: error.message });
    if (!await canOperateExam(req.user, exam)) {
      return res.status(403).json({ error: 'You may upload answer sheets only for an assigned class or an assessment you own.' });
    }

    const batch = await AnswerScriptBatch.create({
      tenantId,
      examId,
      questionPaperId,
      courseOfferingId: exam.academicContext?.courseOfferingId || null,
      uploadedBy: req.user._id,
      totalFiles: files.length,
      uploadingCount: files.length,
      clientUploadConcurrency: offlineEvaluationConfig.CLIENT_UPLOAD_CONCURRENCY,
      status: 'UPLOADING',
    });
    const uploadTargets = [];
    for (const file of files) {
      const checksum = String(file.sha256).toLowerCase();
      const duplicate = await AnswerScript.findOne({
        tenantId,
        examId,
        status: { $nin: ['FAILED', 'CANCELLED'] },
        $or: [{ 'originalObject.checksum': checksum }, { 'sourceFile.checksum': checksum }],
      }).select('_id status createdAt').lean();
      if (duplicate) {
        const script = await AnswerScript.create({
          tenantId, examId, questionPaperId, batchId: batch._id,
          courseOfferingId: exam.academicContext?.courseOfferingId || null,
          originalFileName: file.name, mimeType: file.mimeType, createdBy: req.user._id,
          status: 'POSSIBLE_DUPLICATE',
          statusReason: 'The same answer-sheet content already exists for this assessment.',
          originalObject: { checksum, sizeBytes: file.sizeBytes, mimeType: file.mimeType },
          duplicate: { status: 'POSSIBLE_DUPLICATE', existingAnswerScriptId: duplicate._id, detectedAt: new Date() },
          retention: { policyKey: offlineEvaluationConfig.RETENTION_POLICY_KEY, lifecycleState: 'HOT' },
        });
        uploadTargets.push({
          answerScriptId: script._id, fileName: file.name, status: 'POSSIBLE_DUPLICATE',
          existingAnswerScriptId: duplicate._id, upload: null,
        });
        continue;
      }

      const script = new AnswerScript({
        tenantId, examId, questionPaperId, batchId: batch._id,
        courseOfferingId: exam.academicContext?.courseOfferingId || null,
        originalFileName: file.name, mimeType: file.mimeType, createdBy: req.user._id,
        status: 'UPLOADING',
        originalObject: { checksum, sizeBytes: file.sizeBytes, mimeType: file.mimeType },
        retention: { policyKey: offlineEvaluationConfig.RETENTION_POLICY_KEY, lifecycleState: 'HOT' },
      });
      const extension = path.extname(file.name).toLowerCase() || (file.mimeType === 'application/pdf' ? '.pdf' : '.jpg');
      const { key } = buildPrivateObjectLocation({
        tenantId,
        category: 'answer-scripts',
        subpath: [String(examId), String(script._id), 'original'],
        filename: `answer-sheet${extension}`,
      });
      const multipart = Number(file.sizeBytes) >= offlineEvaluationConfig.MULTIPART_THRESHOLD_BYTES;
      script.uploadSession = {
        mode: multipart ? 'MULTIPART' : 'SINGLE', objectKey: key,
        expectedChecksum: checksum, expectedSizeBytes: file.sizeBytes,
        partSizeBytes: multipart ? offlineEvaluationConfig.MULTIPART_PART_SIZE_BYTES : 0,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      };
      await script.save();

      if (multipart) {
        const created = await createPrivateMultipartUpload({ key, contentType: file.mimeType });
        script.uploadSession.uploadId = created.uploadId;
        await script.save();
        const partCount = Math.ceil(file.sizeBytes / offlineEvaluationConfig.MULTIPART_PART_SIZE_BYTES);
        const parts = await Promise.all(Array.from({ length: partCount }, async (_, index) => ({
          partNumber: index + 1,
          url: await getPrivateMultipartPartUrl({ key, uploadId: created.uploadId, partNumber: index + 1 }),
        })));
        uploadTargets.push({
          answerScriptId: script._id, fileName: file.name, status: script.status,
          upload: { mode: 'MULTIPART', partSizeBytes: offlineEvaluationConfig.MULTIPART_PART_SIZE_BYTES, parts },
        });
      } else {
        uploadTargets.push({
          answerScriptId: script._id, fileName: file.name, status: script.status,
          upload: {
            mode: 'SINGLE',
            url: await getPrivateUploadUrl({ key, contentType: file.mimeType }),
            requiredHeaders: { 'Content-Type': file.mimeType },
          },
        });
      }
    }
    const currentBatch = await refreshAnswerScriptBatchCounters(batch._id);
    return res.status(201).json({
      batch: currentBatch,
      uploadTargets,
      policy: {
        maxFiles: offlineEvaluationConfig.MAX_FILES_PER_BATCH,
        maxFileSizeBytes: offlineEvaluationConfig.MAX_ANSWER_SCRIPT_SIZE_BYTES,
        clientUploadConcurrency: offlineEvaluationConfig.CLIENT_UPLOAD_CONCURRENCY,
      },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    return next(error);
  }
});

router.get('/batches/:batchId', ...staff, async (req, res, next) => {
  try {
    const batch = await AnswerScriptBatch.findOne({ _id: req.params.batchId, tenantId: req.user.tenantId }).lean();
    if (!batch) return res.status(404).json({ error: 'Answer-sheet batch not found.' });
    const exam = await Exam.findOne({ _id: batch.examId, tenantId: req.user.tenantId }).select('_id tenantId createdBy academicContext').lean();
    if (!exam || !(canMonitorTenantOperations(req.user) || await canOperateExam(req.user, exam))) {
      return res.status(403).json({ error: 'This batch is outside your assessment scope.' });
    }
    const items = await AnswerScript.find({ batchId: batch._id, tenantId: req.user.tenantId })
      .select('originalFileName status statusReason processingMeta pageCount duplicate materializedAttemptId updatedAt')
      .sort({ createdAt: 1 }).lean();
    return res.json({ batch, items });
  } catch (error) { return next(error); }
});

router.post('/:id/upload-parts', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    if (script.status !== 'UPLOADING' || script.uploadSession?.mode !== 'MULTIPART' || !script.uploadSession?.uploadId) {
      return res.status(409).json({ error: 'This answer sheet does not have an active multipart upload.' });
    }
    const partNumbers = Array.isArray(req.body?.partNumbers) ? req.body.partNumbers.map(Number) : [];
    const maxPart = Math.ceil(script.uploadSession.expectedSizeBytes / script.uploadSession.partSizeBytes);
    if (!partNumbers.length || partNumbers.some((part) => !Number.isInteger(part) || part < 1 || part > maxPart)) {
      return res.status(400).json({ error: 'Valid multipart part numbers are required.' });
    }
    const parts = await Promise.all([...new Set(partNumbers)].map(async (partNumber) => ({
      partNumber,
      url: await getPrivateMultipartPartUrl({
        key: script.uploadSession.objectKey,
        uploadId: script.uploadSession.uploadId,
        partNumber,
      }),
    })));
    return res.json({ parts });
  } catch (error) { return next(error); }
});

router.post('/:id/upload-target', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    if (script.status !== 'UPLOADING' || script.uploadSession?.mode !== 'SINGLE') {
      return res.status(409).json({ error: 'This answer sheet does not have an active single-object upload.' });
    }
    const url = await getPrivateUploadUrl({ key: script.uploadSession.objectKey, contentType: script.mimeType });
    return res.json({ upload: { mode: 'SINGLE', url, requiredHeaders: { 'Content-Type': script.mimeType } } });
  } catch (error) { return next(error); }
});

router.post('/:id/finalize-upload', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    if (['QUEUED', 'NORMALIZING', 'IDENTIFYING_CANDIDATE', 'EXTRACTING', 'SEGMENTING', 'EVALUATING', 'NEEDS_MAPPING', 'NEEDS_REVIEW'].includes(script.status)) {
      return res.json({ item: script, alreadyFinalized: true });
    }
    if (!['UPLOADING', 'UPLOADED'].includes(script.status)) {
      return res.status(409).json({ error: `Upload cannot be finalized from status ${script.status}.` });
    }
    if (script.uploadSession?.mode === 'MULTIPART' && !script.uploadSession.finalizedAt) {
      await completePrivateMultipartUpload({
        key: script.uploadSession.objectKey,
        uploadId: script.uploadSession.uploadId,
        parts: req.body?.parts,
      });
    }
    const object = await headPrivateObject({ key: script.uploadSession.objectKey });
    if (object.sizeBytes !== script.uploadSession.expectedSizeBytes) {
      script.status = 'FAILED';
      script.statusReason = `Uploaded object size ${object.sizeBytes} does not match expected size ${script.uploadSession.expectedSizeBytes}.`;
      await script.save();
      await refreshAnswerScriptBatchCounters(script.batchId);
      return res.status(409).json({ error: script.statusReason, code: 'UPLOAD_SIZE_MISMATCH' });
    }
    script.uploadSession.finalizedAt = script.uploadSession.finalizedAt || new Date();
    script.originalObject = {
      key: script.uploadSession.objectKey,
      checksum: script.uploadSession.expectedChecksum,
      sizeBytes: object.sizeBytes,
      mimeType: script.mimeType,
      etag: object.etag,
      storageClass: object.storageClass,
      uploadedAt: object.lastModified || new Date(),
    };
    script.sourceFile = {
      key: script.uploadSession.objectKey,
      url: '',
      checksum: script.uploadSession.expectedChecksum,
      sizeBytes: object.sizeBytes,
    };
    script.status = 'UPLOADED';
    await script.save();
    const queued = await enqueueAnswerScriptStage({
      stage: ANSWER_SCRIPT_JOB.NORMALIZE,
      answerScriptId: script._id,
      tenantId: script.tenantId,
      uploaderId: script.createdBy,
      batchId: script.batchId,
    });
    script.status = 'QUEUED';
    script.processingMeta = { ...script.processingMeta, stage: 'QUEUED', activeJobId: queued.jobId, heartbeatAt: new Date() };
    await script.save();
    await refreshAnswerScriptBatchCounters(script.batchId);
    await logAuditEvent(AUDIT_ACTIONS.OFFLINE_SCRIPT_UPLOADED, {
      userId: req.user._id, userEmail: req.user.email, userRole: req.user.role,
      tenantId: script.tenantId, resourceType: 'AnswerScript', resourceId: script._id,
      examId: script.examId, fileName: script.originalFileName, sizeBytes: object.sizeBytes,
      uploadMode: script.uploadSession.mode,
    });
    return res.status(202).json({ item: script, queue: queued });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    return next(error);
  }
});

router.delete('/:id', ...intake, async (req, res, next) => {
  try {
    const access = await loadAuthorizedScript(req);
    const exam = await Exam.findOne({ _id: access.exam._id, tenantId: req.user.tenantId })
      .select('_id tenantId showResultsImmediately resultsReleasedAt')
      .lean();
    const result = await deleteAnswerScript({
      script: access.script,
      exam,
      user: req.user,
      monitorOnly: access.monitorOnly,
    });
    return res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    return next(error);
  }
});

router.post('/:id/cancel-upload', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    if (script.status !== 'UPLOADING') return res.status(409).json({ error: 'Only an active upload can be cancelled.' });
    if (script.uploadSession?.mode === 'MULTIPART' && script.uploadSession?.uploadId) {
      await abortPrivateMultipartUpload({ key: script.uploadSession.objectKey, uploadId: script.uploadSession.uploadId });
    }
    script.status = 'CANCELLED';
    script.statusReason = 'Upload cancelled by the educator.';
    await script.save();
    await refreshAnswerScriptBatchCounters(script.batchId);
    return res.json({ item: script });
  } catch (error) { return next(error); }
});

router.post(
  '/upload-batch',
  ...intake,
  batchUpload.array('files', offlineEvaluationConfig.MAX_FILES_PER_BATCH),
  handleMulterError,
  [body('examId').notEmpty(), body('questionPaperId').notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });

      const tenantId = req.user.tenantId;
      const { examId, questionPaperId } = req.body;
      const { exam, error } = await loadOwnedExamForOfflineUpload({ tenantId, examId, questionPaperId });
      if (error) return res.status(error.status).json({ error: error.message });
      if (!await canOperateExam(req.user, exam)) {
        return res.status(403).json({ error: 'You may upload answer sheets only for an assigned class or an assessment you own.' });
      }

      const batch = await AnswerScriptBatch.create({
        tenantId,
        examId,
        questionPaperId,
        courseOfferingId: exam.academicContext?.courseOfferingId || null,
        uploadedBy: req.user._id,
        totalFiles: files.length,
        queuedCount: files.length,
        status: 'QUEUED',
      });

      const created = [];
      const failures = [];
      for (const file of files) {
        req.file = file;
        const result = await createScriptFromUpload({
          req,
          exam,
          questionPaperId,
          machineMapping: null,
          batchId: batch._id,
        });
        if (result.error) failures.push({ fileName: file.originalname, ...result.error });
        else created.push(result.script);
      }
      await refreshAnswerScriptBatchCounters(batch._id);
      return res.status(202).json({ batch, createdCount: created.length, failures, items: created });
    } catch (err) { return next(err); }
  }
);

router.post(
  '/upload',
  ...intake,
  upload.single('file'),
  handleMulterError,
  [body('examId').notEmpty(), body('questionPaperId').notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

      const tenantId = req.user.tenantId;
      const { examId, questionPaperId } = req.body;
      const { exam, error } = await loadOwnedExamForOfflineUpload({ tenantId, examId, questionPaperId });
      if (error) return res.status(error.status).json({ error: error.message });
      if (!await canOperateExam(req.user, exam)) {
        return res.status(403).json({ error: 'You may upload answer sheets only for an assigned class or an assessment you own.' });
      }

      let machineMapping = null;
      if (req.body.mappingToken) {
        machineMapping = await resolveAnswerScriptMappingToken({ token: req.body.mappingToken, tenantId });
        if (!machineMapping) return res.status(400).json({ error: 'The QR/barcode mapping token is invalid, expired, or revoked.' });
        if (String(machineMapping.examId) !== String(examId) || String(machineMapping.questionPaperId) !== String(questionPaperId)) {
          return res.status(400).json({ error: 'The QR/barcode token belongs to a different assessment or question paper.' });
        }
        const alreadyUsed = await AnswerScript.exists({ mappingTokenId: machineMapping._id });
        if (alreadyUsed) return res.status(409).json({ error: 'This QR/barcode token has already been used for an answer script.', code: 'MAPPING_TOKEN_ALREADY_USED' });
        if (machineMapping.candidateId) {
          await resolveCandidateEnrollment({
            tenantId,
            candidateId: machineMapping.candidateId,
            examId,
            courseOfferingId: exam.academicContext?.courseOfferingId || null,
          });
        }
      }

      const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const duplicate = await AnswerScript.findOne({ tenantId, examId, 'sourceFile.checksum': checksum }).select('_id status createdAt').lean();
      if (duplicate && req.query.override !== 'true') {
        return res.status(409).json({
          error: 'This file appears to already have been uploaded for this exam.',
          code: 'DUPLICATE_UPLOAD',
          existingAnswerScriptId: duplicate._id,
        });
      }

      const result = await createScriptFromUpload({
        req,
        exam,
        questionPaperId,
        machineMapping,
        mappingSymbology: req.body.mappingSymbology,
      });
      if (result.error) {
        return res.status(result.error.status).json({
          error: 'This file appears to already have been uploaded for this exam.',
          code: result.error.code,
          existingAnswerScriptId: result.error.existingAnswerScriptId,
        });
      }
      return res.status(201).json({ item: result.script });
    } catch (err) { return next(err); }
  }
);

router.get('/', ...staff, async (req, res, next) => {
  try {
    const filter = { tenantId: req.user.tenantId };
    if (req.query.examId) filter.examId = req.query.examId;
    if (req.query.status) filter.status = req.query.status;
    const items = await AnswerScript.find(filter).sort({ createdAt: -1 }).limit(500).populate('candidateId', 'name email').lean();
    if (canMonitorTenantOperations(req.user)) return res.json({ items, accessMode: 'MONITOR' });
    const exams = await Exam.find({ _id: { $in: [...new Set(items.map((item) => item.examId))] }, tenantId: req.user.tenantId })
      .select('_id tenantId createdBy academicContext')
      .lean();
    const allowedExamIds = new Set();
    for (const exam of exams) {
      if (await canOperateExam(req.user, exam)) allowedExamIds.add(String(exam._id));
    }
    return res.json({ items: items.filter((item) => allowedExamIds.has(String(item.examId))), accessMode: 'OPERATE' });
  } catch (err) { return next(err); }
});

router.get('/:id/processing-status', ...staff, async (req, res, next) => {
  try {
    const access = await loadAuthorizedScript(req, { allowTenantMonitor: true });
    const script = await AnswerScript.findById(access.script._id).lean();
    const segments = access.monitorOnly
      ? []
      : await AnswerSegment.find({ answerScriptId: script._id }).select('questionId evaluationStatus').lean();
    return res.json(buildProcessingStatusPayload(script, {
      segments,
      evaluationSummary: script.evaluationSummary || {},
    }));
  } catch (err) { return next(err); }
});

router.get('/:id', ...staff, async (req, res, next) => {
  try {
    const access = await loadAuthorizedScript(req, { allowTenantMonitor: true });
    const script = await AnswerScript.findById(access.script._id).populate('candidateId', 'name email').lean();
    if (access.monitorOnly) return res.json({ item: script, pages: [], segments: [], accessMode: 'MONITOR' });
    const pages = await AnswerScriptPage.find({ answerScriptId: script._id }).sort({ pageNumber: 1 }).lean();
    const segments = await AnswerSegment.find({ answerScriptId: script._id }).populate('questionId', 'questionText questionType points order').lean();
    const finalize = await loadFinalizeReadiness(script);
    return res.json({ item: script, pages, segments, finalize, accessMode: 'OPERATE' });
  } catch (err) { return next(err); }
});

// Part D/X — the ONLY way to view a page image: authenticated, tenant-
// checked, then a short-lived presigned URL. Never the public /uploads proxy.
router.get('/:id/pages/:pageId/image', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    const page = await AnswerScriptPage.findOne({ _id: req.params.pageId, answerScriptId: script._id, tenantId: req.user.tenantId }).select('image workingImage previewImage thumbnailImage pageNumber').lean();
    const variant = String(req.query.variant || 'preview').toLowerCase();
    const object = variant === 'thumbnail'
      ? page?.thumbnailImage
      : variant === 'working' ? (page?.workingImage || page?.image) : (page?.previewImage || page?.workingImage || page?.image);
    if (!object?.key) return res.status(404).json({ error: 'Page image not available.' });
    const url = await getPrivateSignedUrl({ key: object.key, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
    // 'application/pdf' when the page was prepared Python-free — the client
    // renders it in a PDF frame instead of an <img>.
    const mimeType = object.mimeType || page?.workingImage?.mimeType || page?.image?.mimeType || 'image/jpeg';
    return res.json({ url, variant, pageNumber: page.pageNumber, mimeType, widthPx: object.widthPx, heightPx: object.heightPx, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
  } catch (err) { return next(err); }
});

// Full page access in the evaluator workspace is deliberately limited to
// FULL_EXAM/ATTEMPTS assignments. Section/question evaluators receive only
// their answer-region crop from the segment endpoint below.
router.get('/review/:attemptId/pages/:pageId/image', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('EVALUATOR'), requireEvaluatorAccess(), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, tenantId: req.user.tenantId })
      .select('examId sourceAnswerScriptId').lean();
    if (!attempt?.sourceAnswerScriptId) return res.status(404).json({ error: 'Offline answer-sheet review was not found.' });
    const assignment = await hasActiveExaminerAssignment(req.user._id, attempt.examId, { attemptId: attempt._id });
    if (!assignment || !['FULL_EXAM', 'ATTEMPTS'].includes(assignment.scopeType)) {
      return res.status(403).json({ error: 'Full-page access is not included in this evaluator assignment; use the scoped answer crop.' });
    }
    const page = await AnswerScriptPage.findOne({
      _id: req.params.pageId,
      answerScriptId: attempt.sourceAnswerScriptId,
      tenantId: req.user.tenantId,
    }).select('image previewImage workingImage thumbnailImage pageNumber').lean();
    if (!page) return res.status(404).json({ error: 'Answer-sheet page not found.' });
    const variant = String(req.query.variant || 'preview').toLowerCase();
    const object = variant === 'thumbnail' ? page.thumbnailImage : (page.previewImage?.key ? page.previewImage : page.workingImage);
    if (!object?.key) return res.status(404).json({ error: 'Requested page derivative is unavailable.' });
    const url = await getPrivateSignedUrl({ key: object.key, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
    const mimeType = object.mimeType || page.workingImage?.mimeType || page.image?.mimeType || 'image/jpeg';
    return res.json({ url, pageNumber: page.pageNumber, variant, mimeType, widthPx: object.widthPx, heightPx: object.heightPx, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
  } catch (error) { return next(error); }
});

router.get('/:id/evaluated-derivative', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const script = await AnswerScript.findOne({ _id: req.params.id, tenantId: req.user.tenantId }).lean();
    if (!script) return res.status(404).json({ error: 'Answer script not found.' });
    if (!script.evaluatedDerivative?.key) {
      return res.status(409).json({
        error: script.status === 'DERIVATIVE_FAILED'
          ? 'Review is complete, but the evaluated paper could not be generated.'
          : 'The finalized evaluated derivative is not available yet.',
        code: script.status === 'DERIVATIVE_FAILED' ? 'DERIVATIVE_FAILED' : 'EVALUATED_PAPER_UNAVAILABLE',
      });
    }

    if (hasAnyRole(req.user, ['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'])) {
      await loadAuthorizedScript(req);
    } else if (hasRole(req.user, 'EVALUATOR')) {
      const assigned = await hasActiveExaminerAssignment(req.user._id, script.examId, {
        attemptId: script.materializedAttemptId,
      });
      if (!assigned) return res.status(403).json({ error: 'An active evaluator assignment is required.' });
    } else if (hasRole(req.user, 'CANDIDATE')) {
      if (String(script.candidateId || '') !== String(req.user._id)) {
        return res.status(403).json({ error: 'This evaluated script belongs to another candidate.' });
      }
      const exam = await Exam.findOne({ _id: script.examId, tenantId: req.user.tenantId })
        .select('showResultsImmediately resultsReleasedAt')
        .lean();
      if (!isExamResultsReleased(exam)) {
        return res.status(403).json({ error: 'The evaluated script is available only after results are released.' });
      }
    } else {
      return res.status(403).json({ error: 'This role cannot view evaluated answer scripts.' });
    }

    const url = await getPrivateSignedUrl({
      key: script.evaluatedDerivative.key,
      expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS,
    });
    return res.json({
      url,
      expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS,
      generatedAt: script.evaluatedDerivative.generatedAt,
      layoutMode: script.evaluatedDerivative.layoutMode,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

router.post('/:id/evaluated-derivative/regenerate', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    if (!['COMPLETED', 'FINALIZED', 'DERIVATIVE_FAILED', 'FINALIZING'].includes(script.status)) {
      return res.status(409).json({ error: 'The evaluated paper can be regenerated only after review is complete.' });
    }
    if (!script.materializedAttemptId) {
      return res.status(409).json({ error: 'This script has no reviewed attempt to render.' });
    }
    const queued = await enqueueAnswerScriptStage({
      stage: ANSWER_SCRIPT_JOB.RENDER,
      answerScriptId: script._id,
      tenantId: script.tenantId,
      uploaderId: script.createdBy || req.user._id,
      batchId: script.batchId,
      version: Number(script.processingMeta?.retryCount || 0) + 2,
    });
    script.status = 'FINALIZING';
    script.statusReason = '';
    script.errorCode = '';
    script.failureStage = '';
    script.safeMessage = '';
    script.processingMeta.activeJobId = queued.jobId;
    script.processingMeta.lastError = '';
    await script.save();
    return res.status(202).json({ item: script, queue: queued, message: 'Evaluated paper generation was queued.' });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

// Part L — the evaluator review UI only knows an Answer's
// sourceAnswerSegmentId (see AnswerReviewCard.jsx); this resolves straight
// to a viewable page image without the caller needing the script/page ids.
// Evaluators need this alongside Tenant Admin/Exam Creator — reuses the
// same EVALUATOR role already trusted by the existing examiner-review
// endpoint (routes/attempts.js), not a new authorization boundary.
router.get('/segments/:segmentId/image', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('EVALUATOR'), requireEvaluatorAccess(), async (req, res, next) => {
  try {
    const segment = await AnswerSegment.findOne({ _id: req.params.segmentId, tenantId: req.user.tenantId }).select('pageIds answerScriptId questionId materializedAnswerId cropObject').lean();
    if (!segment || !segment.pageIds?.length) return res.status(404).json({ error: 'No source page available for this answer.' });
    const script = await AnswerScript.findOne({ _id: segment.answerScriptId, tenantId: req.user.tenantId }).select('_id examId materializedAttemptId').lean();
    if (!script) return res.status(404).json({ error: 'Answer script not found.' });
    const hasEvaluatorScope = await hasActiveExaminerAssignment(req.user._id, script.examId, {
      attemptId: script.materializedAttemptId,
      questionId: segment.questionId,
    });
    if (!hasEvaluatorScope) return res.status(403).json({ error: 'An active evaluator assignment covering this answer is required.' });
    const page = await AnswerScriptPage.findOne({ _id: segment.pageIds[0], tenantId: req.user.tenantId }).select('previewImage workingImage image pageNumber').lean();
    const isCrop = ['SECTION', 'QUESTIONS'].includes(hasEvaluatorScope.scopeType);
    const key = isCrop
      ? segment.cropObject?.key
      : (page?.previewImage?.key || page?.workingImage?.key || page?.image?.key);
    if (!key) return res.status(404).json({ error: 'Scoped answer image not available.' });
    const url = await getPrivateSignedUrl({ key, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
    // Raster answer-region crops are always JPEG; a full page follows its own type.
    const mimeType = isCrop ? 'image/jpeg' : (page?.workingImage?.mimeType || page?.image?.mimeType || 'image/jpeg');
    return res.json({ url, pageNumber: page?.pageNumber, mimeType, accessMode: isCrop ? 'SCOPED_CROP' : 'FULL_PAGE', expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
  } catch (err) { return next(err); }
});

router.get('/:id/candidate-suggestions', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    const suggestions = await suggestCandidates({ tenantId: req.user.tenantId, examId: script.examId, detectedRollNumber: script.detectedRollNumber, detectedCandidateName: script.detectedCandidateName });
    return res.json({ suggestions });
  } catch (err) { return next(err); }
});

router.post('/:id/map-candidate', ...intake, [body('candidateId').notEmpty()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { script } = await loadAuthorizedScript(req);

    const User = (await import('../models/User.js')).default;
    const candidate = await User.findOne({
      _id: req.body.candidateId,
      tenantId: req.user.tenantId,
      $or: [{ role: 'CANDIDATE' }, { roles: 'CANDIDATE' }],
    }).select('_id').lean();
    if (!candidate) return res.status(404).json({ error: 'Candidate not found in this tenant.' });

    const rosterCheck = await assertCandidateOnAssessmentRoster({
      tenantId: req.user.tenantId,
      examId: script.examId,
      candidateId: candidate._id,
    });
    if (rosterCheck.rosterExists && !rosterCheck.onRoster) {
      return res.status(409).json({
        error: 'This student is not on the assessment roster. Assign them to the assessment first — intake will not silently add a student.',
        code: 'NOT_ON_ASSESSMENT_ROSTER',
      });
    }

    const offeringId = script.courseOfferingId;
    if (offeringId) {
      const offering = await CourseOffering.findOne({ _id: offeringId, tenantId: req.user.tenantId }).lean();
      if (!offering) return res.status(409).json({ error: 'The answer script course offering is no longer available.' });
      const enrollment = await Enrollment.findOne({
        tenantId: req.user.tenantId,
        userId: candidate._id,
        academicSessionId: offering.academicSessionId,
        programId: offering.programId,
        status: 'ACTIVE',
        ...(offering.cohortId ? { cohortId: offering.cohortId } : {}),
        ...(offering.academicSectionId ? { academicSectionId: offering.academicSectionId } : {}),
      }).select('_id').lean();
      if (!enrollment) return res.status(403).json({ error: 'The selected candidate is not enrolled in this assessment class/course offering.' });
      script.enrollmentId = enrollment._id;
    }

    const wasAlreadyMapped = Boolean(script.candidateId);
    script.candidateId = candidate._id;
    script.mappingMethod = 'MANUAL';
    script.mappingConfidence = 1;
    script.mappedAt = new Date();
    script.mappedBy = req.user._id;
    if (script.status === 'NEEDS_MAPPING') script.status = 'CANDIDATE_LOCKED';
    await script.save();

    await logAuditEvent(wasAlreadyMapped ? AUDIT_ACTIONS.OFFLINE_CANDIDATE_MAPPING_OVERRIDDEN : AUDIT_ACTIONS.OFFLINE_CANDIDATE_AUTO_MAPPED, {
      userId: req.user._id, tenantId: req.user.tenantId, resourceType: 'AnswerScript', resourceId: script._id, examId: script.examId, candidateId: candidate._id, method: 'MANUAL',
    });

    const queued = await enqueueAnswerScriptStage({
      stage: ANSWER_SCRIPT_JOB.IDENTITY,
      answerScriptId: script._id,
      tenantId: script.tenantId,
      uploaderId: script.createdBy || req.user._id,
      batchId: script.batchId,
      version: Number(script.processingMeta?.retryCount || 0) + 2,
    });
    return res.json({ item: script, queue: queued });
  } catch (err) { return next(err); }
});

router.patch('/:id/segments/:segmentId/map-question', ...intake, [body('questionId').notEmpty()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { script } = await loadAuthorizedScript(req);
    const segment = await AnswerSegment.findOne({ _id: req.params.segmentId, answerScriptId: script._id, tenantId: req.user.tenantId });
    if (!segment) return res.status(404).json({ error: 'Answer segment not found.' });
    const question = await Question.findOne({ _id: req.body.questionId, questionPaperId: script.questionPaperId }).lean();
    if (!question) return res.status(400).json({ error: 'That question does not belong to this script\'s question paper.' });

    const previousQuestionId = segment.questionId;
    segment.questionId = question._id;
    segment.responseType = question.questionType;
    segment.mappingStatus = 'MANUALLY_MAPPED';
    segment.mappingConfidence = 1;
    segment.mappedBy = req.user._id;

    const result = await routeAndEvaluate({
      question, extractedText: segment.extractedText, extractionConfidence: segment.extractionConfidence, mappingConfidence: 1,
      tenantId: req.user.tenantId, userId: req.user._id, examId: script.examId, answerScriptId: script._id,
    });
    segment.evaluationResult = result;
    segment.evaluationStatus = 'EVALUATED';
    segment.materializedAnswerId = null; // force re-materialization against the newly mapped question
    await segment.save();

    await logAuditEvent(AUDIT_ACTIONS.OFFLINE_QUESTION_MAPPING_CHANGED, {
      userId: req.user._id, tenantId: req.user.tenantId, resourceType: 'AnswerSegment', resourceId: segment._id, examId: script.examId,
      previousQuestionId, newQuestionId: question._id,
    });

    if (script.candidateId) await materializeFromScript({ answerScriptId: script._id, actorUserId: req.user._id });
    return res.json({ item: segment });
  } catch (err) { return next(err); }
});

router.post('/:id/finalize', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    const finalized = await finalizeAnswerScript({ answerScriptId: script._id, actorUserId: req.user._id });
    return res.json({ item: finalized });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

// Part P — retry a FAILED script without re-uploading.
router.post('/:id/retry', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    if (!['FAILED', 'STALE', 'DERIVATIVE_FAILED'].includes(script.status)) return res.status(409).json({ error: `Only a FAILED, STALE, or derivative-failed answer sheet can be retried (current status: ${script.status}).` });
    const requestedStage = String(req.body?.stage || script.failureStage || script.processingMeta?.stage || '').toUpperCase();
    let stage = ANSWER_SCRIPT_JOB.NORMALIZE;
    let scopeId = 'all';
    if (requestedStage.includes('IDENT')) stage = ANSWER_SCRIPT_JOB.IDENTITY;
    else if (requestedStage.includes('EXTRACT')) {
      stage = ANSWER_SCRIPT_JOB.EXTRACT_PAGE;
      const page = req.body?.pageId
        ? await AnswerScriptPage.findOne({ _id: req.body.pageId, answerScriptId: script._id })
        : await AnswerScriptPage.findOne({ answerScriptId: script._id, 'extractionCheckpoint.lastError': { $ne: '' } }).sort({ pageNumber: 1 });
      if (!page) return res.status(409).json({ error: 'No failed extraction page was found.' });
      scopeId = page._id;
    } else if (requestedStage.includes('SEGMENT')) stage = ANSWER_SCRIPT_JOB.SEGMENT;
    else if (requestedStage.includes('EVALUAT')) {
      stage = ANSWER_SCRIPT_JOB.EVALUATE_SEGMENT;
      const segment = req.body?.segmentId
        ? await AnswerSegment.findOne({ _id: req.body.segmentId, answerScriptId: script._id })
        : await AnswerSegment.findOne({ answerScriptId: script._id, 'evaluationCheckpoint.lastError': { $ne: '' } });
      if (!segment) {
        const pendingEvaluation = await AnswerSegment.countDocuments({
          answerScriptId: script._id,
          questionId: { $ne: null },
          mappingStatus: { $ne: 'NEEDS_REVIEW' },
          evaluationStatus: { $ne: 'EVALUATED' },
        });
        if (pendingEvaluation === 0) {
          stage = ANSWER_SCRIPT_JOB.MATERIALIZE;
          scopeId = 'all';
        } else {
          return res.status(409).json({ error: 'No failed answer evaluation was found.' });
        }
      } else {
        scopeId = segment._id;
      }
    } else if (requestedStage.includes('MATERIAL')) stage = ANSWER_SCRIPT_JOB.MATERIALIZE;
    else if (requestedStage.includes('RENDER') || requestedStage.includes('FINAL') || requestedStage.includes('DERIVATIVE') || script.status === 'DERIVATIVE_FAILED') {
      stage = ANSWER_SCRIPT_JOB.RENDER;
    }
    const version = Number(script.processingMeta?.retryCount || 0) + 2;
    const queued = await enqueueAnswerScriptStage({
      stage, scopeId, version,
      answerScriptId: script._id, tenantId: script.tenantId,
      uploaderId: script.createdBy || req.user._id, batchId: script.batchId,
    });
    script.status = script.status === 'DERIVATIVE_FAILED' ? 'FINALIZING' : 'QUEUED';
    script.statusReason = '';
    script.errorCode = '';
    script.failureStage = '';
    script.safeMessage = '';
    script.processingMeta.activeJobId = queued.jobId;
    script.processingMeta.lastError = '';
    script.processingMeta.diagnostics = null;
    await script.save();
    return res.json({ message: 'Only the failed processing stage was queued for retry.', queue: queued });
  } catch (err) { return next(err); }
});

export default router;
