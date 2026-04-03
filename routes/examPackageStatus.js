import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { hasExamPermission } from '../middleware/examPermissions.js';
import { isExamPackageRegenerationInFlight } from '../services/examPackageRegenerationService.js';
import Exam from '../models/Exam.js';
import ExamPackage from '../models/ExamPackage.js';
import ExamSession from '../models/ExamSession.js';
import SessionAssignment from '../models/SessionAssignment.js';

const router = express.Router();

const MOBILE_PACKAGE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
  GENERATED: 'GENERATED', // legacy persisted value
});
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const MIN_ENCRYPTED_PACKAGE_LENGTH = IV_LENGTH + TAG_LENGTH + 1;

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

const normalizeStoredStatus = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === MOBILE_PACKAGE_STATUS.FAILED) {
    return MOBILE_PACKAGE_STATUS.FAILED;
  }
  if (normalized === MOBILE_PACKAGE_STATUS.PROCESSING) {
    return MOBILE_PACKAGE_STATUS.PROCESSING;
  }
  if (normalized === MOBILE_PACKAGE_STATUS.GENERATED || normalized === MOBILE_PACKAGE_STATUS.READY) {
    return MOBILE_PACKAGE_STATUS.READY;
  }
  return MOBILE_PACKAGE_STATUS.PENDING;
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

