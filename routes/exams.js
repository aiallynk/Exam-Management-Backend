import express from 'express';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import ExamParticipant from '../models/ExamParticipant.js';
import User from '../models/User.js';
import SubTenant from '../models/SubTenant.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireOwnershipOrAdmin } from '../middleware/roles.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import {
  ensureExamParticipant,
  canCandidateAccessExam,
} from '../middleware/examPermissions.js';
import { checkExamCreationLimit } from '../middleware/planLimits.js';
import { body, validationResult } from 'express-validator';
import { sanitizePagination } from '../middleware/validation.js';
import { auditLog, AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { FREE_PLAN_MESSAGES, isPlanFeatureEnabled } from '../config/planLimits.js';
import {
  resolveExamPlanContext,
  resolveUserEffectivePlanType,
  sendPlanRestriction,
} from '../middleware/planRestrictions.js';
import { submitAttemptHandler } from './attempts.js';
import {
  loadCertificateTemplate,
  applyCertificateTemplate,
  MIN_CERTIFICATION_PERCENTAGE,
} from '../utils/certificateTemplate.js';
import { ensureScoreSummary } from '../utils/attemptScores.js';
import { syncUserExamCount } from '../utils/planUsage.js';
import { ensureQuestionsImageAvailability } from '../services/questionImportImageService.js';
import { sanitizeQuestionOptions } from '../utils/questionOptionSanitizer.js';
import { normalizeQuestionType } from '../utils/questionTypeRegistry.js';
import { sanitizeExamAccessControlPayload } from '../utils/examSecurity.js';
import { queueExamPackageRegeneration } from '../services/examPackageRegenerationService.js';
import { resolveAttemptExhaustedExamIds } from '../utils/attemptAvailability.js';
import { resolveAssessmentSpecification } from '../services/assessmentSpecificationResolver.js';
import { freezePaperTemplateOntoExam, PaperTemplateError } from '../services/paperTemplateService.js';
import RubricTemplate from '../models/RubricTemplate.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import QuestionUsage from '../models/QuestionUsage.js';
import { hasRole, hasAnyRole } from '../utils/userRoles.js';
import { resolveAcademicVisibility, canOperateExam, canAuthorInCourseOffering } from '../services/academicAccessService.js';
import { isGovernanceScopeReadable } from '../utils/governanceScope.js';
import {
  canChangeExamDeliveryMode,
  countAnswerScriptsForExam,
} from '../services/offlineEvaluation/offlineIntakeEligibilityService.js';

const router = express.Router();
const SECTION_BASED_EXAM_TYPE = 'SECTION_BASED';
const OMR_EXAM_TYPE = 'OMR';
const ONLINE_EXAM_TYPE = 'ONLINE';
const MAX_OMR_OPTIONS = 4;
const OMR_OPTION_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const MONGO_OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
const CANDIDATE_ASSIGNMENT_MODES = new Set(['add', 'remove', 'replace']);

const toPositiveInt = (value, fallback = null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
};

const toNonNegativeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

const normalizeExamType = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
};

const isValidObjectId = (value) => MONGO_OBJECT_ID_PATTERN.test(String(value || '').trim());
const normalizeObjectIdArray = (value) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((candidate) => String(candidate || '').trim())
      .filter((candidate) => isValidObjectId(candidate))
  )];
};

const parseCandidateIdPayload = (value) => {
  if (value === undefined) {
    return { candidateIds: [], invalidIds: [], duplicateIds: [] };
  }

  const rawIds = Array.isArray(value)
    ? value.map((candidate) => String(candidate || '').trim()).filter(Boolean)
    : [];
  const invalidIds = rawIds.filter((candidateId) => !isValidObjectId(candidateId));
  const validIds = rawIds.filter((candidateId) => isValidObjectId(candidateId));
  const duplicateIds = [...new Set(validIds.filter((candidateId, index) => validIds.indexOf(candidateId) !== index))];

  return {
    candidateIds: [...new Set(validIds)],
    invalidIds: [...new Set(invalidIds)],
    duplicateIds,
  };
};

const resolveAssignmentMode = (value) => {
  const normalized = String(value || 'replace').trim().toLowerCase();
  return CANDIDATE_ASSIGNMENT_MODES.has(normalized) ? normalized : 'replace';
};

const resolveCandidateUsersForTenant = async (candidateIds, tenantId) => {
  const uniqueCandidateIds = normalizeObjectIdArray(candidateIds);
  if (!uniqueCandidateIds.length) {
    return { candidateIds: [], users: [] };
  }

  const users = await User.find({
    _id: { $in: uniqueCandidateIds },
    role: 'CANDIDATE',
  }).select('_id tenantId role').lean();

  const userMap = new Map(users.map((user) => [String(user._id), user]));
  const missingIds = uniqueCandidateIds.filter((candidateId) => !userMap.has(candidateId));
  if (missingIds.length > 0) {
    const missingCount = missingIds.length;
    return {
      error: {
        status: 404,
        message:
          missingCount === 1
            ? `Candidate ${missingIds[0]} not found.`
            : `${missingCount} candidate accounts were not found.`,
      },
    };
  }

  const crossTenantIds = users
    .filter((user) => String(user.tenantId || '') !== String(tenantId || ''))
    .map((user) => String(user._id));
  if (crossTenantIds.length > 0) {
    return {
      error: {
        status: 403,
        message:
          crossTenantIds.length === 1
            ? 'Candidate does not belong to this tenant.'
            : 'One or more candidates do not belong to this tenant.',
      },
    };
  }

  return { candidateIds: uniqueCandidateIds, users };
};

const loadExamCandidateAssignments = async (examId) =>
  ExamParticipant.find({ examId, examRole: 'CANDIDATE' })
    .select('userId')
    .lean();

const applyCandidateAssignments = async ({
  exam,
  candidateIds = [],
  mode = 'replace',
  assignedBy = null,
}) => {
  const resolvedMode = resolveAssignmentMode(mode);
  const normalizedCandidateIds = normalizeObjectIdArray(candidateIds);
  const currentAssignments = await loadExamCandidateAssignments(exam._id);
  const currentCandidateIds = currentAssignments.map((assignment) => String(assignment.userId));
  const currentCandidateSet = new Set(currentCandidateIds);
  const requestedCandidateSet = new Set(normalizedCandidateIds);

  let nextCandidateIds;
  if (resolvedMode === 'add') {
    nextCandidateIds = [...new Set([...currentCandidateIds, ...normalizedCandidateIds])];
  } else if (resolvedMode === 'remove') {
    nextCandidateIds = currentCandidateIds.filter((candidateId) => !requestedCandidateSet.has(candidateId));
  } else {
    nextCandidateIds = normalizedCandidateIds;
  }

  const nextCandidateSet = new Set(nextCandidateIds);
  const addedCandidateIds = nextCandidateIds.filter((candidateId) => !currentCandidateSet.has(candidateId));
  const removedCandidateIds = currentCandidateIds.filter((candidateId) => !nextCandidateSet.has(candidateId));

  if (removedCandidateIds.length > 0) {
    await ExamParticipant.deleteMany({
      examId: exam._id,
      examRole: 'CANDIDATE',
      userId: { $in: removedCandidateIds },
    });
  }

  for (const candidateId of addedCandidateIds) {
    const { captureCandidateIdentitySnapshot, applyIdentitySnapshotToParticipant } = await import('../services/offlineEvaluation/examRosterIdentityService.js');
    const snapshot = await captureCandidateIdentitySnapshot({
      tenantId: exam.tenantId,
      userId: candidateId,
      examAcademicContext: exam.academicContext || {},
    });
    const participant = new ExamParticipant({
      examId: exam._id,
      userId: candidateId,
      examRole: 'CANDIDATE',
      assignedBy: assignedBy || exam.createdBy,
      tenantId: exam.tenantId || null,
      ...(snapshot ? { candidateIdentitySnapshot: snapshot } : {}),
    });
    await participant.save();
  }

  exam.candidateCount = nextCandidateIds.length;
  await exam.save();

  return {
    mode: resolvedMode,
    candidateIds: nextCandidateIds,
    addedCandidateIds,
    removedCandidateIds,
  };
};

const buildCandidateAccessibleExamFilter = async ({ tenantId, userId }) => {
  const [assignedExamIds, restrictedExamIds] = await Promise.all([
    ExamParticipant.distinct('examId', {
      tenantId,
      userId,
      examRole: 'CANDIDATE',
    }),
    ExamParticipant.distinct('examId', {
      tenantId,
      examRole: 'CANDIDATE',
    }),
  ]);

  const assignedIds = assignedExamIds.map((value) => String(value));
  const restrictedIds = restrictedExamIds.map((value) => String(value));

  if (restrictedIds.length === 0) {
    return {};
  }

  return {
    $or: [
      { _id: { $in: assignedIds } },
      { _id: { $nin: restrictedIds } },
    ],
  };
};
const DUPLICATE_EXAM_NAME_MESSAGE =
  'Exam name already exists. Please use a different name.';

const resolveTenantIdForExamCreation = (req) => {
  const tenantCandidates = [
    req?.user?.tenantId,
    req?.user?.tenant?._id,
    req?.tenantFilter?.tenantId,
    req?.context?.tenantId,
    req?.body?.tenantId,
  ];

  for (const candidate of tenantCandidates) {
    const normalized = String(candidate ?? '').trim();
    if (!normalized || ['null', 'undefined'].includes(normalized.toLowerCase())) {
      continue;
    }
    if (isValidObjectId(normalized)) {
      return normalized;
    }
  }

  return null;
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildTenantScopedExamNameFilter = ({ title, tenantId, excludeExamId = null }) => {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) {
    return null;
  }

  const filter = {
    title: new RegExp(`^${escapeRegExp(normalizedTitle)}$`, 'i'),
    ...(tenantId ? { tenantId } : { tenantId: { $exists: false } }),
    isActive: true,
  };

  if (excludeExamId) {
    filter._id = { $ne: excludeExamId };
  }

  return filter;
};

const findDuplicateExamByTitle = async ({ title, tenantId, excludeExamId = null }) => {
  const duplicateFilter = buildTenantScopedExamNameFilter({
    title,
    tenantId,
    excludeExamId,
  });
  if (!duplicateFilter) return null;

  return Exam.findOne(duplicateFilter).select('_id').lean();
};

const mergeExamIdExclusion = (filter, excludedExamIds = []) => {
  if (!excludedExamIds.length) return;
  const existing = filter._id && typeof filter._id === 'object' ? filter._id : {};
  filter._id = {
    ...existing,
    $nin: [
      ...(Array.isArray(existing.$nin) ? existing.$nin : []),
      ...excludedExamIds,
    ],
  };
};

const withExamCode = (examDoc) => {
  if (!examDoc) return examDoc;

  const normalized =
    typeof examDoc?.toObject === 'function' ? examDoc.toObject() : { ...examDoc };
  if (!normalized || typeof normalized !== 'object') {
    return normalized;
  }

  const resolvedExamCode = String(
    normalized.exam_code || normalized.uniqueId || normalized.examCode || ''
  ).trim();

  return {
    ...normalized,
    exam_id: normalized._id ? String(normalized._id) : normalized.exam_id || '',
    exam_code: resolvedExamCode,
  };
};

const sanitizeSectionDurationPayload = (sections) => {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('At least one section is required for section-based exams.');
  }

  return sections.map((section, index) => {
    const name = typeof section?.name === 'string' ? section.name.trim() : '';
    if (!name) {
      throw new Error(`Section ${index + 1} name is required.`);
    }

    const duration = toPositiveInt(section?.duration, null);
    if (!duration) {
      throw new Error(`Section ${index + 1} duration must be greater than 0.`);
    }

    return { name, duration };
  });
};

const computeSectionDurationTotal = (sections) =>
  sections.reduce((sum, section) => sum + section.duration, 0);

