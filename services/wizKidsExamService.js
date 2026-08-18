import Exam from '../models/Exam.js';
import QuestionPaper from '../models/QuestionPaper.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import WizKidsBatch from '../models/WizKidsBatch.js';
import { ensureExamParticipant } from '../middleware/examPermissions.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { listBatchMembers, isValidGradeLevel } from './wizKidsBatchService.js';

// WizKids Phase 4 — Exam Integration.
//
// Deliberately NOT a re-implementation of the full exam-creation engine in
// routes/exams.js (duplicate title checks, OMR handling, section-based
// duration computation, etc.) — master prompt §27: "Do not build another
// complete exam engine or duplicate the entire standard exam builder."
// This wraps the minimum needed to prove the architecture: a real Exam +
// QuestionPaper are created (so the EXISTING, unmodified routes/sections.js
// and routes/questions.js endpoints already work against them — "section
// reuse" and question reuse for free), tagged with productModule='WIZKIDS'
// and a sibling WizKidsExamConfig record. Candidate assignment reuses the
// exact same ensureExamParticipant() every other exam-assignment path in
// this app already uses. Standard exam attempt/evaluation/result code is
// untouched and therefore automatically reused — nothing here teaches
// routes/attempts.js anything new about WizKids.
export class WizKidsExamError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsExamError';
    this.status = status;
  }
}

// Only modes whose required attempt-engine behavior actually exists are
// creatable (master prompt §29 — "Release normal WizKids Tests / Olympiad
// tests first... before Practice and Speed Mode"). PRACTICE was unlocked in
// Phase 7 unlocked PRACTICE once its instant-feedback check endpoint existed.
// Phase 8 now unlocks SPEED because WizKidsAttemptState and the dedicated
// Speed route enforce its per-question timing and navigation contract.
export const SUPPORTED_EXAM_MODES = Object.freeze(['TEST', 'WORKSHEET', 'COMPETITION', 'OLYMPIAD', 'PRACTICE', 'SPEED']);
export const UNSUPPORTED_EXAM_MODES = Object.freeze([]);

export const DOMAIN_TO_CAPABILITY = Object.freeze({
  MENTAL_MATHS: 'WIZKIDS_MENTAL_MATHS',
  VEDIC_MATHS: 'WIZKIDS_VEDIC_MATHS',
  SUPER_MATHS: 'WIZKIDS_SUPER_MATHS',
  LOGIC: 'WIZKIDS_LOGIC',
  OLYMPIAD: 'WIZKIDS_OLYMPIAD',
});

export const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertCapabilityEnabled = async (tenantId, featureKey) => {
  const state = await resolveTenantFeature(tenantId, featureKey);
  if (!state?.effectiveEnabled) {
    throw new WizKidsExamError(403, `The ${featureKey} capability is not enabled for this tenant.`);
  }
};