router.get(
  '/package-status/:sessionId',
  requireAuth,
  requireTenant,
  requireRole('CANDIDATE', 'EXAM_CREATOR', 'TENANT_ADMIN'),
  async (req, res, next) => {
    const startedAtMs = Date.now();
    try {
      const sessionId = normalizeOptionalObjectId(req.params.sessionId);
      if (!sessionId) {
        return res.status(400).json({
          status: MOBILE_PACKAGE_STATUS.FAILED,
          error: 'Invalid session ID',
          downloadUrl: null,
        });
      }

      const session = await ExamSession.findById(sessionId).select(
        '_id examId tenantId questionPaperId questionPaperIds'
      );
      if (!session) {
        return res.status(404).json({
          status: MOBILE_PACKAGE_STATUS.FAILED,
          error: 'Exam session not found',
          downloadUrl: null,
        });
      }

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        session.tenantId?.toString() &&
        session.tenantId.toString() !== req.user.tenantId?.toString()
      ) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const examId = session.examId?.toString();
      const exam = examId
        ? await Exam.findById(examId).select(
            '_id tenantId packageStatus packageGeneratedAt packageVersion packageLastError'
          )
        : null;

      if (!exam) {
        return res.status(404).json({
          status: MOBILE_PACKAGE_STATUS.FAILED,
          error: 'Exam not found',
          downloadUrl: null,
        });
      }
      const examTenantId = normalizeTenantId(exam.tenantId);
      const userTenantId = normalizeTenantId(req.user?.tenantId);
      if (!examTenantId) {
        return res.status(422).json({
          status: MOBILE_PACKAGE_STATUS.FAILED,
          error: 'Exam tenantId is missing. Please contact administrator.',
          downloadUrl: null,
        });
      }

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        examTenantId !== userTenantId
      ) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const isPackageManagerRole = ['EXAM_CREATOR', 'TENANT_ADMIN'].includes(req.user.role);
      if (!isPackageManagerRole) {
        const canAttempt = await hasExamPermission(req.user._id, exam._id, 'ATTEMPT_EXAM');
        if (!canAttempt) {
          return res.status(403).json({
            error: 'You do not have permission to access this exam package',
          });
        }
      }

      const requestedQuestionPaperId = normalizeOptionalObjectId(req.query?.questionPaperId);
      const assignment = await SessionAssignment.findOne({
        sessionId: session._id,
        userId: req.user._id,
      })
        .select('questionPaperId')
        .lean();
      const assignedQuestionPaperId = normalizeOptionalObjectId(
        assignment?.questionPaperId?.toString() || null
      );

      // Prefer the per-candidate assigned question paper to avoid mismatches that keep status pending.
      let questionPaperId =
        assignedQuestionPaperId ||
        requestedQuestionPaperId ||
        normalizeOptionalObjectId(session.questionPaperId?.toString() || null);

      if (
        !questionPaperId &&
        Array.isArray(session.questionPaperIds) &&
        session.questionPaperIds.length > 0
      ) {
        questionPaperId = normalizeOptionalObjectId(
          session.questionPaperIds[0]?.toString() || null
        );
      }

      const readyPackage = await resolveReadyPackage({
        examId: exam._id,
        questionPaperId,
      });
      const storedStatus = normalizeStoredStatus(exam.packageStatus);
      const regenerationInFlight = isExamPackageRegenerationInFlight(exam._id.toString());

      let status = MOBILE_PACKAGE_STATUS.PENDING;
      if (storedStatus === MOBILE_PACKAGE_STATUS.FAILED) {
        status = MOBILE_PACKAGE_STATUS.FAILED;
      } else if (readyPackage) {
        status = MOBILE_PACKAGE_STATUS.READY;
      } else if (
        storedStatus === MOBILE_PACKAGE_STATUS.PROCESSING ||
        regenerationInFlight
      ) {
        status = MOBILE_PACKAGE_STATUS.PROCESSING;
      }

      if (status === MOBILE_PACKAGE_STATUS.READY && storedStatus !== MOBILE_PACKAGE_STATUS.READY) {
        const generatedAt = readyPackage?.createdAt ? new Date(readyPackage.createdAt) : new Date();
        await Exam.updateOne(
          { _id: exam._id },
          {
            $set: {
              packageStatus: 'READY',
              packageGeneratedAt: generatedAt,
              packageLastGeneratedAt: generatedAt,
              packageVersion: Number(readyPackage?.version || exam.packageVersion || 0),
              latestPackageUrl: `/api/exam-packages/${exam._id}/download`,
              packageLastError: '',
            },
          }
        );
      } else if (
        status === MOBILE_PACKAGE_STATUS.PROCESSING &&
        storedStatus !== MOBILE_PACKAGE_STATUS.PROCESSING &&
        storedStatus !== MOBILE_PACKAGE_STATUS.FAILED
      ) {
        await Exam.updateOne(
          { _id: exam._id },
          {
            $set: {
              packageStatus: 'PROCESSING',
              latestPackageUrl: `/api/exam-packages/${exam._id}/download`,
              packageLastError: '',
            },
          }
        );
      } else if (
        status === MOBILE_PACKAGE_STATUS.PENDING &&
        storedStatus === MOBILE_PACKAGE_STATUS.READY
      ) {
        await Exam.updateOne(
          { _id: exam._id },
          {
            $set: {
              packageStatus: 'PENDING',
              latestPackageUrl: '',
            },
          }
        );
      }

      const resolvedQuestionPaperId =
        normalizeOptionalObjectId(questionPaperId) ||
        normalizeOptionalObjectId(readyPackage?.questionPaperId?.toString() || null);

      const downloadUrl =
        status === MOBILE_PACKAGE_STATUS.READY
          ? `/api/exam-packages/${exam._id}/download${
              resolvedQuestionPaperId ? `?questionPaperId=${resolvedQuestionPaperId}` : ''
            }`
          : null;

      return res.json({
        status,
        downloadUrl,
        examId: exam._id.toString(),
        questionPaperId: resolvedQuestionPaperId,
        message:
          status === MOBILE_PACKAGE_STATUS.FAILED
            ? String(exam.packageLastError || 'Exam package generation failed')
            : status === MOBILE_PACKAGE_STATUS.PROCESSING
              ? 'Exam package is being generated'
              : status === MOBILE_PACKAGE_STATUS.PENDING
                ? 'Exam package is being prepared'
                : 'Exam package is ready',
      });
    } catch (error) {
      console.error(
        `[Mobile Package Status] Failed for session ${req.params.sessionId} after ${Date.now() - startedAtMs}ms:`,
        error
      );
      if (res.headersSent) {
        return next(error);
      }
      return res.status(503).json({
        status: MOBILE_PACKAGE_STATUS.PENDING,
        downloadUrl: null,
        error: 'Unable to fetch package status right now. Please retry.',
      });
    }
  }
);

export default router;