const toAnswerKeyArray = (answerKey, totalQuestions) => {
  if (Array.isArray(answerKey)) {
    return answerKey;
  }

  if (!answerKey || typeof answerKey !== 'object') {
    return [];
  }

  const result = Array.from({ length: totalQuestions }, () => null);
  Object.entries(answerKey).forEach(([key, value]) => {
    const numericPart = String(key).match(/\d+/);
    if (!numericPart) return;
    const index = Number.parseInt(numericPart[0], 10) - 1;
    if (index < 0 || index >= totalQuestions) return;
    result[index] = value;
  });
  return result;
};

const normalizeAnswerKeyOption = (value, optionsPerQuestion, questionIndex) => {
  const maxLabelIndex = optionsPerQuestion - 1;
  const allowedLabels = OMR_OPTION_LABELS.slice(0, optionsPerQuestion);
  const raw = String(value ?? '').trim().toUpperCase();

  if (!raw) {
    throw new Error(`Answer key missing for question ${questionIndex + 1}.`);
  }

  if (/^\d+$/.test(raw)) {
    const numeric = Number.parseInt(raw, 10);
    if (numeric >= 1 && numeric <= optionsPerQuestion) {
      return OMR_OPTION_LABELS[numeric - 1];
    }
  }

  if (raw.length === 1) {
    const labelIndex = raw.charCodeAt(0) - 65;
    if (labelIndex >= 0 && labelIndex <= maxLabelIndex) {
      return raw;
    }
  }

  throw new Error(
    `Invalid answer key option "${value}" for question ${questionIndex + 1}. Allowed: ${allowedLabels.join(', ')}.`
  );
};

const sanitizeOmrPayload = ({ markingRules = {}, answerKey = [] }) => {
  const totalQuestions = toPositiveInt(markingRules?.totalQuestions, null);
  if (!totalQuestions) {
    throw new Error('OMR exam requires markingRules.totalQuestions > 0.');
  }

  const optionsPerQuestion = toPositiveInt(markingRules?.optionsPerQuestion, 4);
  if (optionsPerQuestion !== MAX_OMR_OPTIONS) {
    throw new Error('OMR optionsPerQuestion must be 4 (A/B/C/D).');
  }

  const marksPerQuestion = toNonNegativeNumber(markingRules?.marksPerQuestion, 1);
  const negativeMarking = Boolean(markingRules?.negativeMarking);
  const negativeMarks = negativeMarking
    ? toNonNegativeNumber(markingRules?.negativeMarks, 0)
    : 0;

  const answerKeyArray = toAnswerKeyArray(answerKey, totalQuestions);
  if (answerKeyArray.length !== totalQuestions) {
    throw new Error(`Answer key must contain exactly ${totalQuestions} entries.`);
  }

  const normalizedAnswerKey = answerKeyArray.map((entry, index) =>
    normalizeAnswerKeyOption(entry, optionsPerQuestion, index)
  );

  return {
    answerKey: normalizedAnswerKey,
    markingRules: {
      totalQuestions,
      optionsPerQuestion,
      marksPerQuestion,
      negativeMarking,
      negativeMarks,
    },
  };
};

const normalizeAutoAssignText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[_/\\|]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeAutoAssign = (value) => {
  const text = normalizeAutoAssignText(value);
  if (!text) return [];
  const stop = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'of',
    'to',
    'in',
    'on',
    'for',
    'with',
    'from',
    'by',
    'is',
    'are',
    'was',
    'were',
    'be',
    'as',
    'at',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'their',
    'your',
    'you',
    'we',
    'they',
  ]);
  const tokens = text
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stop.has(token));
  return Array.from(new Set(tokens));
};

const normalizeQuestionTypeKey = (value) => {
  const raw = normalizeAutoAssignText(value).toUpperCase();
  if (!raw) return '';
  if (['IMAGE', 'IMAGE_BASED'].includes(raw)) return 'IMAGE_BASED';
  return normalizeQuestionType(value) || '';
};

const normalizeDifficultyKey = (value) => {
  const normalized = normalizeAutoAssignText(value);
  if (['easy', 'medium', 'hard'].includes(normalized)) return normalized;
  return normalized || 'medium';
};

const buildSectionContext = (section) => {
  const tagsRaw =
    section?.tags ||
    section?.keywords ||
    section?.metadata?.tags ||
    section?.meta?.tags ||
    section?.tag ||
    [];
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
    : String(tagsRaw || '')
        .split(/[,\n\r;|]+/g)
        .map((tag) => tag.trim())
        .filter(Boolean);
  const subject = normalizeAutoAssignText(
    section?.subject ||
      section?.subjectName ||
      section?.subject_name ||
      section?.metadata?.subject ||
      section?.meta?.subject ||
      ''
  );
  const topic = normalizeAutoAssignText(
    section?.topic ||
      section?.topicName ||
      section?.topic_name ||
      section?.metadata?.topic ||
      section?.meta?.topic ||
      ''
  );
  const name = normalizeAutoAssignText(section?.name || '');
  const instructions = normalizeAutoAssignText(
    section?.instructions || section?.description || section?.overview || ''
  );
  const baseText = [name, subject, topic, tags.join(' '), instructions]
    .filter(Boolean)
    .join(' ')
    .trim();

  const tokens = tokenizeAutoAssign(baseText);

  const rawId =
    section?._id || section?.id || section?.sectionId || section?.section_id || section?.name;
  return {
    id: rawId ? String(rawId) : '',
    name: section?.name || '',
    expectedQuestions: Number.isFinite(Number(section?.expectedQuestions))
      ? Math.max(Number(section.expectedQuestions), 0)
      : 0,
    order: Number.isFinite(Number(section?.order)) ? Number(section.order) : 0,
    subject,
    topic,
    tags,
    tokens,
    tokenSet: new Set(tokens),
  };
};

const buildQuestionMeta = (question, index) => {
  const subject = normalizeAutoAssignText(
    question?.subject ||
      question?.subjectName ||
      question?.subject_name ||
      question?.metadata?.subject ||
      question?.meta?.subject ||
      ''
  );
  const topic = normalizeAutoAssignText(
    question?.topic ||
      question?.topicName ||
      question?.topic_name ||
      question?.metadata?.topic ||
      question?.meta?.topic ||
      ''
  );
  const tagsRaw =
    question?.tags ||
    question?.metadata?.tags ||
    question?.meta?.tags ||
    question?.tag ||
    [];
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
    : String(tagsRaw || '')
        .split(/[,\n\r;|]+/g)
        .map((tag) => tag.trim())
        .filter(Boolean);
  const questionText =
    question?.questionText ||
    question?.question_text ||
    question?.question ||
    question?.text ||
    question?.title ||
    '';
  const passage = question?.passage || '';
  const combinedText = `${questionText} ${passage}`.trim();

  const rawId =
    question?._id ||
    question?.id ||
    question?.questionId ||
    question?.question_id ||
    question?.uniqueId ||
    `local-${index}`;
  return {
    question,
    index,
    id: rawId ? String(rawId) : `local-${index}`,
    subject,
    topic,
    tags,
    subjectTokens: tokenizeAutoAssign(subject),
    topicTokens: tokenizeAutoAssign(topic),
    tagTokens: Array.from(
      new Set(tags.flatMap((tag) => tokenizeAutoAssign(tag)).filter(Boolean))
    ),
    keywordTokens: tokenizeAutoAssign(combinedText),
    typeKey: normalizeQuestionTypeKey(
      question?.questionType || question?.type || question?.question_type || ''
    ),
    difficultyKey: normalizeDifficultyKey(question?.difficulty),
  };
};

const computeTargetCounts = (total, ratios) => {
  const entries = Object.entries(ratios || {}).filter(([, value]) => value > 0);
  if (!total || entries.length === 0) return {};
  const ratioTotal = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!ratioTotal) return {};
  const normalized = entries.map(([key, value], idx) => {
    const exact = (value / ratioTotal) * total;
    return {
      key,
      base: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      index: idx,
    };
  });
  let assigned = normalized.reduce((sum, entry) => sum + entry.base, 0);
  let remaining = Math.max(total - assigned, 0);
  normalized.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  while (remaining > 0) {
    normalized[remaining % normalized.length].base += 1;
    remaining -= 1;
  }
  const result = {};
  normalized.forEach((entry) => {
    result[entry.key] = entry.base;
  });
  return result;
};

const subtractCounts = (targets, existing) => {
  const result = {};
  Object.entries(targets || {}).forEach(([key, value]) => {
    const remaining = Math.max(value - (existing?.[key] || 0), 0);
    if (remaining > 0) {
      result[key] = remaining;
    }
  });
  return result;
};