export const prepareWizKidsExamInput = async ({
  tenantId,
  mode = 'TEST',
  gradeLevel,
  domains = [],
  batchIds = [],
  autoAdvance,
  allowBackNavigation,
  questionTimerSeconds,
  interactionMode = 'STANDARD',
  flashMaths = {},
}) => {
  if (!tenantId) throw new WizKidsExamError(400, 'tenantId is required.');
  if (!SUPPORTED_EXAM_MODES.includes(mode)) {
    throw new WizKidsExamError(
      400,
      UNSUPPORTED_EXAM_MODES.includes(mode)
        ? `mode "${mode}" is not available yet — it requires attempt-engine work not yet implemented.`
        : `mode must be one of ${SUPPORTED_EXAM_MODES.join(', ')}.`
    );
  }
  if (!isValidGradeLevel(gradeLevel)) {
    throw new WizKidsExamError(400, 'gradeLevel must be an integer between 1 and 7.');
  }

  const requestedDomains = Array.isArray(domains) ? domains : [];
  const invalidDomains = requestedDomains.filter((domain) => !DOMAIN_TO_CAPABILITY[domain]);
  if (invalidDomains.length) {
    throw new WizKidsExamError(400, `Unsupported Junior domain: ${invalidDomains[0]}.`);
  }
  const normalizedDomains = [...new Set(requestedDomains)];
  const normalizedBatchIds = [...new Set((Array.isArray(batchIds) ? batchIds : []).map(String))];
  const isSpeedMode = mode === 'SPEED';
  const normalizedInteractionMode = String(interactionMode || 'STANDARD').trim().toUpperCase();
  if (!['STANDARD', 'FLASH_MATHS'].includes(normalizedInteractionMode)) {
    throw new WizKidsExamError(400, 'interactionMode must be STANDARD or FLASH_MATHS.');
  }
  if (normalizedInteractionMode === 'FLASH_MATHS' && isSpeedMode) {
    throw new WizKidsExamError(400, 'Flash Maths is a distinct interaction and cannot be combined with legacy Speed Mode.');
  }
  const normalizedFlashMaths = normalizedInteractionMode === 'FLASH_MATHS'
    ? {
      configVersion: 1,
      difficulty: String(flashMaths?.difficulty || 'EASY').toUpperCase(),
      operationMode: String(flashMaths?.operationMode || 'ADDITION').toUpperCase(),
      operandCount: Number(flashMaths?.operandCount ?? 5),
      minimumDigits: Number(flashMaths?.minimumDigits ?? 1),
      maximumDigits: Number(flashMaths?.maximumDigits ?? 2),
      flashDurationMs: Number(flashMaths?.flashDurationMs ?? 750),
      gapDurationMs: Number(flashMaths?.gapDurationMs ?? 250),
      answerWindowMs: Number(flashMaths?.answerWindowMs ?? 30000),
      negativeIntermediateAllowed: flashMaths?.negativeIntermediateAllowed === true,
    }
    : undefined;
  if (normalizedFlashMaths) {
    if (!['EASY', 'MEDIUM', 'HARD', 'ULTRA_HARD'].includes(normalizedFlashMaths.difficulty)) {
      throw new WizKidsExamError(400, 'Flash Maths difficulty is invalid.');
    }
    if (!['ADDITION', 'SUBTRACTION', 'ADD_SUB_MIXED'].includes(normalizedFlashMaths.operationMode)) {
      throw new WizKidsExamError(400, 'Flash Maths operationMode is invalid.');
    }
    if (!Number.isInteger(normalizedFlashMaths.operandCount) || normalizedFlashMaths.operandCount < 2 || normalizedFlashMaths.operandCount > 20) {
      throw new WizKidsExamError(400, 'Flash Maths operandCount must be between 2 and 20.');
    }
    if (!Number.isInteger(normalizedFlashMaths.minimumDigits) || !Number.isInteger(normalizedFlashMaths.maximumDigits) || normalizedFlashMaths.minimumDigits < 1 || normalizedFlashMaths.maximumDigits > 4 || normalizedFlashMaths.minimumDigits > normalizedFlashMaths.maximumDigits) {
      throw new WizKidsExamError(400, 'Flash Maths digit bounds must be between 1 and 4.');
    }
    if (!Number.isInteger(normalizedFlashMaths.flashDurationMs) || normalizedFlashMaths.flashDurationMs < 150 || normalizedFlashMaths.flashDurationMs > 10000) {
      throw new WizKidsExamError(400, 'Flash Maths flashDurationMs must be between 150 and 10000.');
    }
    if (!Number.isInteger(normalizedFlashMaths.gapDurationMs) || normalizedFlashMaths.gapDurationMs < 0 || normalizedFlashMaths.gapDurationMs > 5000) {
      throw new WizKidsExamError(400, 'Flash Maths gapDurationMs must be between 0 and 5000.');
    }
    if (!Number.isInteger(normalizedFlashMaths.answerWindowMs) || normalizedFlashMaths.answerWindowMs < 1000 || normalizedFlashMaths.answerWindowMs > 120000) {
      throw new WizKidsExamError(400, 'Flash Maths answerWindowMs must be between 1000 and 120000.');
    }
    await assertCapabilityEnabled(tenantId, 'WIZKIDS_SPEED_MODE');
  }
  const normalizedQuestionTimerSeconds =
    questionTimerSeconds === undefined || questionTimerSeconds === null || questionTimerSeconds === ''
      ? null
      : Number(questionTimerSeconds);
  if (
    normalizedQuestionTimerSeconds !== null &&
    (!Number.isInteger(normalizedQuestionTimerSeconds) || normalizedQuestionTimerSeconds < 1)
  ) {
    throw new WizKidsExamError(400, 'questionTimerSeconds must be a positive whole number of seconds.');
  }

  await assertCapabilityEnabled(tenantId, 'WIZKIDS');
  const requiredCapabilities = new Set(normalizedDomains.map((domain) => DOMAIN_TO_CAPABILITY[domain]));
  if (mode === 'OLYMPIAD') requiredCapabilities.add('WIZKIDS_OLYMPIAD');
  if (mode === 'PRACTICE') requiredCapabilities.add('WIZKIDS_PRACTICE');
  if (isSpeedMode) requiredCapabilities.add('WIZKIDS_SPEED_MODE');
  for (const capability of requiredCapabilities) {
    // eslint-disable-next-line no-await-in-loop
    await assertCapabilityEnabled(tenantId, capability);
  }

  if (normalizedBatchIds.length) {
    const batchCount = await WizKidsBatch.countDocuments({
      _id: { $in: normalizedBatchIds },
      tenantId,
      status: 'ACTIVE',
    });
    if (batchCount !== normalizedBatchIds.length) {
      throw new WizKidsExamError(400, 'One or more batchIds do not belong to this tenant or are inactive.');
    }
  }

  return {
    mode,
    gradeLevel: Number(gradeLevel),
    domains: normalizedDomains,
    batchIds: normalizedBatchIds,
    autoAdvance: isSpeedMode ? autoAdvance !== false : false,
    allowBackNavigation: isSpeedMode ? allowBackNavigation === true : true,
    questionTimerSeconds: isSpeedMode ? normalizedQuestionTimerSeconds : null,
    interactionMode: normalizedInteractionMode,
    ...(normalizedFlashMaths ? { flashMaths: normalizedFlashMaths } : {}),
  };
};

