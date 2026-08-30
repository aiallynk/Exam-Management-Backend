import AnswerScript from '../../models/AnswerScript.js';
import { buildExamRosterEntries } from './examRosterIdentityService.js';
import { resolveMappingFromRoster, suggestFromRoster } from './candidateMatchingLogic.js';

export { resolveMappingFromRoster, suggestFromRoster } from './candidateMatchingLogic.js';

export const suggestCandidates = async (params) => {
  const roster = await buildExamRosterEntries({ tenantId: params.tenantId, examId: params.examId });
  return suggestFromRoster({ roster, ...params });
};

export const resolveCandidateMapping = async (params) => {
  const roster = await buildExamRosterEntries({ tenantId: params.tenantId, examId: params.examId });
  return resolveMappingFromRoster({ roster, ...params });
};

export const autoMapCandidate = async (params) => {
  const resolved = await resolveCandidateMapping(params);
  if (resolved.status !== 'AUTO_MAP') return null;
  return {
    candidateId: resolved.candidateId,
    enrollmentId: resolved.enrollmentId || null,
    confidence: resolved.confidence,
    method: resolved.method,
  };
};

export const assertNoDuplicateCandidateScript = async ({ tenantId, examId, candidateId, excludeScriptId = null }) => {
  if (!candidateId) return null;
  const filter = { tenantId, examId, candidateId, status: { $nin: ['FAILED'] } };
  if (excludeScriptId) filter._id = { $ne: excludeScriptId };
  const existing = await AnswerScript.findOne(filter).select('_id status originalFileName').lean();
  return existing || null;
};
