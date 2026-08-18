import WizKidsQuestionBankItem from '../models/WizKidsQuestionBankItem.js';
import WizKidsQuestionLink from '../models/WizKidsQuestionLink.js';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Exam from '../models/Exam.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { isValidGradeLevel } from './wizKidsBatchService.js';

// WizKids Phase 5 — Reusable Question Bank.
//
// Single source of truth for WizKidsQuestionBankItem CRUD and, most
// importantly, materializeQuestion() — the one function that turns a
// reusable WizKids question into a real, standard Question document. This
// deliberately does NOT reimplement question validation/normalization —
// Question.create() runs through the exact same pre-validate hook
// (applyQuestionShape in models/Question.js) every other question-creation
// path in the app already goes through, so a materialized question is
// indistinguishable from a hand-authored one anywhere else in the system
// (exam preview, attempt engine, evaluation, analytics, export).
export class WizKidsQuestionBankError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WizKidsQuestionBankError';
    this.status = status;
  }
}

const VALID_INTERACTION_TYPES = Object.freeze(['MCQ', 'NUMBER', 'SHORT_ANSWER', 'FILL_IN_THE_BLANK', 'MATCHING', 'IMAGE']);
const VALID_DIFFICULTIES = Object.freeze(['EASY', 'MEDIUM', 'HARD']);
const VALID_DOMAINS = Object.freeze(['MENTAL_MATHS', 'VEDIC_MATHS', 'SUPER_MATHS', 'LOGIC', 'OLYMPIAD']);

const DOMAIN_TO_CAPABILITY = Object.freeze({
  MENTAL_MATHS: 'WIZKIDS_MENTAL_MATHS',
  VEDIC_MATHS: 'WIZKIDS_VEDIC_MATHS',
  SUPER_MATHS: 'WIZKIDS_SUPER_MATHS',
  LOGIC: 'WIZKIDS_LOGIC',
  OLYMPIAD: 'WIZKIDS_OLYMPIAD',
});

// Maps WizKids's own interactionType vocabulary onto the EXISTING
// Question.questionType enum — reuses existing types first (master prompt
// §24), introducing zero new question types on the core model. IMAGE
// defaults to an MCQ answer shape; a bank item's own options/correctAnswer
// still drive the actual content. Question.questionFormat is intentionally
// left for Question's own pre-validate hook (normalizeQuestionFormat) to
// derive — it already infers 'MCQ' for MULTIPLE_CHOICE and 'IMAGE' when an
// imageUrl is present, so duplicating that logic here would just be a
// second, driftable copy of it.
export const INTERACTION_TYPE_TO_QUESTION_TYPE = Object.freeze({
  MCQ: 'MULTIPLE_CHOICE',
  NUMBER: 'NUMBER',
  SHORT_ANSWER: 'SHORT_ANSWER',
  FILL_IN_THE_BLANK: 'FILL_IN_THE_BLANK',
  MATCHING: 'MATCHING',
  IMAGE: 'MULTIPLE_CHOICE',
});

// Question.correctAnswer is a plain String field. A bank item's
// correctAnswer is intentionally Mixed (supports arrays/objects for
// MATCHING-style pairs) — this is the one, single place that boundary gets
// crossed, so every materialization goes through identical, tested logic.
export const stringifyCorrectAnswerForQuestion = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const matchingAnswerMap = (pairs) => (Array.isArray(pairs) ? pairs : []).reduce((result, pair) => {
  const left = String(pair?.left || pair?.term || pair?.prompt || '').trim();
  const right = String(pair?.right || pair?.match || pair?.answer || '').trim();
  if (left && right) result[left] = right;
  return result;
}, {});

const assertCapabilityEnabled = async (tenantId, featureKey) => {
  const state = await resolveTenantFeature(tenantId, featureKey);
  if (!state?.effectiveEnabled) {
    throw new WizKidsQuestionBankError(403, `The ${featureKey} capability is not enabled for this tenant.`);
  }
};

const assertDomainEntitled = async (tenantId, domain) => {
  await assertCapabilityEnabled(tenantId, 'WIZKIDS');
  const capability = DOMAIN_TO_CAPABILITY[domain];
  if (capability) await assertCapabilityEnabled(tenantId, capability);
};