const runContextAutoAssign = (questions, sections, options = {}) => {
  const safeQuestions = Array.isArray(questions) ? questions : [];
  const safeSections = Array.isArray(sections) ? sections : [];
  const {
    preserveExistingAssignments = true,
    questionTypeDistribution,
    difficultyDistribution,
  } = options;

  if (!safeSections.length) {
    return { sectionAssignments: [], unassignedIds: safeQuestions.map((q, idx) => q?._id || q?.id || `local-${idx}`) };
  }

  const sectionContexts = safeSections
    .map((section) => buildSectionContext(section))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const questionMeta = safeQuestions.map((question, index) => buildQuestionMeta(question, index));
  const assignedQuestionIds = new Set();
  const sectionStats = new Map();
  const assignmentsBySection = new Map();

  const registerAssignment = (meta, sectionId) => {
    if (!sectionId) return;
    const normalizedSectionId = String(sectionId);
    if (!sectionStats.has(normalizedSectionId)) {
      sectionStats.set(normalizedSectionId, { total: 0, types: {}, difficulties: {} });
    }
    const stats = sectionStats.get(normalizedSectionId);
    stats.total += 1;
    stats.types[meta.typeKey] = (stats.types[meta.typeKey] || 0) + 1;
    stats.difficulties[meta.difficultyKey] =
      (stats.difficulties[meta.difficultyKey] || 0) + 1;
    assignedQuestionIds.add(meta.id);
    if (!assignmentsBySection.has(normalizedSectionId)) {
      assignmentsBySection.set(normalizedSectionId, []);
    }
    assignmentsBySection.get(normalizedSectionId).push(meta.id);
  };

  const resolveSectionKey = (question) => {
    const raw =
      question?.sectionId ||
      question?.section_id ||
      question?.assignedSectionId ||
      question?.assignedSectionName ||
      '';
    return raw ? String(raw) : '';
  };

  if (preserveExistingAssignments) {
    questionMeta.forEach((meta) => {
      const sectionId = resolveSectionKey(meta.question);
      if (sectionId) {
        registerAssignment(meta, sectionId);
      }
    });
  }

  const typeRatioMap = {};
  if (questionTypeDistribution && typeof questionTypeDistribution === 'object') {
    Object.entries(questionTypeDistribution).forEach(([key, value]) => {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) {
        typeRatioMap[normalizeQuestionTypeKey(key)] = count;
      }
    });
  } else {
    questionMeta.forEach((meta) => {
      const key = meta.typeKey || 'MULTIPLE_CHOICE';
      typeRatioMap[key] = (typeRatioMap[key] || 0) + 1;
    });
  }

  const difficultyRatioMap = {};
  if (difficultyDistribution && typeof difficultyDistribution === 'object') {
    Object.entries(difficultyDistribution).forEach(([key, value]) => {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) {
        difficultyRatioMap[normalizeDifficultyKey(key)] = count;
      }
    });
  } else {
    questionMeta.forEach((meta) => {
      const key = meta.difficultyKey || 'medium';
      difficultyRatioMap[key] = (difficultyRatioMap[key] || 0) + 1;
    });
  }

  const matchTokens = (tokens, sectionContext, minOverlap, minSim) => {
    if (!tokens || tokens.length === 0) return false;
    const overlap = tokens.filter((token) => sectionContext.tokenSet.has(token)).length;
    const overlapRatio = overlap / Math.max(tokens.length, 1);
    if (overlapRatio >= minOverlap) return true;
    return overlapRatio >= minSim;
  };

  const computeMatch = (meta, sectionContext) => {
    if (meta.subject && sectionContext.subject) {
      if (
        meta.subject === sectionContext.subject ||
        sectionContext.subject.includes(meta.subject) ||
        meta.subject.includes(sectionContext.subject)
      ) {
        return { level: 4, score: 1 };
      }
    }
    if (matchTokens(meta.subjectTokens, sectionContext, 0.45, 0.4)) {
      return { level: 4, score: 0.8 };
    }
    if (meta.topic && sectionContext.topic) {
      if (
        meta.topic === sectionContext.topic ||
        sectionContext.topic.includes(meta.topic) ||
        meta.topic.includes(sectionContext.topic)
      ) {
        return { level: 3, score: 0.75 };
      }
    }
    if (matchTokens(meta.topicTokens, sectionContext, 0.4, 0.35)) {
      return { level: 3, score: 0.6 };
    }
    if (matchTokens(meta.tagTokens, sectionContext, 0.3, 0.3)) {
      return { level: 2, score: 0.5 };
    }
    if (matchTokens(meta.keywordTokens, sectionContext, 0.25, 0.2)) {
      return { level: 1, score: 0.4 };
    }
    return { level: 0, score: 0 };
  };

  const assignments = new Map();

  sectionContexts.forEach((sectionContext) => {
    const expected = sectionContext.expectedQuestions || 0;
    if (!expected) return;
    const existing = sectionStats.get(sectionContext.id) || {
      total: 0,
      types: {},
      difficulties: {},
    };
    let remainingSlots = Math.max(expected - existing.total, 0);
    if (!remainingSlots) return;

    const typeTargets = computeTargetCounts(expected, typeRatioMap);
    const difficultyTargets = computeTargetCounts(expected, difficultyRatioMap);
    const remainingTypeTargets = subtractCounts(typeTargets, existing.types);
    const remainingDifficultyTargets = subtractCounts(
      difficultyTargets,
      existing.difficulties
    );

    const buckets = {
      subject: [],
      topic: [],
      tags: [],
      keywords: [],
    };

    questionMeta.forEach((meta) => {
      if (assignedQuestionIds.has(meta.id)) return;
      const match = computeMatch(meta, sectionContext);
      if (!match.level) return;
      const entry = { meta, score: match.score };
      if (match.level === 4) buckets.subject.push(entry);
      else if (match.level === 3) buckets.topic.push(entry);
      else if (match.level === 2) buckets.tags.push(entry);
      else buckets.keywords.push(entry);
    });

    const fillBucket = (entries) => {
      if (!entries.length || remainingSlots <= 0) return;
      const hasTypeTargets = Object.keys(remainingTypeTargets).length > 0;
      const hasDifficultyTargets = Object.keys(remainingDifficultyTargets).length > 0;
      const ordered = [...entries].sort(
        (a, b) => b.score - a.score || a.meta.index - b.meta.index
      );
      const used = new Set();

      const consume = (candidate) => {
        if (remainingSlots <= 0) return false;
        if (assignedQuestionIds.has(candidate.meta.id) || used.has(candidate.meta.id)) return false;
        assignedQuestionIds.add(candidate.meta.id);
        used.add(candidate.meta.id);
        assignments.set(candidate.meta.index, sectionContext.id);
        if (remainingTypeTargets[candidate.meta.typeKey] !== undefined) {
          remainingTypeTargets[candidate.meta.typeKey] = Math.max(
            remainingTypeTargets[candidate.meta.typeKey] - 1,
            0
          );
        }
        if (remainingDifficultyTargets[candidate.meta.difficultyKey] !== undefined) {
          remainingDifficultyTargets[candidate.meta.difficultyKey] = Math.max(
            remainingDifficultyTargets[candidate.meta.difficultyKey] - 1,
            0
          );
        }
        remainingSlots -= 1;
        return true;
      };

      const runPass = (requireType, requireDifficulty) => {
        for (const candidate of ordered) {
          if (remainingSlots <= 0) break;
          if (used.has(candidate.meta.id)) continue;
          const typeOk =
            !requireType ||
            !hasTypeTargets ||
            (remainingTypeTargets[candidate.meta.typeKey] || 0) > 0;
          const difficultyOk =
            !requireDifficulty ||
            !hasDifficultyTargets ||
            (remainingDifficultyTargets[candidate.meta.difficultyKey] || 0) > 0;
          if (typeOk && difficultyOk) {
            consume(candidate);
          }
        }
      };

      runPass(true, true);
      if (remainingSlots > 0 && hasTypeTargets) runPass(true, false);
      if (remainingSlots > 0 && hasDifficultyTargets) runPass(false, true);
      if (remainingSlots > 0) runPass(false, false);
    };

    fillBucket(buckets.subject);
    fillBucket(buckets.topic);
    fillBucket(buckets.tags);
    fillBucket(buckets.keywords);

    if (remainingSlots > 0 && sectionContext.subject) {
      const subjectFallback = questionMeta
        .filter((meta) => !assignedQuestionIds.has(meta.id))
        .filter((meta) => matchTokens(meta.subjectTokens, sectionContext, 0.25, 0.2))
        .map((meta) => ({ meta, score: 0.2 }));
      fillBucket(subjectFallback);
    }

    if (remainingSlots > 0) {
      const randomFallback = questionMeta
        .filter((meta) => !assignedQuestionIds.has(meta.id))
        .map((meta) => ({ meta, score: 0 }));
      fillBucket(randomFallback);
    }
  });

  assignments.forEach((sectionId, index) => {
    const normalizedSectionId = sectionId ? String(sectionId) : '';
    if (!normalizedSectionId) return;
    if (!assignmentsBySection.has(normalizedSectionId)) {
      assignmentsBySection.set(normalizedSectionId, []);
    }
    assignmentsBySection.get(normalizedSectionId).push(questionMeta[index].id);
  });

  const unassignedIds = questionMeta
    .filter((meta) => !assignedQuestionIds.has(meta.id))
    .map((meta) => meta.id);

  const sectionAssignments = sectionContexts.map((section) => ({
    section_id: section.id,
    assigned_questions: assignmentsBySection.get(section.id) || [],
  }));

  return { sectionAssignments, unassignedIds };
};

