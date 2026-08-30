import Answer from '../../models/Answer.js';
import AnswerAnnotation from '../../models/AnswerAnnotation.js';
import AnswerScript from '../../models/AnswerScript.js';
import AnswerScriptPage from '../../models/AnswerScriptPage.js';
import AnswerSegment from '../../models/AnswerSegment.js';
import ExamAttempt from '../../models/ExamAttempt.js';
import { abortPrivateMultipartUpload, deletePrivateObject } from '../storage/imageStorage.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../../utils/auditLogger.js';
import { hasRole } from '../../utils/userRoles.js';
import { isExamResultsReleased } from '../../utils/resultVisibility.js';
import { refreshAnswerScriptBatchCounters } from './answerScriptBatchService.js';

const uniqueKeys = (values = []) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];

export const collectAnswerScriptObjectKeys = ({ script = {}, pages = [], segments = [] } = {}) => uniqueKeys([
  script.sourceFile?.key,
  script.originalObject?.key,
  script.normalizedObject?.key,
  script.evaluatedDerivative?.key,
  script.uploadSession?.objectKey,
  ...pages.flatMap((page) => [
    page.image?.key,
    page.workingImage?.key,
    page.previewImage?.key,
    page.thumbnailImage?.key,
    page.identityHeaderImage?.key,
  ]),
  ...segments.map((segment) => segment.cropObject?.key),
]);

export const evaluateAnswerScriptDeletion = ({
  script,
  monitorOnly = false,
  resultsReleased = false,
  isAcademicAdmin = false,
} = {}) => {
  if (monitorOnly) {
    return {
      allowed: false,
      statusCode: 403,
      code: 'MONITOR_ONLY',
      message: 'Organization monitoring cannot delete answer sheets. Use Academic Admin or the intake workspace.',
    };
  }
  if (!script?._id) {
    return {
      allowed: false,
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Answer script not found.',
    };
  }
  if (resultsReleased && script.materializedAttemptId && !isAcademicAdmin) {
    return {
      allowed: false,
      statusCode: 409,
      code: 'RESULTS_RELEASED',
      message: 'This answer sheet is already part of released results. Ask an Academic Admin to remove it if the wrong paper was uploaded.',
    };
  }
  return {
    allowed: true,
    removesAttempt: Boolean(script.materializedAttemptId),
    removesReleasedResult: Boolean(resultsReleased && script.materializedAttemptId),
  };
};

const ignoreStorageError = async (operation) => {
  try {
    await operation();
  } catch {
    // Best-effort cleanup: the Mongo record must still be removed so the same file can be uploaded again.
  }
};

export const deleteAnswerScript = async ({ script, exam, user, monitorOnly = false }) => {
  const decision = evaluateAnswerScriptDeletion({
    script,
    monitorOnly,
    resultsReleased: isExamResultsReleased(exam),
    isAcademicAdmin: hasRole(user, 'ACADEMIC_ADMIN'),
  });
  if (!decision.allowed) {
    throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode, code: decision.code });
  }

  const [pages, segments] = await Promise.all([
    AnswerScriptPage.find({ answerScriptId: script._id, tenantId: script.tenantId }).lean(),
    AnswerSegment.find({ answerScriptId: script._id, tenantId: script.tenantId }).select('cropObject').lean(),
  ]);
  const objectKeys = collectAnswerScriptObjectKeys({ script, pages, segments });

  if (script.uploadSession?.mode === 'MULTIPART' && script.uploadSession?.uploadId && script.uploadSession?.objectKey) {
    await ignoreStorageError(() => abortPrivateMultipartUpload({
      key: script.uploadSession.objectKey,
      uploadId: script.uploadSession.uploadId,
    }));
  }

  script.status = 'CANCELLED';
  script.statusReason = 'Deleted by staff so the sheet can be replaced.';
  await script.save();

  const attemptId = script.materializedAttemptId || null;
  await AnswerAnnotation.deleteMany({ tenantId: script.tenantId, answerScriptId: script._id });
  await AnswerSegment.deleteMany({ tenantId: script.tenantId, answerScriptId: script._id });
  await AnswerScriptPage.deleteMany({ tenantId: script.tenantId, answerScriptId: script._id });
  if (attemptId) {
    await Answer.deleteMany({ attemptId });
    await ExamAttempt.deleteOne({
      _id: attemptId,
      tenantId: script.tenantId,
      sourceAnswerScriptId: script._id,
    });
  }
  const batchId = script.batchId;
  await AnswerScript.deleteOne({ _id: script._id, tenantId: script.tenantId });
  await refreshAnswerScriptBatchCounters(batchId);
  await Promise.all(objectKeys.map((key) => ignoreStorageError(() => deletePrivateObject({ key }))));

  await logAuditEvent(AUDIT_ACTIONS.OFFLINE_SCRIPT_DELETED, {
    userId: user?._id || null,
    userRole: user?.role || null,
    tenantId: script.tenantId,
    resourceType: 'AnswerScript',
    resourceId: script._id,
    examId: script.examId,
    details: {
      originalFileName: script.originalFileName,
      removedAttemptId: attemptId,
      removesReleasedResult: decision.removesReleasedResult,
    },
  });

  return {
    deleted: true,
    answerScriptId: script._id,
    removedAttemptId: attemptId,
    removesReleasedResult: decision.removesReleasedResult,
  };
};