export const createWizKidsExamArtifacts = async ({ exam, tenantId, createdBy, preparedInput }) => {
  if (!exam?._id || String(exam.tenantId || '') !== String(tenantId || '')) {
    throw new WizKidsExamError(400, 'A tenant-scoped core exam is required.');
  }
  if (exam.productModule !== 'WIZKIDS') {
    throw new WizKidsExamError(400, 'Junior configuration can only be attached to a WIZKIDS exam.');
  }

  const [questionPaper, config] = await Promise.all([
    QuestionPaper.findOneAndUpdate(
      { examId: exam._id, setName: 'Set A' },
      { $setOnInsert: { isActive: true, createdBy } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
    WizKidsExamConfig.findOneAndUpdate(
      { tenantId, examId: exam._id },
      { $setOnInsert: { ...preparedInput, createdBy } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
  ]);

  return { questionPaper, config };
};

export const createWizKidsExam = async ({
  tenantId,
  createdBy,
  title,
  description,
  duration,
  gracePeriod,
  maxAttempts,
  mode,
  gradeLevel,
  domains = [],
  batchIds = [],
  autoAdvance,
  allowBackNavigation,
  questionTimerSeconds,
  interactionMode,
  flashMaths,
}) => {
  if (!tenantId) throw new WizKidsExamError(400, 'tenantId is required.');
  if (!title || !String(title).trim()) throw new WizKidsExamError(400, 'title is required.');
  const normalizedDuration = Number(duration);
  if (!Number.isFinite(normalizedDuration) || normalizedDuration < 1) {
    throw new WizKidsExamError(400, 'duration must be a positive number of minutes.');
  }
  const preparedInput = await prepareWizKidsExamInput({
    tenantId,
    mode,
    gradeLevel,
    domains,
    batchIds,
    autoAdvance,
    allowBackNavigation,
    questionTimerSeconds,
    interactionMode,
    flashMaths,
  });

  const duplicate = await Exam.findOne({
    tenantId,
    isActive: true,
    title: { $regex: `^${escapeRegExp(String(title).trim())}$`, $options: 'i' },
  })
    .select('_id')
    .lean();
  if (duplicate) throw new WizKidsExamError(409, 'An exam with this title already exists for this tenant.');

  const exam = await Exam.create({
    title: String(title).trim(),
    description: description || '',
    duration: normalizedDuration,
    gracePeriod: gracePeriod || 0,
    maxAttempts: maxAttempts || 1,
    examType: 'ONLINE',
    productModule: 'WIZKIDS',
    tenantId,
    createdBy,
    isActive: true,
  });

  // Mirrors routes/exams.js's own post-creation step: the creator becomes a
  // CREATOR ExamParticipant on their own exam.
  await ensureExamParticipant(createdBy, exam._id, 'CREATOR', createdBy);

  // The default (and, for Phase 4, only) question-paper "set" — sections and
  // questions are added afterward through the existing, unmodified
  // routes/sections.js / routes/questions.js endpoints, which already work
  // generically against any questionPaperId.
  const { questionPaper, config } = await createWizKidsExamArtifacts({
    exam,
    tenantId,
    createdBy,
    preparedInput,
  });

  return { exam, questionPaper, config };
};

export const getWizKidsExamConfig = async ({ tenantId, examId }) =>
  WizKidsExamConfig.findOne({ tenantId, examId }).lean();

export const listWizKidsExams = async ({ tenantId, mode }) => {
  const configFilter = { tenantId };
  if (mode) configFilter.mode = mode;
  const configs = await WizKidsExamConfig.find(configFilter).sort({ createdAt: -1 }).lean();
  const examIds = configs.map((config) => config.examId);
  const [exams, questionPapers] = await Promise.all([
    Exam.find({ _id: { $in: examIds }, tenantId, productModule: 'WIZKIDS' }).lean(),
    QuestionPaper.find({ examId: { $in: examIds }, isActive: true }).sort({ createdAt: 1 }).lean(),
  ]);
  const examsById = new Map(exams.map((exam) => [String(exam._id), exam]));
  const paperByExamId = new Map();
  for (const paper of questionPapers) {
    if (!paperByExamId.has(String(paper.examId))) paperByExamId.set(String(paper.examId), paper);
  }
  return configs
    .map((config) => ({
      config,
      exam: examsById.get(String(config.examId)) || null,
      questionPaper: paperByExamId.get(String(config.examId)) || null,
    }))
    .filter((entry) => entry.exam !== null);
};

// Candidate assignment reuse (master prompt §54 Phase 4 acceptance list) —
// resolves a batch's active CANDIDATE members and grants each one direct
// exam access via the exact same ensureExamParticipant() function every
// other exam-assignment path in this app already uses
// (middleware/examPermissions.js). No new assignment mechanism introduced;
// partial-success by design, matching bulkAddCandidates's convention in
// wizKidsBatchService.js.
export const assignBatchToWizKidsExam = async ({ tenantId, examId, batchId, assignedBy }) => {
  const config = await WizKidsExamConfig.findOne({ tenantId, examId });
  if (!config) throw new WizKidsExamError(404, 'WizKids exam not found.');

  const batch = await WizKidsBatch.findOne({ _id: batchId, tenantId }).lean();
  if (!batch) throw new WizKidsExamError(404, 'Batch not found.');
  if (batch.status !== 'ACTIVE') throw new WizKidsExamError(400, 'Cannot assign an inactive batch to a WizKids exam.');

  const members = await listBatchMembers({ tenantId, batchId, role: 'CANDIDATE', status: 'ACTIVE' });

  const results = [];
  for (const member of members) {
    const memberUserId = member.userId?._id || member.userId;
    try {
      // eslint-disable-next-line no-await-in-loop
      await ensureExamParticipant(memberUserId, examId, 'CANDIDATE', assignedBy);
      results.push({ userId: memberUserId, status: 'assigned' });
    } catch (error) {
      results.push({ userId: memberUserId, status: 'skipped', reason: error.message });
    }
  }

  if (!config.batchIds.some((id) => String(id) === String(batchId))) {
    config.batchIds.push(batchId);
    await config.save();
  }

  return results;
};