// Get all exams (filtered by exam permissions and tenant)
// Universal: Shows exams based on exam context roles, not user system role
router.get('/', requireAuth, requireTenant, enforceTenantBoundaries, sanitizePagination, async (req, res, next) => {
  try {
    const { page, limit, isActive, filterBy, examType, workspace } = req.query;
    const skip = (page - 1) * limit;

    let filter = { ...req.tenantFilter };
    const normalizedExamType = normalizeExamType(examType);
    if (
      normalizedExamType &&
      [ONLINE_EXAM_TYPE, OMR_EXAM_TYPE].includes(normalizedExamType)
    ) {
      filter.examType = normalizedExamType;
    }

    // Tenant Admin is an organization-wide monitor. Operational personas are
    // intentionally narrowed to owned or academically assigned assessments.
    if (hasRole(req.user, 'SUPER_ADMIN') || hasRole(req.user, 'TENANT_ADMIN')) {
      if (isActive !== undefined) {
        filter.isActive = isActive === 'true';
      }
    } else if (hasRole(req.user, 'EXAM_CREATOR') && workspace !== 'teacher') {
      const creatorParticipants = await ExamParticipant.find({ userId: req.user._id, examRole: 'CREATOR' }).distinct('examId');
      filter.$or = [{ createdBy: req.user._id }, { _id: { $in: creatorParticipants } }];
      if (isActive !== undefined) filter.isActive = isActive === 'true';
    } else if (hasRole(req.user, 'TEACHER') || hasRole(req.user, 'ACADEMIC_ADMIN')) {
      const visibility = await resolveAcademicVisibility(req.user);
      if (!visibility.all) {
        filter['academicContext.courseOfferingId'] = { $in: visibility.ids['course-offerings'] || [] };
      }
      if (isActive !== undefined) filter.isActive = isActive === 'true';
    } else {
      // Candidate-facing exam lists should include public exams and private exams
      // only when the signed-in candidate is explicitly assigned.
      const candidateVisibilityFilter = await buildCandidateAccessibleExamFilter({
        tenantId: req.user.tenantId,
        userId: req.user._id,
      });

      if (filterBy === 'created') {
        const participants = await ExamParticipant.find({ userId: req.user._id })
          .select('examId examRole')
          .lean();
        const creatorExamIds = participants
          .filter((p) => p.examRole === 'CREATOR')
          .map((p) => p.examId);
        filter._id = { $in: creatorExamIds };
      } else if (filterBy === 'canEvaluate') {
        const participants = await ExamParticipant.find({ userId: req.user._id })
          .select('examId examRole')
          .lean();
        const evaluatorExamIds = participants
          .filter((p) => p.examRole === 'EVALUATOR')
          .map((p) => p.examId);
        filter._id = { $in: evaluatorExamIds };
      } else {
        if (Object.keys(candidateVisibilityFilter).length > 0) {
          Object.assign(filter, candidateVisibilityFilter);
        }
        const exhaustedExamIds = await resolveAttemptExhaustedExamIds({
          userId: req.user._id,
          tenantId: req.user.tenantId,
        });
        mergeExamIdExclusion(filter, exhaustedExamIds);
        if (isActive !== undefined) {
          filter.isActive = isActive === 'true';
        } else {
          filter.isActive = true;
        }
      }
    }

    const exams = await Exam.find(filter)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Exam.countDocuments(filter);
    res.json({
      exams: exams.map((exam) => withExamCode(exam)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Unified exam submit endpoint used by candidate exam page.
router.post(
  '/submit',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  auditLog(AUDIT_ACTIONS.ATTEMPT_SUBMITTED, (req) => ({
    examId: req.body?.examId,
    userId: req.body?.userId || req.user?._id,
    isDisqualified: req.body?.isDisqualified || false,
  })),
  [
    body('examId').isMongoId().withMessage('examId must be a valid id'),
    body('userId').optional().isMongoId().withMessage('userId must be a valid id'),
    body('attemptId').optional().isMongoId().withMessage('attemptId must be a valid id'),
    body('answers').optional().isObject().withMessage('Answers must be an object'),
    body('codingSubmissions').optional().isArray().withMessage('codingSubmissions must be an array'),
    body('codingAnswers').optional().isArray().withMessage('codingAnswers must be an array'),
    body('timerMeta').optional().isObject().withMessage('timerMeta must be an object'),
    body('submissionSource').optional().isString().withMessage('submissionSource must be a string'),
    body('disqualifyStatus').optional().isString().withMessage('disqualifyStatus must be a string'),
    body('violationType').optional().isString().withMessage('violationType must be a string'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const requestedUserId = req.body?.userId || req.user._id;
      if (String(requestedUserId) !== String(req.user._id)) {
        return res.status(403).json({
          error: 'Forbidden - You can only submit exams for your own account',
        });
      }

      const examFilter = {
        _id: req.body.examId,
        ...(req.tenantFilter || {}),
      };
      const exam = await Exam.findOne(examFilter).select('_id').lean();
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const attemptFilter = {
        examId: exam._id,
        userId: requestedUserId,
        ...(req.body.attemptId
          ? { _id: req.body.attemptId }
          : { isCompleted: false }),
      };
      if (req.tenantFilter?.tenantId) {
        attemptFilter.tenantId = req.tenantFilter.tenantId;
      }

      let attempt = await ExamAttempt.findOne(attemptFilter)
        .sort({ startTime: -1 })
        .select('_id')
        .lean();

      if (!attempt && !req.body.attemptId) {
        const completedFilter = {
          examId: exam._id,
          userId: requestedUserId,
          isCompleted: true,
        };
        if (req.tenantFilter?.tenantId) {
          completedFilter.tenantId = req.tenantFilter.tenantId;
        }

        attempt = await ExamAttempt.findOne(completedFilter)
          .sort({ submitTime: -1, updatedAt: -1 })
          .select('_id')
          .lean();
      }

      if (!attempt?._id) {
        return res.status(404).json({ error: 'Exam attempt not found' });
      }

      req.params.attemptId = attempt._id.toString();
      return submitAttemptHandler(req, res, next);
    } catch (error) {
      console.error('Exam submission error:', error);
      return next(error);
    }
  }
);

// Get single exam
// Universal: Access based on exam permissions, not user role
// Preview exam paper (questions without answers) - for admin preview
router.get('/:examId/preview', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.examId, ...(req.tenantFilter || {}) });
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const mayPreview = hasRole(req.user, 'TENANT_ADMIN') || await canOperateExam(req.user, exam);
    if (!mayPreview) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get question papers
    const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
    const questionPapers = await QuestionPaper.find({ examId: exam._id, isActive: true });

    // Get questions for preview (without correct answers)
    const Question = (await import('../models/Question.js')).default;
    const Section = (await import('../models/Section.js')).default;

    const previewData = {
      exam: {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        duration: exam.duration,
        passingPercentage: exam.passingPercentage,
      },
      questionPapers: [],
    };

    for (const qp of questionPapers) {
      const sections = await Section.find({ questionPaperId: qp._id, isActive: true })
        .sort({ order: 1 })
        .lean();

      const allQuestions = await Question.find({ questionPaperId: qp._id })
        .select('-correctAnswer') // Exclude correct answer
        .sort({ order: 1 });

      // Pool questions (isIncludedInExam: false) are not part of the
      // published paper — exclude them from the preview, same as what a
      // candidate would actually see, and surface the count separately.
      const questions = allQuestions.filter((q) => q.isIncludedInExam !== false);
      const unassignedCount = allQuestions.length - questions.length;

      await ensureQuestionsImageAvailability({
        questions,
        tenantId: req.user?.tenantId,
        examId: req.params.examId,
        persist: true,
      });

      // Live per-section counts/marks — Section.marks is only a legacy
      // write-once snapshot and goes stale as questions are added/moved.
      const questionsBySection = new Map();
      questions.forEach((q) => {
        const key = q.sectionId ? String(q.sectionId) : null;
        if (!key) return;
        const bucket = questionsBySection.get(key) || { count: 0, marks: 0 };
        bucket.count += 1;
        bucket.marks += Number(q.points) || 0;
        questionsBySection.set(key, bucket);
      });

      previewData.questionPapers.push({
        _id: qp._id,
        setName: qp.setName,
        unassignedCount,
        sections: sections.map(s => {
          const stats = questionsBySection.get(String(s._id)) || { count: 0, marks: 0 };
          return {
            _id: s._id,
            name: s.name,
            description: s.description,
            order: s.order,
            duration: s.duration,
            marks: stats.marks,
            marksPerQuestion: s.marksPerQuestion,
            expectedQuestions: s.expectedQuestions,
            assignedQuestionCount: stats.count,
            negativeMarking: s.negativeMarking,
          };
        }),
        questions: questions.map((q) => {
          const sanitizedOptions = sanitizeQuestionOptions(q.options);
          return {
            _id: q._id,
            question: q.questionText,
            questionText: q.questionText,
            question_text: q.questionText,
            questionType: q.questionType,
            options: sanitizedOptions,
            points: q.points,
            order: q.order,
            sectionId: q.sectionId,
            passage: q.passage,
            paragraphGroupId: q.paragraphGroupId || '',
            image: q.imageUrl || q.generatedImage || q.imageBase64 || '',
            imageUrl: q.imageUrl,
            image_path: q.imageUrl || '',
            imageBase64: q.imageBase64,
            image_base64: q.imageBase64 || '',
            generatedImage: q.generatedImage,
            generated_image: q.generatedImage || '',
          };
        }),
      });
    }

    // Log audit
    await logAuditEvent(AUDIT_ACTIONS.EXAM_PREVIEWED || 'EXAM_PREVIEWED', {
      userId: req.user._id,
      userEmail: req.user.email,
      userName: req.user.name,
      userRole: req.user.role,
      tenantId: exam.tenantId || null,
      resourceType: 'Exam',
      resourceId: exam._id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      method: req.method,
      path: req.path,
    });

    res.json(previewData);
  } catch (error) {
    next(error);
  }
});

// Audit exam structure - check for inconsistencies
router.get('/:examId/audit', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.examId, ...(req.tenantFilter || {}) });
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    const mayAudit = hasRole(req.user, 'TENANT_ADMIN') || await canOperateExam(req.user, exam);
    if (!mayAudit) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
    const Question = (await import('../models/Question.js')).default;
    const Section = (await import('../models/Section.js')).default;

    const questionPapers = await QuestionPaper.find({ examId: exam._id, isActive: true });
    const auditResults = {
      examId: exam._id,
      examTitle: exam.title,
      issues: [],
      warnings: [],
      summary: {
        totalQuestionPapers: questionPapers.length,
        totalSections: 0,
        totalQuestions: 0,
        sectionsWithoutQuestions: 0,
        questionsWithoutSections: 0,
      },
    };

    for (const qp of questionPapers) {
      const sections = await Section.find({ questionPaperId: qp._id, isActive: true })
        .sort({ order: 1 })
        .lean();

      const questions = await Question.find({ questionPaperId: qp._id }).lean();

      auditResults.summary.totalSections += sections.length;
      auditResults.summary.totalQuestions += questions.length;

      // Check for sections without questions
      for (const section of sections) {
        const sectionQuestions = questions.filter(q =>
          q.sectionId && q.sectionId.toString() === section._id.toString()
        );
        if (sectionQuestions.length === 0) {
          auditResults.warnings.push({
            type: 'SECTION_WITHOUT_QUESTIONS',
            severity: 'warning',
            message: `Section "${section.name}" in question paper "${qp.setName}" has no questions`,
            questionPaperId: qp._id,
            sectionId: section._id,
          });
          auditResults.summary.sectionsWithoutQuestions++;
        }
      }

      // Check for questions without sections
      const questionsWithoutSection = questions.filter(q => !q.sectionId);
      if (questionsWithoutSection.length > 0) {
        auditResults.warnings.push({
          type: 'QUESTIONS_WITHOUT_SECTIONS',
          severity: 'warning',
          message: `${questionsWithoutSection.length} question(s) in question paper "${qp.setName}" are not assigned to any section`,
          questionPaperId: qp._id,
          count: questionsWithoutSection.length,
        });
        auditResults.summary.questionsWithoutSections += questionsWithoutSection.length;
      }

      // Check for missing expected questions
      for (const section of sections) {
        if (section.expectedQuestions) {
          const sectionQuestions = questions.filter(q =>
            q.sectionId && q.sectionId.toString() === section._id.toString()
          );
          if (sectionQuestions.length !== section.expectedQuestions) {
            auditResults.warnings.push({
              type: 'QUESTION_COUNT_MISMATCH',
              severity: 'warning',
              message: `Section "${section.name}" has ${sectionQuestions.length} questions but expected ${section.expectedQuestions}`,
              questionPaperId: qp._id,
              sectionId: section._id,
              expected: section.expectedQuestions,
              actual: sectionQuestions.length,
            });
          }
        }
      }
    }

    // Check if exam has no question papers
    if (questionPapers.length === 0) {
      auditResults.issues.push({
        type: 'NO_QUESTION_PAPERS',
        severity: 'error',
        message: 'Exam has no question papers assigned',
      });
    }

    // Log audit
    await logAuditEvent(AUDIT_ACTIONS.EXAM_AUDITED || 'EXAM_AUDITED', {
      userId: req.user._id,
      userEmail: req.user.email,
      userName: req.user.name,
      userRole: req.user.role,
      tenantId: exam.tenantId || null,
      resourceType: 'Exam',
      resourceId: exam._id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      method: req.method,
      path: req.path,
      details: {
        issuesFound: auditResults.issues.length,
        warningsFound: auditResults.warnings.length,
      },
    });

    res.json(auditResults);
  } catch (error) {
    next(error);
  }
});

router.get('/:examId', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId).populate(
      'createdBy',
      'name email'
    );

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }

    if (hasRole(req.user, 'SUPER_ADMIN')) {
      return res.json({ exam: withExamCode(exam) });
    }

    if (hasRole(req.user, 'TENANT_ADMIN')) {
      const userTenantId = req.user.tenantId;
      const examTenantId = exam.tenantId;

      if (userTenantId && examTenantId && userTenantId.toString() === examTenantId.toString()) {
        return res.json({ exam: withExamCode(exam) });
      }
    }

    if (await canOperateExam(req.user, exam)) {
      return res.json({ exam: withExamCode(exam) });
    }

    // Candidate users can only see public exams or the exams they were assigned to.
    const canAccessExam = await canCandidateAccessExam(req.user._id, exam._id);
    if (!canAccessExam) {
      return res.status(403).json({ error: 'You do not have access to this exam' });
    }

    // Candidates can only see active exams, matching existing availability behavior.
    if (!exam.isActive) {
      return res.status(403).json({ error: 'Exam is not currently available' });
    }

    res.json({ exam: withExamCode(exam) });
  } catch (error) {
    next(error);
  }
});

/**
 * Create exam - Only EXAM_CREATOR can create exams
 * 
 * Simple flow:
 * 1. User must be EXAM_CREATOR role
 * 2. User must belong to a tenant (except SUPER_ADMIN)
 * 3. Exam is created with user's tenantId
 * 4. ExamParticipant record is auto-created with CREATOR role
 */
