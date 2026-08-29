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
import ExamParticipant from '../models/ExamParticipant.js';
import QuestionPaper from '../models/QuestionPaper.js';
import AnswerScript from '../models/AnswerScript.js';
import AnswerScriptPage from '../models/AnswerScriptPage.js';
import AnswerSegment from '../models/AnswerSegment.js';
import Question from '../models/Question.js';
import { putPrivateObject, getPrivateSignedUrl } from '../services/storage/imageStorage.js';
import { processAnswerScript } from '../services/offlineEvaluation/answerScriptIngestionService.js';
import { materializeFromScript, finalizeAnswerScript } from '../services/offlineEvaluation/attemptMaterializationService.js';
import { routeAndEvaluate } from '../services/offlineEvaluation/evaluationRouterService.js';
import { suggestCandidates } from '../services/offlineEvaluation/candidateMappingService.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/auditLogger.js';
import offlineEvaluationConfig from '../config/offlineEvaluationConfig.js';
import { canOperateExam, canMonitorTenantOperations } from '../services/academicAccessService.js';
import { hasActiveExaminerAssignment, requireEvaluatorAccess } from '../middleware/examPermissions.js';
import { Enrollment, CourseOffering } from '../models/academic/index.js';
import { hasAnyRole, hasRole } from '../utils/userRoles.js';
import { isExamResultsReleased } from '../utils/resultVisibility.js';
import {
  createAnswerScriptMappingToken,
  resolveAnswerScriptMappingToken,
} from '../services/offlineEvaluation/machineReadableMappingService.js';

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

      const ext = path.extname(req.file.originalname || '').toLowerCase() || (req.file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
      const stored = await putPrivateObject({
        tenantId, category: 'answer-scripts', subpath: ['originals'],
        fileStem: sanitizeFileName(path.basename(req.file.originalname || 'script', ext)),
        extension: ext, buffer: req.file.buffer, contentType: req.file.mimetype,
      });

      const script = await AnswerScript.create({
        tenantId, examId, questionPaperId,
        courseOfferingId: exam.academicContext?.courseOfferingId || null,
        examSessionId: machineMapping?.sessionId || null,
        mappingTokenId: machineMapping?._id || null,
        candidateId: machineMapping?.candidateId || null,
        enrollmentId: machineMapping?.enrollmentId || null,
        mappingMethod: machineMapping ? (String(req.body.mappingSymbology || '').toUpperCase() === 'BARCODE' ? 'BARCODE' : 'QR') : null,
        mappingConfidence: machineMapping ? 1 : null,
        sourceFile: { key: stored.key, checksum, sizeBytes: req.file.size, url: '' },
        originalFileName: req.file.originalname,
        mimeType: req.file.mimetype,
        status: 'UPLOADED',
        createdBy: req.user._id,
      });

      await logAuditEvent(AUDIT_ACTIONS.OFFLINE_SCRIPT_UPLOADED, {
        userId: req.user._id, userEmail: req.user.email, userRole: req.user.role, tenantId,
        resourceType: 'AnswerScript', resourceId: script._id, examId, fileName: req.file.originalname, sizeBytes: req.file.size,
      });

      void processAnswerScript(script._id, { actorUserId: req.user._id }); // fire-and-forget — see the ingestion service header comment
      return res.status(201).json({ item: script });
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

router.get('/:id', ...staff, async (req, res, next) => {
  try {
    const access = await loadAuthorizedScript(req, { allowTenantMonitor: true });
    const script = await AnswerScript.findById(access.script._id).populate('candidateId', 'name email').lean();
    if (access.monitorOnly) return res.json({ item: script, pages: [], segments: [], accessMode: 'MONITOR' });
    const pages = await AnswerScriptPage.find({ answerScriptId: script._id }).sort({ pageNumber: 1 }).lean();
    const segments = await AnswerSegment.find({ answerScriptId: script._id }).populate('questionId', 'questionText questionType points order').lean();
    return res.json({ item: script, pages, segments, accessMode: 'OPERATE' });
  } catch (err) { return next(err); }
});

// Part D/X — the ONLY way to view a page image: authenticated, tenant-
// checked, then a short-lived presigned URL. Never the public /uploads proxy.
router.get('/:id/pages/:pageId/image', ...intake, async (req, res, next) => {
  try {
    const { script } = await loadAuthorizedScript(req);
    const page = await AnswerScriptPage.findOne({ _id: req.params.pageId, answerScriptId: script._id, tenantId: req.user.tenantId }).select('image').lean();
    if (!page?.image?.key) return res.status(404).json({ error: 'Page image not available.' });
    const url = await getPrivateSignedUrl({ key: page.image.key, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
    return res.json({ url, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
  } catch (err) { return next(err); }
});

router.get('/:id/evaluated-derivative', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const script = await AnswerScript.findOne({ _id: req.params.id, tenantId: req.user.tenantId }).lean();
    if (!script) return res.status(404).json({ error: 'Answer script not found.' });
    if (script.status !== 'FINALIZED' || !script.evaluatedDerivative?.key) {
      return res.status(409).json({ error: 'The finalized evaluated derivative is not available yet.' });
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

// Part L — the evaluator review UI only knows an Answer's
// sourceAnswerSegmentId (see AnswerReviewCard.jsx); this resolves straight
// to a viewable page image without the caller needing the script/page ids.
// Evaluators need this alongside Tenant Admin/Exam Creator — reuses the
// same EVALUATOR role already trusted by the existing examiner-review
// endpoint (routes/attempts.js), not a new authorization boundary.
router.get('/segments/:segmentId/image', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('EVALUATOR'), requireEvaluatorAccess(), async (req, res, next) => {
  try {
    const segment = await AnswerSegment.findOne({ _id: req.params.segmentId, tenantId: req.user.tenantId }).select('pageIds answerScriptId questionId materializedAnswerId').lean();
    if (!segment || !segment.pageIds?.length) return res.status(404).json({ error: 'No source page available for this answer.' });
    const script = await AnswerScript.findOne({ _id: segment.answerScriptId, tenantId: req.user.tenantId }).select('_id examId materializedAttemptId').lean();
    if (!script) return res.status(404).json({ error: 'Answer script not found.' });
    const hasEvaluatorScope = await hasActiveExaminerAssignment(req.user._id, script.examId, {
      attemptId: script.materializedAttemptId,
      questionId: segment.questionId,
    });
    if (!hasEvaluatorScope) return res.status(403).json({ error: 'An active evaluator assignment covering this answer is required.' });
    const page = await AnswerScriptPage.findOne({ _id: segment.pageIds[0], tenantId: req.user.tenantId }).select('image pageNumber').lean();
    if (!page?.image?.key) return res.status(404).json({ error: 'Page image not available.' });
    const url = await getPrivateSignedUrl({ key: page.image.key, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
    return res.json({ url, pageNumber: page.pageNumber, expiresInSeconds: offlineEvaluationConfig.PRIVATE_URL_EXPIRY_SECONDS });
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
    if (script.status === 'NEEDS_MAPPING') script.status = 'PROCESSING';
    await script.save();

    await logAuditEvent(wasAlreadyMapped ? AUDIT_ACTIONS.OFFLINE_CANDIDATE_MAPPING_OVERRIDDEN : AUDIT_ACTIONS.OFFLINE_CANDIDATE_AUTO_MAPPED, {
      userId: req.user._id, tenantId: req.user.tenantId, resourceType: 'AnswerScript', resourceId: script._id, examId: script.examId, candidateId: candidate._id, method: 'MANUAL',
    });

    void processAnswerScript(script._id, { actorUserId: req.user._id }); // resumes from question mapping (candidate now resolved)
    return res.json({ item: script });
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
    if (script.status !== 'FAILED') return res.status(409).json({ error: `Only a FAILED script can be retried (current status: ${script.status}).` });
    void processAnswerScript(script._id, { actorUserId: req.user._id });
    return res.json({ message: 'Retry started.' });
  } catch (err) { return next(err); }
});

export default router;
