import QuestionBankItem from '../models/QuestionBankItem.js';
import QuestionVersion from '../models/QuestionVersion.js';
import { resolveAcademicVisibility } from './academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';

export class QuestionBankProvenanceError extends Error {
  constructor(status, message, code = 'PROVENANCE_INVALID') {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

const id = (value) => (value == null ? '' : String(value));

const isReadableBankScope = (visibility, item) => {
  if (visibility.all) return true;
  if (item.organizationUnitId && visibility.ids['organization-units'].includes(id(item.organizationUnitId))) return true;
  if (item.courseId && visibility.ids.courses.includes(id(item.courseId))) return true;
  if (!item.organizationUnitId && !item.courseId) return hasRole(visibility.user, 'TENANT_ADMIN');
  return false;
};

/**
 * Server-authoritative validation when materializing a Question from Question Bank.
 * Client may supply only questionVersionId; all content and provenance come from DB.
 */
export const resolveAuthorizedQuestionVersionForReuse = async ({
  user,
  questionVersionId,
  requireApproved = true,
}) => {
  const versionId = String(questionVersionId || '').trim();
  if (!/^[a-fA-F0-9]{24}$/.test(versionId)) {
    throw new QuestionBankProvenanceError(400, 'A valid questionVersionId is required for bank reuse.');
  }

  const visibility = await resolveAcademicVisibility(user);
  const version = await QuestionVersion.findOne({ _id: versionId, tenantId: visibility.tenantId }).lean();
  if (!version) {
    throw new QuestionBankProvenanceError(404, 'Question version not found in this tenant.');
  }

  if (requireApproved && version.status !== 'APPROVED') {
    throw new QuestionBankProvenanceError(
      409,
      'Only an APPROVED question version may be reused in an assessment.',
      'VERSION_NOT_APPROVED',
    );
  }

  const item = await QuestionBankItem.findOne({
    _id: version.questionBankItemId,
    tenantId: visibility.tenantId,
    status: 'ACTIVE',
  }).lean();
  if (!item) {
    throw new QuestionBankProvenanceError(404, 'Question bank item not found or is archived.');
  }

  if (!isReadableBankScope(visibility, item)) {
    throw new QuestionBankProvenanceError(
      403,
      'This question version is outside your authorized academic scope.',
      'SCOPE_NOT_AUTHORIZED',
    );
  }

  return {
    questionBankItemId: item._id,
    questionVersionId: version._id,
    version,
    item,
    provenance: {
      questionBankItemId: item._id,
      questionVersionId: version._id,
      ...(version.provenance && typeof version.provenance === 'object' ? version.provenance : {}),
    },
    content: {
      questionText: version.questionText,
      questionType: version.questionType,
      questionFormat: version.questionFormat,
      options: version.options,
      matchingPairs: version.matchingPairs,
      correctAnswer: version.correctAnswer,
      passage: version.passage,
      paragraphGroupId: version.paragraphGroupId,
      codingFields: version.codingFields,
      evaluationConfig: version.evaluationConfig,
      difficulty: version.difficulty,
      bloomLevel: version.bloomLevel,
      cognitiveDemand: version.cognitiveDemand,
    },
  };
};