router.post(
  '/',
  requireAuth,
  requireTenant, // Ensure user belongs to a tenant (except SUPER_ADMIN)
  requireRole('EXAM_CREATOR'),
  checkExamCreationLimit,
  auditLog(AUDIT_ACTIONS.EXAM_CREATED, (req, res) => ({
    resourceType: 'Exam',
    resourceId: res.locals.examId, // Will be set after creation
    examTitle: res.locals.examTitle || req.body.title,
    tenantId: res.locals.tenantId || req.user?.tenantId || null,
  })),
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('duration').optional().isInt({ min: 1 }).withMessage('Duration must be a positive number'),
    body('gracePeriod').optional().isInt({ min: 0 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
    body('showResultsImmediately').optional().isBoolean(),
    body('examType').optional().isString(),
    // Master Phase 4 — independent of examType (ONLINE/OMR). See
    // docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md Part 13.
    body('deliveryMode').optional().isIn(['ONLINE', 'OFFLINE', 'HYBRID']),
    body('sections').optional().isArray(),
    body('timingMode').optional().isIn(['overall', 'section_based']),
    body('evaluationMode').optional().isIn(['AUTOMATIC', 'AI_OPTIONAL_REVIEW', 'AI_MANDATORY_REVIEW', 'MANUAL', 'HYBRID']),
    body('allowDurationOverride').optional().isBoolean(),
    body('markingRules').optional().isObject(),
    body('answerKey').optional(),
    body('omrTemplateImage').optional().isString(),
    body('instructions').optional().isString(),
    body('totalMarks').optional().isFloat({ min: 0 }),
    body('subTenantId')
      .optional({ nullable: true })
      .custom((value) => value === null || value === '' || isValidObjectId(value))
      .withMessage('subTenantId must be a valid id when provided'),
    body('accessControl').optional().isObject().withMessage('accessControl must be an object'),
    body('candidateIds').optional().isArray().withMessage('candidateIds must be an array'),
    body('assignedCandidates').optional().isArray().withMessage('assignedCandidates must be an array'),
    body('candidateAssignmentMode')
      .optional()
      .isIn(['replace'])
      .withMessage('candidateAssignmentMode must be replace when provided during creation'),
    body('creationMode').optional({ nullable: true }).isIn(['QUICK', 'ACADEMIC']),
    body('assessmentPurpose').optional().isIn(['OF', 'FOR', 'AS']),
    body('academicContext').optional().isObject(),
    body('creatorOverrides').optional().isObject(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const resolvedTenantId = resolveTenantIdForExamCreation(req);
      if (req.user.role !== 'SUPER_ADMIN' && !resolvedTenantId) {
        return res.status(403).json({
          error:
            'Your account is not assigned to a tenant workspace yet. Please contact your Super Admin before creating exams.',
        });
      }
      if (!resolvedTenantId) {
        return res.status(400).json({
          error: 'tenantId is required before creating an exam.',
        });
      }

      const {
        title,
        description,
        instructions,
        duration,
        gracePeriod,
        maxAttempts,
        isActive,
        showResultsImmediately,
        allowCertification,
        passingPercentage,
        certificateTemplate,
        examType,
        deliveryMode,
        sections,
        timingMode,
        allowDurationOverride,
        evaluationMode,
        answerKey,
        markingRules,
        omrTemplateImage,
        totalMarks,
        subTenantId,
        accessControl,
        creationMode = null,
        assessmentPurpose = 'OF',
        assessmentType = 'EXAM',
        academicContext = {},
        frameworkId = null,
        frameworkVersionId = null,
        rubricTemplateId = null,
        rubricTemplateIds = [],
        creatorOverrides = {},
      } =
        req.body;

      const duplicateExam = await findDuplicateExamByTitle({
        title,
        tenantId: resolvedTenantId,
      });
      if (duplicateExam) {
        return res.status(409).json({
          success: false,
          message: DUPLICATE_EXAM_NAME_MESSAGE,
        });
      }

      const candidatePayload = parseCandidateIdPayload(req.body?.candidateIds || req.body?.assignedCandidates);
      if (candidatePayload.invalidIds.length > 0 || candidatePayload.duplicateIds.length > 0) {
        return res.status(400).json({
          error: candidatePayload.invalidIds.length > 0
            ? 'candidateIds must contain only valid user IDs.'
            : 'candidateIds must not contain duplicates.',
        });
      }

      const candidateResolution =
        candidatePayload.candidateIds.length > 0
          ? await resolveCandidateUsersForTenant(candidatePayload.candidateIds, resolvedTenantId)
          : { candidateIds: [] };
      if (candidateResolution.error) {
        return res.status(candidateResolution.error.status).json({
          error: candidateResolution.error.message,
        });
      }

      const effectivePlanType =
        req.planLimitContext?.planType ||
        (await resolveUserEffectivePlanType(req.user));

      const requestedDuration = toPositiveInt(duration, null);
      const requestedExamType = normalizeExamType(examType);
      const isOmrRequest = requestedExamType === OMR_EXAM_TYPE;
      const sectionPayloadProvided = Array.isArray(sections);
      const sectionBasedRequest =
        !isOmrRequest &&
        (requestedExamType === SECTION_BASED_EXAM_TYPE || sectionPayloadProvided);

      if (!isPlanFeatureEnabled(effectivePlanType, 'omr') && isOmrRequest) {
        return sendPlanRestriction(res, FREE_PLAN_MESSAGES.OMR_LOCKED);
      }

      if (isOmrRequest && sectionPayloadProvided) {
        return res.status(400).json({
          error: 'Sections are not supported for OMR exams.',
        });
      }

      let resolvedDuration = requestedDuration;
      let safeOmrPayload = null;

      if (isOmrRequest) {
        try {
          safeOmrPayload = sanitizeOmrPayload({
            markingRules,
            answerKey,
          });
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }
      }

      if (sectionBasedRequest) {
        let safeSections;
        try {
          safeSections = sanitizeSectionDurationPayload(sections);
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }

        const computedDuration = computeSectionDurationTotal(safeSections);
        const durationOverrideAllowed = allowDurationOverride === true;
        if (
          requestedDuration !== null &&
          requestedDuration !== computedDuration &&
          !durationOverrideAllowed
        ) {
          return res.status(400).json({
            error: `Duration mismatch for section-based exam. Expected ${computedDuration} minutes from sections.`,
          });
        }
        resolvedDuration =
          durationOverrideAllowed && requestedDuration !== null ? requestedDuration : computedDuration;
      }

      if (resolvedDuration === null) {
        if (isOmrRequest) {
          resolvedDuration = 60;
        } else {
          return res.status(400).json({ error: 'Duration must be a positive number.' });
        }
      }

      let resolvedSubTenantId = null;
      if (subTenantId !== undefined && subTenantId !== null && String(subTenantId).trim() !== '') {
        if (!isPlanFeatureEnabled(effectivePlanType, 'multiTenant')) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.MULTI_TENANT_LOCKED);
        }

        if (!req.user?.tenantId) {
          return res.status(403).json({ error: 'A tenant is required when assigning sub-tenant scope.' });
        }

        const subTenant = await SubTenant.findOne({
          _id: subTenantId,
          tenantId: req.user.tenantId,
          status: 'ACTIVE',
        })
          .select('_id')
          .lean();
        if (!subTenant) {
          return res.status(404).json({ error: 'Sub-tenant not found for this workspace.' });
        }
        resolvedSubTenantId = subTenant._id;
      }

      let sanitizedAccessControl = null;
      if (accessControl !== undefined) {
        sanitizedAccessControl = sanitizeExamAccessControlPayload(accessControl);

        const hasIpWhitelistRules = Array.isArray(sanitizedAccessControl.ipWhitelist)
          && sanitizedAccessControl.ipWhitelist.length > 0;
        if (hasIpWhitelistRules && !isPlanFeatureEnabled(effectivePlanType, 'ipWhitelist')) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.IP_WHITELIST_LOCKED);
        }

        const hasGeoRestrictions = Boolean(
          sanitizedAccessControl?.geoRestrictions?.enabled &&
          (
            sanitizedAccessControl.geoRestrictions.allowedCountries.length > 0 ||
            sanitizedAccessControl.geoRestrictions.allowedRegions.length > 0
          )
        );
        if (hasGeoRestrictions && !isPlanFeatureEnabled(effectivePlanType, 'geoLocationRestriction')) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.GEO_LOCKED);
        }

        if (
          sanitizedAccessControl?.secureBrowser?.enabled === true &&
          !isPlanFeatureEnabled(effectivePlanType, 'secureBrowser')
        ) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.SECURE_BROWSER_LOCKED);
        }
      }

      const requestedEvaluationMode = typeof evaluationMode === 'string' ? evaluationMode : 'AUTOMATIC';
      if (requestedEvaluationMode !== 'AUTOMATIC') {
        if (!isPlanFeatureEnabled(effectivePlanType, 'examinerReview')) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.EXAMINER_REVIEW_LOCKED);
        }
        if (
          ['AI_MANDATORY_REVIEW', 'MANUAL', 'HYBRID'].includes(requestedEvaluationMode) &&
          !isPlanFeatureEnabled(effectivePlanType, 'mandatoryVerification')
        ) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.MANDATORY_VERIFICATION_LOCKED);
        }
      }

      let resolvedSpecification;
      try {
        resolvedSpecification = await resolveAssessmentSpecification({
          tenantId: resolvedTenantId, purpose: assessmentPurpose, academicContext,
          assessmentType, frameworkId, frameworkVersionId, creatorOverrides,
        });
      } catch (error) {
        return res.status(error.statusCode || error.status || 400).json({ error: error.message });
      }

      if (resolvedSpecification.academicContext?.courseOfferingId) {
        const canAuthorContext = await canAuthorInCourseOffering(req.user, resolvedSpecification.academicContext.courseOfferingId);
        if (!canAuthorContext) {
          return res.status(403).json({
            error: 'You are not assigned to create assessments for the selected course offering. Contact Academic Admin.',
            code: 'ACADEMIC_AUTHORING_SCOPE_REQUIRED',
          });
        }
      }

      const selectedRubricIds = [...new Set([
        ...(Array.isArray(rubricTemplateIds) ? rubricTemplateIds : []),
        rubricTemplateId,
      ].filter(Boolean).map(String))];
      let rubricSnapshots = [];
      if (selectedRubricIds.length) {
        const publishedRubrics = await RubricTemplate.find({
          _id: { $in: selectedRubricIds },
          tenantId: resolvedTenantId,
          status: 'PUBLISHED',
        }).lean();
        if (publishedRubrics.length !== selectedRubricIds.length) {
          return res.status(400).json({ error: 'Every selected rubric must be a published template in this tenant.' });
        }
        // The picker is scoped, but the create route must independently
        // reject a tampered rubric id from another delegated academic scope.
        // Tenant membership alone is never sufficient authority to attach a
        // rubric to an assessment.
        const rubricVisibility = await resolveAcademicVisibility(req.user);
        const outOfScopeRubric = publishedRubrics.find(
          (rubric) => !isGovernanceScopeReadable(rubricVisibility, rubric.applicability || {})
        );
        if (outOfScopeRubric) {
          return res.status(403).json({ error: 'One or more selected rubrics are outside your delegated academic scope.' });
        }
        const rubricById = new Map(publishedRubrics.map((rubric) => [String(rubric._id), rubric]));
        rubricSnapshots = selectedRubricIds.map((templateId) => {
          const publishedRubric = rubricById.get(templateId);
          return {
            templateId: String(publishedRubric._id),
            name: publishedRubric.name,
            version: publishedRubric.version,
            criteria: publishedRubric.criteria,
            capturedAt: new Date().toISOString(),
          };
        });
      }
      const rubricSnapshot = rubricSnapshots[0] || null;
      const primaryRubricTemplateId = selectedRubricIds[0] || null;

      // Resolve and persist tenant scope for exam creation.
      const examData = {
        title,
        description,
        instructions: typeof instructions === 'string' ? instructions.trim() : '',
        duration: resolvedDuration,
        gracePeriod: gracePeriod || 0,
        maxAttempts: maxAttempts || 1,
        isActive: isActive !== undefined ? isActive : true,
        showResultsImmediately: Boolean(showResultsImmediately),
        allowCertification: Boolean(allowCertification),
        passingPercentage: passingPercentage !== undefined
          ? Math.max(0, Math.min(100, parseInt(passingPercentage) || 60))
          : 60,
        certificateTemplate: allowCertification ? (certificateTemplate || null) : null,
        examType: isOmrRequest ? OMR_EXAM_TYPE : ONLINE_EXAM_TYPE,
        deliveryMode: ['ONLINE', 'OFFLINE', 'HYBRID'].includes(deliveryMode) ? deliveryMode : 'ONLINE',
        timingMode: sectionBasedRequest ? 'section_based' : 'overall',
        allowDurationOverride: sectionBasedRequest ? Boolean(allowDurationOverride) : false,
        evaluationMode: requestedEvaluationMode,
        totalMarks: Number.isFinite(Number(totalMarks)) ? Math.max(0, Number(totalMarks)) : 0,
        createdBy: req.user._id,
        tenantId: resolvedTenantId,
        creationMode: ['QUICK', 'ACADEMIC'].includes(creationMode) ? creationMode : null,
        assessmentPurpose: resolvedSpecification.purpose,
        assessmentType: resolvedSpecification.assessmentType,
        academicContext: resolvedSpecification.academicContext,
        frameworkId: frameworkId || null,
        frameworkVersionId: resolvedSpecification.frameworkVersion?.id || null,
        rubricTemplateId: primaryRubricTemplateId,
        rubricSnapshot,
        rubricTemplateIds: selectedRubricIds,
        rubricSnapshots,
        resolvedSpecificationSnapshot: resolvedSpecification,
        resolvedSpecificationAt: new Date(),
      };

      if (resolvedSubTenantId) {
        examData.subTenantId = resolvedSubTenantId;
      }

      if (sanitizedAccessControl) {
        examData.accessControl = sanitizedAccessControl;
      }

      if (isOmrRequest) {
        examData.answerKey = safeOmrPayload.answerKey;
        examData.markingRules = safeOmrPayload.markingRules;
        examData.omrTemplateImage = String(omrTemplateImage || '').trim();
      }

      const exam = new Exam(examData);
      // Institutional paper template (Phase 1A) — additive & optional. When the
      // creator selected an APPROVED template, resolve it (template + branding +
      // permitted overrides) and deep-freeze it onto the exam now; it is
      // write-once, so later branding/template edits never alter this paper.
      // No template selected ⇒ nothing changes.
      if (req.body.paperTemplateId) {
        try {
          await freezePaperTemplateOntoExam(exam, {
            templateId: req.body.paperTemplateId,
            overrides: req.body.paperTemplateOverrides,
          });
        } catch (error) {
          if (error instanceof PaperTemplateError) {
            return res.status(error.status).json({ error: error.message, code: error.code });
          }
          throw error;
        }
      }
      await exam.save();
      await exam.populate('createdBy', 'name email');

      if (candidateResolution.candidateIds.length > 0) {
        const assignmentResult = await applyCandidateAssignments({
          exam,
          candidateIds: candidateResolution.candidateIds,
          mode: 'replace',
          assignedBy: req.user._id,
        });
        exam.candidateCount = assignmentResult.candidateIds.length;

        await logAuditEvent(AUDIT_ACTIONS.EXAM_CANDIDATES_ASSIGNED, {
          userId: req.user._id,
          userEmail: req.user.email,
          userName: req.user.name,
          userRole: req.user.role,
          tenantId: exam.tenantId || null,
          resourceType: 'Exam',
          resourceId: exam._id,
          method: req.method,
          path: req.path,
          candidateIds: assignmentResult.candidateIds,
          mode: 'replace',
        });
      }

      // UNIVERSAL: Auto-create ExamParticipant with CREATOR role
      // This enables exam-context permissions instead of role-based assumptions
      await ensureExamParticipant(
        req.user._id,
        exam._id,
        'CREATOR',
        req.user._id
      );


      // Keep denormalized creator counters in sync for plan enforcement.
      await syncUserExamCount(req.user._id);

      try {
        const { createRoleNotification } = await import('../services/notificationService.js');
        const creatorName = req.user.name || req.user.email || 'Exam creator';
        const basePayload = {
          title: 'Exam Created',
          message: `Exam "${exam.title}" was created by ${creatorName}.`,
          type: 'exam_created',
          tenantId: exam.tenantId || null,
          examId: exam._id,
          createdBy: req.user._id,
          metadata: {
            examId: exam._id,
            examTitle: exam.title,
          },
        };

        if (exam.tenantId) {
          await createRoleNotification({ ...basePayload, roles: ['TENANT_ADMIN'] });
          await createRoleNotification({ ...basePayload, roles: ['EXAM_CREATOR'] });
        }
        await createRoleNotification({ ...basePayload, roles: ['SUPER_ADMIN'] });
      } catch (notifyError) {
        console.error('[NOTIFICATIONS] Failed to log exam creation:', notifyError?.message || notifyError);
      }

      // Store exam ID for audit log
      res.locals.examId = exam._id.toString();
      res.locals.examTitle = exam.title;
      res.locals.tenantId = exam.tenantId || null;

      // Non-blocking automatic package generation for online exams.
      if (exam.examType !== OMR_EXAM_TYPE) {
        queueExamPackageRegeneration({
          examId: exam._id,
          userId: req.user._id,
          reason: 'EXAM_CREATED',
          forceRegenerate: true,
          examUpdatedAt: exam.updatedAt,
        });
      }

      res.status(201).json({ exam: withExamCode(exam) });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:examId/delivery-mode',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR', 'TENANT_ADMIN'),
  [body('deliveryMode').isIn(['ONLINE', 'OFFLINE', 'HYBRID'])],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      if (hasRole(req.user, 'TENANT_ADMIN') && !hasAnyRole(req.user, ['ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'])) {
        return res.status(403).json({ error: 'Tenant Admin monitors operations and cannot change assessment delivery mode.' });
      }
      const exam = await Exam.findOne({ _id: req.params.examId, tenantId: req.user.tenantId });
      if (!exam) return res.status(404).json({ error: 'Assessment not found.' });
      if (!(await canOperateExam(req.user, exam))) {
        return res.status(403).json({ error: 'You can change delivery mode only for an assigned class or an assessment you own.' });
      }
      const requested = String(req.body.deliveryMode).toUpperCase();
      const scriptCount = await countAnswerScriptsForExam({ tenantId: req.user.tenantId, examId: exam._id });
      const gate = canChangeExamDeliveryMode({ exam, answerScriptCount: scriptCount });
      if (!gate.allowed) return res.status(409).json({ error: gate.message, code: gate.code });
      if (gate.restrictTo && !gate.restrictTo.includes(requested)) {
        return res.status(409).json({ error: gate.message || 'That delivery mode is not allowed for this assessment.' });
      }
      const previous = exam.deliveryMode || 'ONLINE';
      exam.deliveryMode = requested;
      await exam.save();
      await logAuditEvent('EXAM_UPDATED', {
        userId: req.user._id,
        tenantId: req.user.tenantId,
        resourceType: 'Exam',
        resourceId: exam._id,
        details: { field: 'deliveryMode', from: previous, to: requested },
      });
      return res.json({ exam: { _id: exam._id, deliveryMode: exam.deliveryMode } });
    } catch (error) {
      return next(error);
    }
  }
);