export const createBankItem = async ({
  tenantId,
  createdBy,
  domain,
  gradeLevel,
  topic,
  subTopic,
  skill,
  difficulty,
  interactionType,
  questionContent,
  options,
  correctAnswer,
  solution,
  explanation,
  media,
  generatorMetadata,
  status,
}) => {
  if (!tenantId) throw new WizKidsQuestionBankError(400, 'tenantId is required.');
  if (!VALID_DOMAINS.includes(domain)) {
    throw new WizKidsQuestionBankError(400, `domain must be one of ${VALID_DOMAINS.join(', ')}.`);
  }
  if (!isValidGradeLevel(gradeLevel)) {
    throw new WizKidsQuestionBankError(400, 'gradeLevel must be an integer between 1 and 7.');
  }
  if (!VALID_INTERACTION_TYPES.includes(interactionType)) {
    throw new WizKidsQuestionBankError(400, `interactionType must be one of ${VALID_INTERACTION_TYPES.join(', ')}.`);
  }
  if (!questionContent || !String(questionContent).trim()) {
    throw new WizKidsQuestionBankError(400, 'questionContent is required.');
  }
  if (correctAnswer === undefined || correctAnswer === null || correctAnswer === '') {
    throw new WizKidsQuestionBankError(400, 'correctAnswer is required.');
  }
  if (difficulty && !VALID_DIFFICULTIES.includes(difficulty)) {
    throw new WizKidsQuestionBankError(400, `difficulty must be one of ${VALID_DIFFICULTIES.join(', ')}.`);
  }
  if (status && !['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) {
    throw new WizKidsQuestionBankError(400, 'status must be DRAFT, PUBLISHED, or ARCHIVED.');
  }

  await assertDomainEntitled(tenantId, domain);
  if (interactionType === 'IMAGE') {
    await assertCapabilityEnabled(tenantId, 'WIZKIDS_VISUAL_QUESTIONS');
    if (!media?.imageUrl || !String(media.imageUrl).trim()) {
      throw new WizKidsQuestionBankError(400, 'IMAGE questions require an uploaded imageUrl.');
    }
  }

  return WizKidsQuestionBankItem.create({
    tenantId,
    domain,
    gradeLevel: Number(gradeLevel),
    topic: topic || '',
    subTopic: subTopic || '',
    skill: skill || '',
    difficulty: difficulty || 'MEDIUM',
    interactionType,
    questionContent: String(questionContent).trim(),
    options,
    correctAnswer,
    solution: solution || '',
    explanation: explanation || '',
    media: { imageUrl: media?.imageUrl || null },
    generatorMetadata: generatorMetadata || {},
    status: status || 'DRAFT',
    createdBy,
  });
};

export const listBankItems = async ({ tenantId, domain, gradeLevel, status }) => {
  const filter = { tenantId };
  if (domain) filter.domain = domain;
  if (gradeLevel) filter.gradeLevel = Number(gradeLevel);
  if (status) filter.status = status;
  return WizKidsQuestionBankItem.find(filter).sort({ createdAt: -1 }).lean();
};

// Tenant scope built into the query itself, not fetch-then-check — see
// DOCS/WIZKIDS_INTEGRATION_ASSESSMENT.md §16 / master prompt §57.
export const getBankItemForTenant = async ({ tenantId, bankItemId }) =>
  WizKidsQuestionBankItem.findOne({ _id: bankItemId, tenantId }).lean();

export const updateBankItem = async ({ tenantId, bankItemId, updates = {} }) => {
  const patch = {};
  const assignableFields = ['topic', 'subTopic', 'skill', 'questionContent', 'options', 'correctAnswer', 'solution', 'explanation'];
  for (const field of assignableFields) {
    if (updates[field] !== undefined) patch[field] = updates[field];
  }
  if (updates.difficulty !== undefined) {
    if (!VALID_DIFFICULTIES.includes(updates.difficulty)) {
      throw new WizKidsQuestionBankError(400, `difficulty must be one of ${VALID_DIFFICULTIES.join(', ')}.`);
    }
    patch.difficulty = updates.difficulty;
  }
  if (updates.gradeLevel !== undefined) {
    if (!isValidGradeLevel(updates.gradeLevel)) {
      throw new WizKidsQuestionBankError(400, 'gradeLevel must be an integer between 1 and 7.');
    }
    patch.gradeLevel = Number(updates.gradeLevel);
  }
  if (updates.media !== undefined) {
    patch.media = { imageUrl: updates.media?.imageUrl || null };
  }

  const item = await WizKidsQuestionBankItem.findOneAndUpdate(
    { _id: bankItemId, tenantId },
    { $set: patch, $inc: { version: 1 } },
    { new: true }
  );
  if (!item) throw new WizKidsQuestionBankError(404, 'Question bank item not found.');
  return item;
};

export const setBankItemStatus = async ({ tenantId, bankItemId, status }) => {
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) {
    throw new WizKidsQuestionBankError(400, 'status must be DRAFT, PUBLISHED, or ARCHIVED.');
  }
  const item = await WizKidsQuestionBankItem.findOneAndUpdate(
    { _id: bankItemId, tenantId },
    { $set: { status } },
    { new: true }
  );
  if (!item) throw new WizKidsQuestionBankError(404, 'Question bank item not found.');
  return item;
};