// Update exam - Only EXAM_CREATOR who owns the exam or SUPER_ADMIN can update
// Simple permission: EXAM_CREATOR can update their own exams within their tenant
router.put(
  '/:examId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin, // Checks EXAM_CREATOR ownership or SUPER_ADMIN
  [
    body('title').optional().trim().notEmpty(),
    body('duration').optional().isInt({ min: 1 }),
    body('gracePeriod').optional().isInt({ min: 0 }),
    body('maxAttempts').optional().isInt({ min: 1 }),
    body('showResultsImmediately').optional().isBoolean(),
    body('examType').optional().isString(),
    // Master Phase 4 — independent of examType (ONLINE/OMR). See
    // docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md Part 13.
    body('deliveryMode').optional().isIn(['ONLINE', 'OFFLINE', 'HYBRID']),
    body('sections').optional().isArray(),
    body('timingMode').optional().isIn(['overall', 'section_based']),
    body('evaluationMode').optional().isIn(['AUTOMATIC', 'AI_OPTIONAL_REVIEW', 'AI_MANDATORY_REVIEW', 'MANUAL', 'HYBRID']),
    body('allowDurationOverride').optional().isBoolean(),
    body('markingRules').optional().isObject(),
    body('answerKey').optional(),
    body('omrTemplateImage').optional().isString(),
    body('instructions').optional().isString(),
    body('totalMarks').optional().isFloat({ min: 0 }),
    body('subTenantId')
      .optional({ nullable: true })
      .custom((value) => value === null || value === '' || isValidObjectId(value))
      .withMessage('subTenantId must be a valid id when provided'),
    body('accessControl').optional().isObject().withMessage('accessControl must be an object'),
    body('candidateIds').optional().isArray().withMessage('candidateIds must be an array'),
    body('assignedCandidates').optional().isArray().withMessage('assignedCandidates must be an array'),
    body('candidateAssignmentMode')
      .optional()
      .isIn(['add', 'remove', 'replace'])
      .withMessage('candidateAssignmentMode must be add, remove, or replace'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const hasCandidateAssignmentUpdate = Object.prototype.hasOwnProperty.call(
        req.body || {},
        'candidateIds'
      ) || Object.prototype.hasOwnProperty.call(
        req.body || {},
        'assignedCandidates'
      );
      const candidateIds = req.body?.candidateIds || req.body?.assignedCandidates;
      const candidateAssignmentMode = req.body?.candidateAssignmentMode;
      const requestedAssignmentMode = resolveAssignmentMode(candidateAssignmentMode);
      const candidatePayload = parseCandidateIdPayload(candidateIds);
      if (hasCandidateAssignmentUpdate && (candidatePayload.invalidIds.length > 0 || candidatePayload.duplicateIds.length > 0)) {
        return res.status(400).json({
          error: candidatePayload.invalidIds.length > 0
            ? 'candidateIds must contain only valid user IDs.'
            : 'candidateIds must not contain duplicates.',
        });
      }
      const requestedCandidateIds = candidatePayload.candidateIds;
      const shouldValidateCandidateAssignments =
        hasCandidateAssignmentUpdate &&
        (requestedCandidateIds.length > 0 || requestedAssignmentMode === 'replace');
      let candidateValidation = { candidateIds: [] };
      if (shouldValidateCandidateAssignments) {
        candidateValidation = await resolveCandidateUsersForTenant(
          requestedCandidateIds,
          exam.tenantId
        );
        if (candidateValidation.error) {
          return res.status(candidateValidation.error.status).json({
            error: candidateValidation.error.message,
          });
        }
      }

      const examPlanContext = await resolveExamPlanContext(exam._id);
      const effectivePlanType =
        examPlanContext?.planType ||
        req.planLimitContext?.planType ||
        (await resolveUserEffectivePlanType(req.user));

      const beforeState = {
        title: exam.title,
        description: exam.description,
        instructions: exam.instructions,
        duration: exam.duration,
        gracePeriod: exam.gracePeriod,
        maxAttempts: exam.maxAttempts,
        isActive: exam.isActive,
        showResultsImmediately: exam.showResultsImmediately,
        resultsReleasedAt: exam.resultsReleasedAt,
        examType: exam.examType,
        totalMarks: exam.totalMarks,
        subTenantId: exam.subTenantId ? exam.subTenantId.toString() : null,
        accessControl:
          exam.accessControl && typeof exam.accessControl.toObject === 'function'
            ? exam.accessControl.toObject()
            : exam.accessControl || null,
      };

      const {
        title,
        description,
        instructions,
        duration,
        gracePeriod,
        maxAttempts,
        isActive,
        showResultsImmediately,
        resultsReleasedAt,
        examType,
        deliveryMode,
        sections,
        timingMode,
        allowDurationOverride,
        evaluationMode,
        answerKey,
        markingRules,
        omrTemplateImage,
        totalMarks,
        subTenantId,
        accessControl,
      } =
        req.body;

      if (typeof title === 'string' && title.trim()) {
        const duplicateExam = await findDuplicateExamByTitle({
          title,
          tenantId: exam.tenantId || req.user?.tenantId || req.tenantFilter?.tenantId || null,
          excludeExamId: exam._id,
        });
        if (duplicateExam) {
          return res.status(409).json({
            success: false,
            message: DUPLICATE_EXAM_NAME_MESSAGE,
          });
        }
      }

      const requestedDuration = duration !== undefined ? toPositiveInt(duration, null) : null;
      if (duration !== undefined && requestedDuration === null) {
        return res.status(400).json({ error: 'Duration must be a positive number.' });
      }

      const requestedExamType = normalizeExamType(examType);
      const existingExamType = normalizeExamType(exam.examType) || ONLINE_EXAM_TYPE;
      const resolvedExamType = [ONLINE_EXAM_TYPE, OMR_EXAM_TYPE].includes(requestedExamType)
        ? requestedExamType
        : existingExamType;
      const sectionPayloadProvided = Array.isArray(sections);
      const sectionBasedUpdate =
        resolvedExamType !== OMR_EXAM_TYPE &&
        (requestedExamType === SECTION_BASED_EXAM_TYPE || sectionPayloadProvided);

      if (!isPlanFeatureEnabled(effectivePlanType, 'omr') && resolvedExamType === OMR_EXAM_TYPE) {
        return sendPlanRestriction(res, FREE_PLAN_MESSAGES.OMR_LOCKED);
      }

      if (resolvedExamType === OMR_EXAM_TYPE && sectionPayloadProvided) {
        return res.status(400).json({
          error: 'Sections are not supported for OMR exams.',
        });
      }

      if (subTenantId !== undefined) {
        const normalizedSubTenantId = String(subTenantId || '').trim();
        if (!normalizedSubTenantId) {
          exam.subTenantId = null;
        } else {
          if (!isPlanFeatureEnabled(effectivePlanType, 'multiTenant')) {
            return sendPlanRestriction(res, FREE_PLAN_MESSAGES.MULTI_TENANT_LOCKED);
          }

          const subTenant = await SubTenant.findOne({
            _id: normalizedSubTenantId,
            tenantId: exam.tenantId,
            status: 'ACTIVE',
          })
            .select('_id')
            .lean();
          if (!subTenant) {
            return res.status(404).json({ error: 'Sub-tenant not found for this workspace.' });
          }
          exam.subTenantId = subTenant._id;
        }
      }

      if (accessControl !== undefined) {
        const sanitizedAccessControl = sanitizeExamAccessControlPayload(
          accessControl,
          exam.accessControl
        );
        const hasIpWhitelistRules = Array.isArray(sanitizedAccessControl.ipWhitelist)
          && sanitizedAccessControl.ipWhitelist.length > 0;
        if (hasIpWhitelistRules && !isPlanFeatureEnabled(effectivePlanType, 'ipWhitelist')) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.IP_WHITELIST_LOCKED);
        }

        const hasGeoRestrictions = Boolean(
          sanitizedAccessControl?.geoRestrictions?.enabled &&
          (
            sanitizedAccessControl.geoRestrictions.allowedCountries.length > 0 ||
            sanitizedAccessControl.geoRestrictions.allowedRegions.length > 0
          )
        );
        if (hasGeoRestrictions && !isPlanFeatureEnabled(effectivePlanType, 'geoLocationRestriction')) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.GEO_LOCKED);
        }

        if (
          sanitizedAccessControl?.secureBrowser?.enabled === true &&
          !isPlanFeatureEnabled(effectivePlanType, 'secureBrowser')
        ) {
          return sendPlanRestriction(res, FREE_PLAN_MESSAGES.SECURE_BROWSER_LOCKED);
        }

        exam.accessControl = sanitizedAccessControl;
      }

      let safeOmrPayload = null;
      if (resolvedExamType === OMR_EXAM_TYPE) {
        try {
          safeOmrPayload = sanitizeOmrPayload({
            markingRules: markingRules !== undefined ? markingRules : exam.markingRules,
            answerKey: answerKey !== undefined ? answerKey : exam.answerKey,
          });
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }
      }

      if (sectionBasedUpdate) {
        if (!Array.isArray(sections)) {
          return res.status(400).json({
            error: 'sections payload is required for section-based exam duration validation.',
          });
        }

        let safeSections;
        try {
          safeSections = sanitizeSectionDurationPayload(sections);
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }

        const computedDuration = computeSectionDurationTotal(safeSections);
        const durationOverrideAllowed = allowDurationOverride === true;
        if (
          requestedDuration !== null &&
          requestedDuration !== computedDuration &&
          !durationOverrideAllowed
        ) {
          return res.status(400).json({
            error: `Duration mismatch for section-based exam. Expected ${computedDuration} minutes from sections.`,
          });
        }
        exam.duration =
          durationOverrideAllowed && requestedDuration !== null ? requestedDuration : computedDuration;
      }

      if (sectionBasedUpdate) {
        exam.timingMode = 'section_based';
        exam.allowDurationOverride = Boolean(allowDurationOverride);
      } else if (timingMode !== undefined || allowDurationOverride !== undefined) {
        if (timingMode !== undefined) exam.timingMode = timingMode;
        if (allowDurationOverride !== undefined) exam.allowDurationOverride = Boolean(allowDurationOverride);
      }

      if (evaluationMode !== undefined && evaluationMode !== exam.evaluationMode) {
        if (evaluationMode !== 'AUTOMATIC') {
          if (!isPlanFeatureEnabled(effectivePlanType, 'examinerReview')) {
            return sendPlanRestriction(res, FREE_PLAN_MESSAGES.EXAMINER_REVIEW_LOCKED);
          }
          if (
            ['AI_MANDATORY_REVIEW', 'MANUAL', 'HYBRID'].includes(evaluationMode) &&
            !isPlanFeatureEnabled(effectivePlanType, 'mandatoryVerification')
          ) {
            return sendPlanRestriction(res, FREE_PLAN_MESSAGES.MANDATORY_VERIFICATION_LOCKED);
          }
        }
        exam.evaluationMode = evaluationMode;
      }

      if (title) exam.title = title;
      if (description !== undefined) exam.description = description;
      if (instructions !== undefined) {
        exam.instructions = typeof instructions === 'string' ? instructions.trim() : '';
      }
      if (!sectionBasedUpdate && duration !== undefined) {
        exam.duration = requestedDuration;
      }
      if (totalMarks !== undefined) {
        exam.totalMarks = Math.max(0, Number(totalMarks) || 0);
      }
      if (resolvedExamType === OMR_EXAM_TYPE && duration === undefined && !exam.duration) {
        exam.duration = 60;
      }
      if (gracePeriod !== undefined) exam.gracePeriod = gracePeriod;
      if (maxAttempts !== undefined) exam.maxAttempts = maxAttempts;
      if (isActive !== undefined) exam.isActive = isActive;
      if ([ONLINE_EXAM_TYPE, OMR_EXAM_TYPE].includes(requestedExamType)) {
        exam.examType = requestedExamType;
      }
      if (['ONLINE', 'OFFLINE', 'HYBRID'].includes(deliveryMode)) {
        const scriptCount = await countAnswerScriptsForExam({ tenantId: req.user.tenantId, examId: exam._id });
        const gate = canChangeExamDeliveryMode({ exam, answerScriptCount: scriptCount });
        if (!gate.allowed) {
          return res.status(409).json({ error: gate.message, code: gate.code });
        }
        if (gate.restrictTo && !gate.restrictTo.includes(deliveryMode)) {
          return res.status(409).json({ error: gate.message || 'That delivery mode is not allowed for this assessment.' });
        }
        exam.deliveryMode = deliveryMode;
      }
      if (resolvedExamType === OMR_EXAM_TYPE) {
        exam.answerKey = safeOmrPayload.answerKey;
        exam.markingRules = safeOmrPayload.markingRules;
        if (omrTemplateImage !== undefined) {
          exam.omrTemplateImage = String(omrTemplateImage || '').trim();
        }
      } else if (requestedExamType === ONLINE_EXAM_TYPE) {
        exam.answerKey = [];
        exam.markingRules = {};
        exam.omrTemplateImage = '';
      }
      if (showResultsImmediately !== undefined) {
        exam.showResultsImmediately = showResultsImmediately;
        if (showResultsImmediately) {
          exam.resultsReleasedAt = null;
        }
      }
      if (resultsReleasedAt !== undefined) {
        exam.resultsReleasedAt = resultsReleasedAt ? new Date(resultsReleasedAt) : null;
      }

      await exam.save();
      await exam.populate('createdBy', 'name email');

      let candidateAssignmentResult = null;
      if (hasCandidateAssignmentUpdate) {
        candidateAssignmentResult = await applyCandidateAssignments({
          exam,
          candidateIds: requestedCandidateIds,
          mode: requestedAssignmentMode,
          assignedBy: req.user._id,
        });

        const assignmentAction =
          candidateAssignmentResult.addedCandidateIds.length > 0 &&
          candidateAssignmentResult.removedCandidateIds.length > 0
            ? AUDIT_ACTIONS.EXAM_CANDIDATES_UPDATED
            : candidateAssignmentResult.addedCandidateIds.length > 0
              ? AUDIT_ACTIONS.EXAM_CANDIDATES_ASSIGNED
              : candidateAssignmentResult.removedCandidateIds.length > 0
                ? AUDIT_ACTIONS.EXAM_CANDIDATES_REMOVED
                : null;

        if (assignmentAction) {
          await logAuditEvent(assignmentAction, {
            userId: req.user._id,
            userEmail: req.user.email,
            userName: req.user.name,
            userRole: req.user.role,
            tenantId: exam.tenantId || null,
            resourceType: 'Exam',
            resourceId: exam._id,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            method: req.method,
            path: req.path,
            candidateIds: candidateAssignmentResult.candidateIds,
            addedCandidateIds: candidateAssignmentResult.addedCandidateIds,
            removedCandidateIds: candidateAssignmentResult.removedCandidateIds,
            mode: candidateAssignmentResult.mode,
          });
        }
      }

      const updatedFields = [];
      const valueToTime = (value) => {
        if (!value) return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
      };
      const compareField = (field, transform = (value) => value) => {
        const beforeValue = transform(beforeState[field]);
        const afterValue = transform(exam[field]);
        if (beforeValue !== afterValue) {
          updatedFields.push(field);
        }
      };
      compareField('title');
      compareField('description');
      compareField('instructions');
      compareField('duration');
      compareField('gracePeriod');
      compareField('maxAttempts');
      compareField('isActive');
      compareField('showResultsImmediately');
      compareField('resultsReleasedAt', valueToTime);
      compareField('examType');
      compareField('totalMarks');
      compareField('subTenantId', (value) => (value ? String(value) : null));

      const isActiveChanged = beforeState.isActive !== exam.isActive;
      const action = isActiveChanged
        ? (exam.isActive ? AUDIT_ACTIONS.EXAM_ENABLED : AUDIT_ACTIONS.EXAM_DISABLED)
        : AUDIT_ACTIONS.EXAM_UPDATED;

      await logAuditEvent(action, {
        userId: req.user._id,
        userEmail: req.user.email,
        userName: req.user.name,
        userRole: req.user.role,
        tenantId: exam.tenantId || null,
        resourceType: 'Exam',
        resourceId: exam._id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        method: req.method,
        path: req.path,
        details: {
          updatedFields,
          answerKeyUpdated: answerKey !== undefined,
          markingRulesUpdated: markingRules !== undefined,
          sectionsUpdated: Array.isArray(sections),
          omrTemplateImageUpdated: omrTemplateImage !== undefined,
          accessControlUpdated: accessControl !== undefined,
          subTenantUpdated: subTenantId !== undefined,
          before: {
            isActive: beforeState.isActive,
          },
          after: {
            isActive: exam.isActive,
          },
        },
      });

      if (exam.examType !== OMR_EXAM_TYPE) {
        queueExamPackageRegeneration({
          examId: exam._id,
          userId: req.user._id,
          reason: 'EXAM_UPDATED',
          forceRegenerate: true,
          examUpdatedAt: exam.updatedAt,
        });
      }

      res.json({ exam: withExamCode(exam) });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Increase max attempts for an exam
 * Allows exam creator to increase max attempts for all candidates
 */