// The core Phase 5 operation. Clones a PUBLISHED WizKidsQuestionBankItem
// into a real, standard Question belonging to the target exam's question
// paper — after this call, the question is a completely ordinary Xamigo
// question: it appears in exam preview, gets attempted, graded, analyzed,
// and exported through entirely unmodified existing code, because it *is*
// an unmodified, standard Question document.
export const materializeQuestion = async ({ tenantId, bankItemId, examId, questionPaperId, sectionId, points, materializedBy }) => {
  const bankItem = await WizKidsQuestionBankItem.findOne({ _id: bankItemId, tenantId }).lean();
  if (!bankItem) throw new WizKidsQuestionBankError(404, 'Question bank item not found.');
  if (bankItem.status !== 'PUBLISHED') {
    throw new WizKidsQuestionBankError(400, 'Only PUBLISHED question bank items can be materialized into an exam.');
  }

  await assertDomainEntitled(tenantId, bankItem.domain);

  const exam = await Exam.findOne({ _id: examId, tenantId, productModule: 'WIZKIDS' }).select('_id').lean();
  if (!exam) throw new WizKidsQuestionBankError(404, 'WizKids exam not found.');

  const questionPaper = await QuestionPaper.findOne({ _id: questionPaperId, examId }).select('_id').lean();
  if (!questionPaper) throw new WizKidsQuestionBankError(404, 'Question paper not found for this exam.');

  const questionType = INTERACTION_TYPE_TO_QUESTION_TYPE[bankItem.interactionType];
  const materializedMatchingPairs = bankItem.interactionType === 'MATCHING' && Array.isArray(bankItem.options)
    ? bankItem.options
    : [];
  const orderFilter = sectionId ? { questionPaperId, sectionId } : { questionPaperId };
  const nextOrder = await Question.countDocuments(orderFilter);

  const question = await Question.create({
    questionPaperId,
    sectionId: sectionId || undefined,
    questionText: bankItem.questionContent,
    questionType,
    options: bankItem.options,
    correctAnswer: bankItem.interactionType === 'MATCHING'
      ? JSON.stringify(matchingAnswerMap(materializedMatchingPairs))
      : stringifyCorrectAnswerForQuestion(bankItem.correctAnswer),
    matchingPairs: bankItem.interactionType === 'MATCHING' ? materializedMatchingPairs : undefined,
    imageUrl: bankItem.media?.imageUrl || '',
    difficulty: bankItem.difficulty,
    points: Number.isFinite(Number(points)) ? Number(points) : 1,
    order: nextOrder,
    // Traceability back to the WizKids source, stored the same way any other
    // question-specific marking config is stored (evaluationConfig is
    // explicitly documented on Question itself as the place for exactly
    // this kind of authoring metadata). wizKidsExplanation/wizKidsSolution
    // are read directly by Phase 7's Practice Mode instant-feedback check
    // (services/wizKidsPracticeService.js) — denormalized here so a
    // practice-answer check needs only the materialized Question, not an
    // extra join back through WizKidsQuestionLink/WizKidsQuestionBankItem.
    evaluationConfig: {
      wizKidsBankItemId: String(bankItem._id),
      wizKidsDomain: bankItem.domain,
      wizKidsSkill: bankItem.skill,
      wizKidsExplanation: bankItem.explanation || '',
      wizKidsSolution: bankItem.solution || '',
    },
  });

  const link = await WizKidsQuestionLink.create({
    tenantId,
    bankItemId,
    examId,
    questionPaperId,
    questionId: question._id,
    skillMetadata: { domain: bankItem.domain, topic: bankItem.topic, subTopic: bankItem.subTopic, skill: bankItem.skill, difficulty: bankItem.difficulty },
    materializedBy,
  });

  return { question, link };
};

export const listMaterializations = async ({ tenantId, bankItemId, examId }) => {
  const filter = { tenantId };
  if (bankItemId) filter.bankItemId = bankItemId;
  if (examId) filter.examId = examId;
  return WizKidsQuestionLink.find(filter).sort({ createdAt: -1 }).lean();
};