router.patch(
  '/:examId/increase-max-attempts',
  requireAuth,
  requireTenant,
  requireOwnershipOrAdmin,
  [
    body('additionalAttempts').isInt({ min: 1 }).withMessage('Additional attempts must be a positive integer'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      const additionalAttempts = parseInt(req.body.additionalAttempts);
      exam.maxAttempts = exam.maxAttempts + additionalAttempts;

      await exam.save();
      await exam.populate('createdBy', 'name email');

      res.json({
        message: `Max attempts increased by ${additionalAttempts}. New max attempts: ${exam.maxAttempts}`,
        exam: withExamCode(exam),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Delete exam (DESIGNER own/ADMIN/ORG_ADMIN/INSTITUTE_ADMIN)
router.delete(
  '/:examId',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin,
  auditLog(AUDIT_ACTIONS.EXAM_DELETED, (req, res) => ({
    resourceType: 'Exam',
    resourceId: res.locals.examId || req.params.examId,
    examTitle: res.locals.examTitle || null,
    tenantId: res.locals.tenantId || null,
  })),
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      res.locals.examId = exam._id.toString();
      res.locals.examTitle = exam.title;
      res.locals.tenantId = exam.tenantId || null;

      await Exam.findByIdAndDelete(req.params.examId);
      await syncUserExamCount(exam.createdBy);
      res.json({ message: 'Exam deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// Release results
router.post(
  '/:examId/release-results',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin,
  auditLog(AUDIT_ACTIONS.EXAM_RESULTS_RELEASED, (req, res) => ({
    resourceType: 'Exam',
    resourceId: res.locals.examId || req.params.examId,
    examTitle: res.locals.examTitle || null,
    tenantId: res.locals.tenantId || null,
  })),
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      // Evaluation-mode gate: exams that require examiner/moderator review
      // cannot publish while any in-scope answer is still pending review.
      // Optional review never blocks publication. Existing exams default to
      // AUTOMATIC, so historic behavior and already-published results remain
      // untouched.
      if (['AI_MANDATORY_REVIEW', 'MANUAL', 'HYBRID'].includes(exam.evaluationMode)) {
        const attemptIds = await ExamAttempt.find({
          examId: exam._id,
          isCompleted: true,
        }).distinct('_id');

        const pendingReviewCount = await Answer.countDocuments({
          attemptId: { $in: attemptIds },
          evaluationStatus: { $in: ['PENDING_REVIEW', 'UNDER_REVIEW', 'FLAGGED'] },
        });

        if (pendingReviewCount > 0) {
          await logAuditEvent(AUDIT_ACTIONS.RESULT_PUBLICATION_BLOCKED, {
            userId: req.user._id,
            userRole: req.user.role,
            tenantId: exam.tenantId || null,
            resourceType: 'Exam',
            resourceId: exam._id,
            details: { evaluationMode: exam.evaluationMode, pendingReviewCount },
          });
          return res.status(409).json({
            error: `Cannot publish results: ${pendingReviewCount} answer(s) are still pending examiner or moderator review.`,
            pendingReviewCount,
          });
        }
      }

      exam.resultsReleasedAt = new Date();
      await exam.save();
      const releasedPapers = await QuestionPaper.find({ examId: exam._id }).select('_id').lean();
      const releasedQuestionIds = await Question.find({ questionPaperId: { $in: releasedPapers.map((paper) => paper._id) }, isIncludedInExam: { $ne: false } }).distinct('_id');
      if (releasedQuestionIds.length) {
        await QuestionUsage.insertMany(releasedQuestionIds.map((questionId) => ({
          tenantId: exam.tenantId,
          questionId,
          examId: exam._id,
          courseOfferingId: exam.academicContext?.courseOfferingId || null,
          frameworkVersionId: exam.frameworkVersionId || null,
          event: 'PUBLISHED',
        })));
      }
      await exam.populate('createdBy', 'name email');

      res.locals.examId = exam._id.toString();
      res.locals.examTitle = exam.title;
      res.locals.tenantId = exam.tenantId || null;

      try {
        const { createRoleNotification, createUserNotifications } = await import('../services/notificationService.js');
        const basePayload = {
          title: 'Results Published',
          message: `Results for "${exam.title}" have been published.`,
          type: 'result_published',
          tenantId: exam.tenantId || null,
          examId: exam._id,
          createdBy: req.user._id,
          metadata: {
            examId: exam._id,
            examTitle: exam.title,
          },
        };

        if (exam.tenantId) {
          await createRoleNotification({ ...basePayload, roles: ['TENANT_ADMIN'] });
          await createRoleNotification({ ...basePayload, roles: ['EXAM_CREATOR'] });
        }
        await createRoleNotification({ ...basePayload, roles: ['SUPER_ADMIN'] });

        const candidateIds = await ExamAttempt.distinct('userId', {
          examId: exam._id,
          isCompleted: true,
        });
        await createUserNotifications({
          ...basePayload,
          roles: ['CANDIDATE'],
          userIds: candidateIds,
        });
      } catch (notifyError) {
        console.error('[NOTIFICATIONS] Failed to log results release:', notifyError?.message || notifyError);
      }

      res.json({ exam: withExamCode(exam) });
    } catch (error) {
      next(error);
    }
  }
);

// Send certificates separately (for students who passed >= 60%)
router.post(
  '/:examId/send-certificates',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireOwnershipOrAdmin,
  async (req, res, next) => {
    try {
      const exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exam not found' });
      }

      if (!exam.allowCertification) {
        return res.status(403).json({ error: 'Certification is disabled for this exam.' });
      }

      // Find all completed attempts for this exam
      const attempts = await ExamAttempt.find({
        examId: exam._id,
        isCompleted: true,
        isDisqualified: false,
      })
        .populate('userId', 'name email')
        .populate('examId', 'title allowCertification passingPercentage certificateTemplate')
        .populate('questionPaperId', '_id');

      const certificateResults = [];
      // Note: For bulk sending, we use global template. 
      // Individual certificate generation uses exam-specific templates.
      const template = await loadCertificateTemplate();

      // Process each attempt to check if they qualify for certificate
      for (const attempt of attempts) {
        const { summary } = await ensureScoreSummary(attempt);
        const percentage = summary?.percentage ?? 0;

        // Use exam-specific passing percentage if available, otherwise use default
        const minPercentage = attempt.examId?.passingPercentage !== undefined
          ? attempt.examId.passingPercentage
          : MIN_CERTIFICATION_PERCENTAGE;

        // Only send certificates to students who scored >= passing percentage
        if (percentage >= minPercentage) {
          const examTitle = attempt.examId?.title || attempt.examSnapshot?.title || 'Exam';
          const attemptDate = attempt.submitTime ? new Date(attempt.submitTime) : null;
          const issuedTimestamp = attemptDate ? attemptDate : new Date();

          const context = {
            studentName: attempt.userId?.name || 'Candidate', // Universal: Changed from 'Student' to 'Candidate'
            examTitle,
            attemptDate: attemptDate ? attemptDate.toLocaleDateString() : '',
            issuedOn: issuedTimestamp.toLocaleDateString(),
            percentage,
            score: summary?.totalScore ?? 0,
            maxScore: summary?.maxScore ?? 0,
            attemptId: attempt._id.toString(),
          };

          const renderedTemplate = applyCertificateTemplate(template, context);

          // TODO: Implement actual email sending service here
          // For now, we'll just mark that certificates were sent
          // In production, you would:
          // 1. Generate PDF certificate
          // 2. Send email with certificate attachment
          // 3. Use a service like nodemailer, SendGrid, etc.

          certificateResults.push({
            attemptId: attempt._id,
            studentName: attempt.userId?.name,
            studentEmail: attempt.userId?.email,
            percentage,
            certificateGenerated: true,
            // certificateSent: true, // Set when email is actually sent
          });
        }
      }

      // Mark exam with certificate sent timestamp
      exam.certificatesSentAt = new Date();
      await exam.save();

      res.json({
        success: true,
        message: `Certificates processed for ${certificateResults.length} candidate(s)`, // Universal: Changed from 'student(s)' to 'candidate(s)'
        count: certificateResults.length,
        certificates: certificateResults,
        exam: {
          _id: exam._id,
          title: exam.title,
          certificatesSentAt: exam.certificatesSentAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Auto-assign questions to sections based on context matching
router.post(
  '/auto-assign',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR'),
  async (req, res, next) => {
    try {
      const {
        examId,
        questionPaperId,
        sections,
        questions,
        preserveExistingAssignments = true,
        questionTypeDistribution,
        difficultyDistribution,
      } = req.body || {};

      let resolvedSections = Array.isArray(sections) ? sections : null;
      let resolvedQuestions = Array.isArray(questions) ? questions : null;

      if ((!resolvedSections || !resolvedQuestions) && examId) {
        const exam = await Exam.findOne({ _id: examId, ...req.tenantFilter });
        if (!exam) {
          return res.status(404).json({ error: 'Exam not found' });
        }
        if (!(await canOperateExam(req.user, exam))) {
          return res.status(403).json({ error: 'You do not have permission to manage this assessment.' });
        }

        const QuestionPaper = (await import('../models/QuestionPaper.js')).default;
        const Section = (await import('../models/Section.js')).default;
        const Question = (await import('../models/Question.js')).default;

        const questionPapers = await QuestionPaper.find({ examId: exam._id, isActive: true })
          .sort({ order: 1 })
          .lean();

        if (!questionPapers.length) {
          return res.status(404).json({ error: 'No question papers found for this exam.' });
        }

        let targetPaper = null;
        if (questionPaperId) {
          targetPaper = questionPapers.find(
            (paper) => String(paper._id) === String(questionPaperId)
          );
          if (!targetPaper) {
            return res.status(404).json({ error: 'Question paper not found for this exam.' });
          }
        } else if (questionPapers.length > 1) {
          return res.status(400).json({
            error: 'Multiple question papers found. Please provide questionPaperId.',
          });
        } else {
          targetPaper = questionPapers[0];
        }

        resolvedSections = await Section.find({
          questionPaperId: targetPaper._id,
          isActive: true,
        })
          .sort({ order: 1 })
          .lean();
        resolvedQuestions = await Question.find({ questionPaperId: targetPaper._id })
          .sort({ order: 1 })
          .lean();
      }

      if (!Array.isArray(resolvedSections) || !Array.isArray(resolvedQuestions)) {
        return res.status(400).json({
          error: 'sections and questions are required when examId is not provided.',
        });
      }

      const { sectionAssignments, unassignedIds } = runContextAutoAssign(
        resolvedQuestions,
        resolvedSections,
        {
          preserveExistingAssignments: Boolean(preserveExistingAssignments),
          questionTypeDistribution,
          difficultyDistribution,
        }
      );

      return res.json({
        sections: sectionAssignments,
        unassigned_questions: unassignedIds,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/assign-enrolled-class',
  requireAuth,
  requireTenant,
  enforceTenantBoundaries,
  requireRole('EXAM_CREATOR', 'TEACHER', 'ACADEMIC_ADMIN', 'TENANT_ADMIN'),
  async (req, res, next) => {
    try {
      const exam = await Exam.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
      if (!exam) return res.status(404).json({ error: 'Assessment not found.' });
      if (!(hasRole(req.user, 'TENANT_ADMIN') || await canOperateExam(req.user, exam))) {
        return res.status(403).json({ error: 'You do not have permission to manage this assessment roster.' });
      }

      const courseOfferingId = req.body?.courseOfferingId || exam.academicContext?.courseOfferingId;
      if (!courseOfferingId) {
        return res.status(400).json({ error: 'courseOfferingId is required for whole-class assignment.' });
      }
      let academicAdminScopeOk = false;
      if (hasRole(req.user, 'ACADEMIC_ADMIN')) {
        const visibility = await resolveAcademicVisibility(req.user);
        academicAdminScopeOk = visibility.all
          || (visibility.ids['course-offerings'] || []).includes(String(courseOfferingId));
      }
      if (!(hasRole(req.user, 'TENANT_ADMIN') || academicAdminScopeOk || await canAuthorInCourseOffering(req.user, courseOfferingId))) {
        return res.status(403).json({ error: 'You are not authorized to assign candidates from this course offering.' });
      }

      const { default: CourseOffering } = await import('../models/academic/CourseOffering.js');
      const { default: Enrollment } = await import('../models/academic/Enrollment.js');
      const offering = await CourseOffering.findOne({ _id: courseOfferingId, tenantId: req.user.tenantId, status: 'ACTIVE' }).lean();
      if (!offering) return res.status(404).json({ error: 'Course offering not found.' });

      const enrollments = await Enrollment.find({
        tenantId: req.user.tenantId,
        academicSessionId: offering.academicSessionId,
        programId: offering.programId,
        status: 'ACTIVE',
        ...(offering.cohortId ? { cohortId: offering.cohortId } : {}),
        ...(offering.academicSectionId ? { academicSectionId: offering.academicSectionId } : {}),
      }).select('userId').lean();

      const candidateIds = enrollments.map((item) => String(item.userId));
      const assignmentResult = await applyCandidateAssignments({
        exam,
        candidateIds,
        mode: req.body?.mode || 'replace',
        assignedBy: req.user._id,
      });

      return res.json({
        message: 'Enrolled class assigned to assessment roster.',
        candidateCount: assignmentResult.candidateIds.length,
        assignment: assignmentResult,
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
