/**
 * Section Service
 * Handles section CRUD within QuestionPapers, timer management, and navigation rule enforcement.
 */

import Section from '../models/Section.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Exam from '../models/Exam.js';
import {
  SECTION_NAVIGATION_RULES,
  SECTION_TIMER_CONFIG,
  normalizeNavigationRule,
  isNoFreeNavigationRule,
} from '../config/sectionTimers.js';
import { syncExamQuestionCount } from '../utils/planUsage.js';

const toIdString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) {
    return value._id.toString();
  }
  return String(value);
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toNonNegativeInt = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
};

const toPositiveInt = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
};

const syncExamDurationFromQuestionPaper = async (questionPaperId) => {
  if (!questionPaperId) return;

  const questionPaper = await QuestionPaper.findById(questionPaperId).select('examId isActive');
  if (!questionPaper?.examId) return;

  const examId = questionPaper.examId;
  const papers = await QuestionPaper.find({ examId, isActive: true }).select('_id').lean();
  if (!papers.length) return;

  const paperIds = papers.map((paper) => paper._id);
  const sections = await Section.find({
    questionPaperId: { $in: paperIds },
    isActive: true,
  })
    .select('questionPaperId duration')
    .lean();

  const totalsByPaper = new Map(paperIds.map((id) => [id.toString(), 0]));
  sections.forEach((section) => {
    const key = section.questionPaperId?.toString();
    if (!key || !totalsByPaper.has(key)) return;
    totalsByPaper.set(key, totalsByPaper.get(key) + toPositiveInt(section.duration, 0));
  });

  const nonZeroTotals = [...totalsByPaper.values()].filter((value) => value > 0);
  if (!nonZeroTotals.length) return;

  // For multi-set exams, keep the max set-duration to avoid shortening total time for any assigned set.
  const computedDuration = Math.max(...nonZeroTotals);
  await Exam.updateOne({ _id: examId }, { $set: { duration: computedDuration } });
};

const getSectionDurationSeconds = (section, existing = null) => {
  const fromExisting = toNonNegativeInt(existing?.durationSeconds, 0);
  if (fromExisting > 0) return fromExisting;
  const minMinutes = SECTION_TIMER_CONFIG.MIN_SECTION_DURATION_MINUTES;
  const safeMinutes = Math.max(toNonNegativeInt(section?.duration, minMinutes), minMinutes);
  return safeMinutes * 60;
};

const ensureTimerMap = (attempt) => {
  if (!attempt.sectionTimers || typeof attempt.sectionTimers.get !== 'function') {
    attempt.sectionTimers = new Map(Object.entries(attempt.sectionTimers || {}));
  }
  return attempt.sectionTimers;
};

const hydrateTimerEntry = ({ rawTimer, section, now }) => {
  const durationSeconds = getSectionDurationSeconds(section, rawTimer);

  const startTime = toDateOrNull(rawTimer?.startTime);
  const startedAt = toDateOrNull(rawTimer?.startedAt) || startTime;
  const completedAt = toDateOrNull(rawTimer?.completedAt);
  const lastResumedAt = toDateOrNull(rawTimer?.lastResumedAt);
  const endTime = toDateOrNull(rawTimer?.endTime);

  let timeSpent = toNonNegativeInt(rawTimer?.timeSpent, 0);
  let remainingSeconds = toNonNegativeInt(rawTimer?.remainingSeconds, -1);

  if (remainingSeconds < 0) {
    if (endTime) {
      remainingSeconds = Math.max(0, Math.floor((endTime.getTime() - now.getTime()) / 1000));
    } else {
      remainingSeconds = Math.max(durationSeconds - timeSpent, 0);
    }
  }

  if (timeSpent === 0 && remainingSeconds >= 0) {
    timeSpent = Math.max(durationSeconds - remainingSeconds, 0);
  }

  let isLocked = Boolean(rawTimer?.isLocked);
  let isCompleted = Boolean(rawTimer?.isCompleted || isLocked || completedAt);
  let isActive = Boolean(rawTimer?.isActive) && !isLocked && !isCompleted;

  if (remainingSeconds <= 0) {
    remainingSeconds = 0;
    isLocked = true;
    isCompleted = true;
    isActive = false;
  }

  return {
    startTime,
    startedAt,
    endTime,
    completedAt,
    lastResumedAt,
    durationSeconds,
    remainingSeconds,
    timeSpent,
    isLocked,
    isCompleted,
    isActive,
  };
};

const applyElapsed = (entry, now) => {
  if (!entry.isActive || entry.isLocked || entry.isCompleted) {
    return false;
  }

  if (!entry.lastResumedAt) {
    entry.lastResumedAt = now;
    entry.endTime = new Date(now.getTime() + entry.remainingSeconds * 1000);
    return true;
  }

  const elapsedSeconds = Math.floor(
    (now.getTime() - entry.lastResumedAt.getTime()) / 1000
  );
  if (elapsedSeconds <= 0) {
    entry.endTime = new Date(now.getTime() + entry.remainingSeconds * 1000);
    return false;
  }

  entry.timeSpent = Math.max(entry.timeSpent + elapsedSeconds, 0);
  entry.remainingSeconds = Math.max(entry.remainingSeconds - elapsedSeconds, 0);
  entry.lastResumedAt = now;

  if (entry.remainingSeconds <= 0) {
    entry.remainingSeconds = 0;
    entry.isActive = false;
    entry.isLocked = true;
    entry.isCompleted = true;
    entry.completedAt = entry.completedAt || now;
    entry.endTime = now;
    return true;
  }

  entry.endTime = new Date(now.getTime() + entry.remainingSeconds * 1000);
  return true;
};

const pauseTimerEntry = (entry, now) => {
  const changed = applyElapsed(entry, now);
  if (!entry.isActive) {
    return changed;
  }
  entry.isActive = false;
  entry.lastResumedAt = null;
  entry.endTime = new Date(now.getTime() + entry.remainingSeconds * 1000);
  return true;
};

const resumeTimerEntry = (entry, now) => {
  if (entry.isLocked || entry.isCompleted) {
    return false;
  }
  if (entry.remainingSeconds <= 0) {
    entry.remainingSeconds = 0;
    entry.isLocked = true;
    entry.isCompleted = true;
    entry.isActive = false;
    entry.completedAt = entry.completedAt || now;
    entry.endTime = now;
    return true;
  }

  if (!entry.startedAt) {
    entry.startedAt = now;
    entry.startTime = now;
  } else if (!entry.startTime) {
    entry.startTime = entry.startedAt;
  }

  entry.isActive = true;
  entry.lastResumedAt = now;
  entry.endTime = new Date(now.getTime() + entry.remainingSeconds * 1000);
  return true;
};

const lockTimerEntry = (entry, now, options = {}) => {
  const { forceZeroRemaining = false } = options;
  const wasLocked = entry.isLocked;
  const wasCompleted = entry.isCompleted;
  const wasActive = entry.isActive;
  const previousRemaining = entry.remainingSeconds;
  const changed = applyElapsed(entry, now);

  entry.isActive = false;
  entry.isLocked = true;
  entry.isCompleted = true;
  entry.lastResumedAt = null;
  entry.completedAt = entry.completedAt || now;
  if (forceZeroRemaining) {
    entry.remainingSeconds = 0;
  }
  entry.endTime = now;
  if (!entry.startedAt) {
    entry.startedAt = now;
    entry.startTime = now;
  }

  return (
    changed ||
    !wasLocked ||
    !wasCompleted ||
    wasActive ||
    (forceZeroRemaining && previousRemaining !== entry.remainingSeconds)
  );
};

const persistTimerState = ({ attempt, entries, now, currentSectionId, navigationRule }) => {
  const nextMap = new Map();
  entries.forEach((entry, sectionId) => {
    nextMap.set(sectionId, {
      startTime: entry.startTime || entry.startedAt || null,
      endTime: entry.endTime || null,
      isLocked: Boolean(entry.isLocked),
      timeSpent: toNonNegativeInt(entry.timeSpent, 0),
      durationSeconds: toNonNegativeInt(entry.durationSeconds, 0),
      remainingSeconds: toNonNegativeInt(entry.remainingSeconds, 0),
      isActive: Boolean(entry.isActive),
      isCompleted: Boolean(entry.isCompleted),
      startedAt: entry.startedAt || null,
      lastResumedAt: entry.lastResumedAt || null,
      completedAt: entry.completedAt || null,
    });
  });

  attempt.sectionTimers = nextMap;
  attempt.currentSectionId = currentSectionId || null;
  attempt.navigationRule = navigationRule || SECTION_NAVIGATION_RULES.FREE;
  attempt.sectionStateUpdatedAt = now;
};

const serializeTimerEntry = ({ entry, section, now }) => {
  let liveRemaining = toNonNegativeInt(entry.remainingSeconds, 0);
  if (entry.isActive && entry.lastResumedAt) {
    const elapsed = Math.floor((now.getTime() - entry.lastResumedAt.getTime()) / 1000);
    if (elapsed > 0) {
      liveRemaining = Math.max(liveRemaining - elapsed, 0);
    }
  }

  const isExpired = liveRemaining <= 0;
  const isLocked = Boolean(entry.isLocked || isExpired);
  const isCompleted = Boolean(entry.isCompleted || isLocked);
  const warningThresholdSeconds = SECTION_TIMER_CONFIG.WARNING_THRESHOLD_SECONDS;

  return {
    sectionId: section._id.toString(),
    sectionName: section.name,
    order: section.order ?? 0,
    durationSeconds: toNonNegativeInt(entry.durationSeconds, getSectionDurationSeconds(section)),
    remainingSeconds: liveRemaining,
    timeSpent: toNonNegativeInt(entry.timeSpent, 0),
    started: Boolean(entry.startedAt || entry.startTime),
    isActive: Boolean(entry.isActive) && !isLocked,
    isLocked,
    isCompleted,
    isExpired,
    isWarning: liveRemaining > 0 && liveRemaining <= warningThresholdSeconds,
    warningThresholdSeconds,
    startedAt: entry.startedAt ? entry.startedAt.toISOString() : null,
    lastResumedAt: entry.lastResumedAt ? entry.lastResumedAt.toISOString() : null,
    completedAt: entry.completedAt ? entry.completedAt.toISOString() : null,
    endTime: entry.endTime ? entry.endTime.toISOString() : null,
    rawNavigationRule: section.navigationRule || SECTION_NAVIGATION_RULES.FREE,
    navigationRule: normalizeNavigationRule(section.navigationRule),
  };
};

const getSortedSectionsForAttempt = async (attempt) => {
  const questionPaperId = toIdString(attempt?.questionPaperId);
  if (!questionPaperId) {
    return [];
  }

  return Section.find({ questionPaperId, isActive: true }).sort({ order: 1 });
};

const buildAttemptContext = async (attempt) => {
  const now = new Date();
  const sections = await getSortedSectionsForAttempt(attempt);
  const sectionMap = new Map(sections.map((section) => [section._id.toString(), section]));
  const timerMap = ensureTimerMap(attempt);

  const entries = new Map();
  let changed = false;

  sections.forEach((section) => {
    const sectionId = section._id.toString();
    const rawTimer = timerMap.get(sectionId) || {};
    const entry = hydrateTimerEntry({ rawTimer, section, now });
    const elapsedChanged = applyElapsed(entry, now);
    if (elapsedChanged) {
      changed = true;
    }
    entries.set(sectionId, entry);
  });

  const activeSectionIds = [...entries.entries()]
    .filter(([, entry]) => entry.isActive && !entry.isLocked)
    .map(([sectionId]) => sectionId);

  if (activeSectionIds.length > 1) {
    const preferred = toIdString(attempt.currentSectionId);
    const keepActive = preferred && activeSectionIds.includes(preferred)
      ? preferred
      : activeSectionIds[0];
    activeSectionIds.forEach((sectionId) => {
      if (sectionId === keepActive) return;
      if (pauseTimerEntry(entries.get(sectionId), now)) {
        changed = true;
      }
    });
  }

  let currentSectionId = toIdString(attempt.currentSectionId);
  if (currentSectionId && !sectionMap.has(currentSectionId)) {
    currentSectionId = null;
    changed = true;
  }
  if (!currentSectionId && sections.length > 0) {
    currentSectionId = sections[0]._id.toString();
    changed = true;
  }

  const currentSection = currentSectionId ? sectionMap.get(currentSectionId) : null;
  const navigationRule = normalizeNavigationRule(
    currentSection?.navigationRule || attempt.navigationRule || SECTION_NAVIGATION_RULES.FREE
  );
  if (attempt.navigationRule !== navigationRule) {
    changed = true;
  }

  return {
    now,
    sections,
    sectionMap,
    entries,
    changed,
    currentSectionId,
    navigationRule,
  };
};

const getNextSectionId = ({ sections, entries, fromSectionId }) => {
  const from = sections.find((section) => section._id.toString() === fromSectionId);
  if (!from) return null;

  const next = sections.find((section) => {
    const sectionId = section._id.toString();
    const entry = entries.get(sectionId);
    if ((section.order ?? 0) <= (from.order ?? 0)) return false;
    return !entry?.isLocked && !entry?.isCompleted;
  });

  return next ? next._id.toString() : null;
};

const buildSectionProgressState = ({ sections, entries, now, currentSectionId, navigationRule }) => {
  const sectionTimes = {};
  const completedSectionIds = [];
  const lockedSectionIds = [];

  sections.forEach((section) => {
    const sectionId = section._id.toString();
    const entry = entries.get(sectionId) || hydrateTimerEntry({ rawTimer: {}, section, now });
    const serialized = serializeTimerEntry({ entry, section, now });
    sectionTimes[sectionId] = serialized;

    if (serialized.isCompleted) {
      completedSectionIds.push(sectionId);
    }
    if (serialized.isLocked) {
      lockedSectionIds.push(sectionId);
    }
  });

  const activeSectionId = Object.entries(sectionTimes).find(
    ([, timer]) => timer.isActive && !timer.isLocked
  )?.[0] || null;

  return {
    currentSectionId: currentSectionId || null,
    activeSectionId,
    navigationRule: navigationRule || SECTION_NAVIGATION_RULES.FREE,
    sectionTimes,
    completedSectionIds,
    lockedSectionIds,
    serverTime: now.toISOString(),
    warningThresholdSeconds: SECTION_TIMER_CONFIG.WARNING_THRESHOLD_SECONDS,
  };
};

const saveContextIfChanged = async ({ attempt, entries, now, currentSectionId, navigationRule, changed }) => {
  if (!changed) {
    return;
  }
  persistTimerState({
    attempt,
    entries,
    now,
    currentSectionId,
    navigationRule,
  });
  await attempt.save();
};

/**
 * Get all sections for a question paper
 */
export const getSectionsByQuestionPaper = async (questionPaperId) => {
  return Section.find({ questionPaperId, isActive: true })
    .sort({ order: 1 })
    .populate('questionPaperId', 'setName examId');
};

/**
 * Get section by ID
 */
export const getSectionById = async (sectionId) => {
  return Section.findById(sectionId).populate('questionPaperId', 'setName examId');
};

/**
 * Create a new section
 */
export const createSection = async (sectionData) => {
  const {
    questionPaperId,
    name,
    description,
    order,
    duration,
    marks,
    marksPerQuestion,
    negativeMarking,
    navigationRule,
    instructions,
    expectedQuestions,
  } = sectionData;

  const questionPaper = await QuestionPaper.findById(questionPaperId);
  if (!questionPaper) {
    throw new Error('Question paper not found');
  }

  const resolvedMarksPerQuestion = toNonNegativeInt(marksPerQuestion, 1);

  const section = new Section({
    questionPaperId,
    name,
    description: description || '',
    order: order !== undefined ? order : 0,
    duration: duration || 60,
    // `marks` is kept only as a legacy total snapshot; marksPerQuestion is
    // the source of truth going forward (see getSectionsWithStats).
    marks: marks || 0,
    marksPerQuestion: resolvedMarksPerQuestion,
    negativeMarking: negativeMarking || 0,
    navigationRule: navigationRule || SECTION_NAVIGATION_RULES.FREE,
    instructions: instructions || '',
    isActive: true,
    ...(expectedQuestions !== undefined ? { expectedQuestions: toNonNegativeInt(expectedQuestions, 25) } : {}),
  });

  const savedSection = await section.save();

  if (!questionPaper.sections) {
    questionPaper.sections = [];
  }
  questionPaper.sections.push(savedSection._id);
  await questionPaper.save();

  try {
    await syncExamDurationFromQuestionPaper(questionPaperId);
  } catch (error) {
    // Keep section creation resilient; exam duration sync can be retried on next section mutation.
    console.error('Failed to sync exam duration after section create:', error);
  }

  return savedSection;
};

/**
 * Update section
 */
export const updateSection = async (sectionId, updateData) => {
  const section = await Section.findById(sectionId);
  if (!section) {
    throw new Error('Section not found');
  }

  const previousMarksPerQuestion = section.marksPerQuestion;

  const allowedFields = [
    'name',
    'description',
    'duration',
    'order',
    'expectedQuestions',
    'navigationRule',
    'isActive',
    'marksPerQuestion',
    'negativeMarking',
  ];

  allowedFields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(updateData || {}, field)) return;
    if (field === 'duration') {
      const duration = Number(updateData.duration);
      if (!Number.isInteger(duration) || duration < 1) {
        throw new Error('Duration must be at least 1 minute');
      }
      section.duration = duration;
      return;
    }
    if (field === 'marksPerQuestion' || field === 'negativeMarking') {
      section[field] = toNonNegativeInt(updateData[field], section[field]);
      return;
    }
    section[field] = updateData[field];
  });
  const savedSection = await section.save();

  // Keep every already-assigned question's points in lockstep with the
  // section's configured marksPerQuestion — this is what "Points" reflects
  // in the builder, preview, candidate exam, scoring, evaluator, and results.
  if (savedSection.marksPerQuestion !== previousMarksPerQuestion) {
    await Question.updateMany(
      { sectionId: savedSection._id },
      { $set: { points: savedSection.marksPerQuestion } }
    );
    try {
      const questionPaper = await QuestionPaper.findById(savedSection.questionPaperId).select('examId');
      if (questionPaper?.examId) {
        await syncExamQuestionCount(questionPaper.examId);
      }
    } catch (error) {
      console.error('Failed to sync exam totals after section marksPerQuestion update:', error);
    }
  }

  try {
    await syncExamDurationFromQuestionPaper(section.questionPaperId);
  } catch (error) {
    console.error('Failed to sync exam duration after section update:', error);
  }

  return savedSection;
};

/**
 * Delete section (soft delete)
 */
export const deleteSection = async (sectionId) => {
  const section = await Section.findById(sectionId);
  if (!section) {
    throw new Error('Section not found');
  }

  const questionCount = await Question.countDocuments({ sectionId: section._id });
  if (questionCount > 0) {
    throw new Error('Cannot delete section with questions. Please reassign questions first.');
  }

  section.isActive = false;
  await section.save();

  const questionPaper = await QuestionPaper.findById(section.questionPaperId);
  if (questionPaper && questionPaper.sections) {
    questionPaper.sections = questionPaper.sections.filter(
      (id) => id.toString() !== sectionId.toString()
    );
    await questionPaper.save();
  }

  try {
    await syncExamDurationFromQuestionPaper(section.questionPaperId);
  } catch (error) {
    console.error('Failed to sync exam duration after section delete:', error);
  }

  return section;
};

/**
 * Reorder sections
 */
export const reorderSections = async (questionPaperId, sectionOrders) => {
  const updates = sectionOrders.map(({ sectionId, order }) => ({
    updateOne: {
      filter: { _id: sectionId, questionPaperId },
      update: { $set: { order } },
    },
  }));

  await Section.bulkWrite(updates);
  return getSectionsByQuestionPaper(questionPaperId);
};

/**
 * Returns persisted section progress snapshot for restore/heartbeat use cases.
 */
export const getAttemptSectionProgress = async (attemptId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const context = await buildAttemptContext(attempt);
  await saveContextIfChanged({ attempt, ...context });

  return buildSectionProgressState(context);
};

/**
 * Start or resume section timer for an attempt.
 * FREE mode: switch pauses previous section and resumes selected section.
 * NO_FREE mode: moving forward locks previous sections and prevents back-navigation.
 */
export const startSectionTimer = async (attemptId, sectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const context = await buildAttemptContext(attempt);
  const targetSectionId = toIdString(sectionId);
  const targetSection = context.sectionMap.get(targetSectionId);
  if (!targetSection) {
    throw new Error('Section not found');
  }

  const { entries, sections, now } = context;
  let { currentSectionId } = context;
  let { navigationRule } = context;
  let changed = context.changed;

  const currentSection = currentSectionId
    ? context.sectionMap.get(currentSectionId)
    : null;
  const currentEntry = currentSectionId ? entries.get(currentSectionId) : null;
  const targetEntry = entries.get(targetSectionId);

  const targetRule = normalizeNavigationRule(
    targetSection.navigationRule || navigationRule
  );
  navigationRule = targetRule;

  if (currentSectionId && currentSectionId !== targetSectionId) {
    if (isNoFreeNavigationRule(targetRule)) {
      if (currentSection && (targetSection.order ?? 0) < (currentSection.order ?? 0)) {
        throw new Error('Cannot return to previous sections in no-free navigation mode.');
      }

      // Lock all previous sections permanently once moving forward in no-free mode.
      sections.forEach((section) => {
        if ((section.order ?? 0) >= (targetSection.order ?? 0)) return;
        const entry = entries.get(section._id.toString());
        if (!entry) return;
        if (!entry.isLocked) {
          lockTimerEntry(entry, now, { forceZeroRemaining: true });
          changed = true;
        }
      });
    } else if (currentEntry) {
      if (pauseTimerEntry(currentEntry, now)) {
        changed = true;
      }
    }
  }

  if (!targetEntry) {
    throw new Error('Section timer state could not be initialized.');
  }

  if (targetEntry.isLocked || targetEntry.isCompleted) {
    throw new Error('Section is locked');
  }

  if (resumeTimerEntry(targetEntry, now)) {
    changed = true;
  }

  currentSectionId = targetSectionId;

  await saveContextIfChanged({
    attempt,
    entries,
    now,
    currentSectionId,
    navigationRule,
    changed: true,
  });

  const freshState = buildSectionProgressState({
    sections,
    entries,
    now,
    currentSectionId,
    navigationRule,
  });

  return {
    attempt,
    status: freshState.sectionTimes[targetSectionId] || null,
    sectionState: freshState,
  };
};

/**
 * Get server-authoritative section timer status.
 */
export const getSectionTimerStatus = async (attemptId, sectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const context = await buildAttemptContext(attempt);
  const targetSectionId = toIdString(sectionId);
  const targetSection = context.sectionMap.get(targetSectionId);
  if (!targetSection) {
    throw new Error('Section not found');
  }

  const { entries, sections, now } = context;
  let { currentSectionId, navigationRule } = context;
  let changed = context.changed;
  let nextSectionId = null;

  const targetEntry = entries.get(targetSectionId);
  if (targetEntry && targetEntry.remainingSeconds <= 0 && !targetEntry.isLocked) {
    lockTimerEntry(targetEntry, now, { forceZeroRemaining: true });
    changed = true;
  }

  if (isNoFreeNavigationRule(navigationRule)) {
    const currentEntry = currentSectionId ? entries.get(currentSectionId) : null;
    if (currentEntry?.isLocked || currentEntry?.isCompleted) {
      nextSectionId = getNextSectionId({
        sections,
        entries,
        fromSectionId: currentSectionId,
      });
      if (nextSectionId) {
        const nextEntry = entries.get(nextSectionId);
        if (nextEntry && resumeTimerEntry(nextEntry, now)) {
          changed = true;
        }
        currentSectionId = nextSectionId;
      }
    }
  }

  await saveContextIfChanged({
    attempt,
    entries,
    now,
    currentSectionId,
    navigationRule,
    changed,
  });

  const freshState = buildSectionProgressState({
    sections,
    entries,
    now,
    currentSectionId,
    navigationRule,
  });

  return {
    status: freshState.sectionTimes[targetSectionId] || null,
    sectionState: freshState,
    nextSectionId,
  };
};

/**
 * Lock section (manual submit or timer expiry).
 */
export const lockSection = async (attemptId, sectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const context = await buildAttemptContext(attempt);
  const targetSectionId = toIdString(sectionId);
  const targetSection = context.sectionMap.get(targetSectionId);
  if (!targetSection) {
    throw new Error('Section not found');
  }

  const { entries, sections, now } = context;
  let { currentSectionId, navigationRule } = context;
  let changed = context.changed;
  let nextSectionId = null;

  const targetEntry = entries.get(targetSectionId);
  if (!targetEntry) {
    throw new Error('Section timer state could not be initialized.');
  }

  if (lockTimerEntry(targetEntry, now, { forceZeroRemaining: true })) {
    changed = true;
  }

  if (isNoFreeNavigationRule(navigationRule)) {
    nextSectionId = getNextSectionId({
      sections,
      entries,
      fromSectionId: targetSectionId,
    });
    if (nextSectionId) {
      const nextEntry = entries.get(nextSectionId);
      if (nextEntry && resumeTimerEntry(nextEntry, now)) {
        changed = true;
      }
      currentSectionId = nextSectionId;
    } else {
      currentSectionId = targetSectionId;
    }
  } else if (currentSectionId === targetSectionId) {
    const unlocked = sections.find((section) => {
      const sectionIdValue = section._id.toString();
      const entry = entries.get(sectionIdValue);
      return !entry?.isLocked && !entry?.isCompleted;
    });
    currentSectionId = unlocked ? unlocked._id.toString() : targetSectionId;
  }

  await saveContextIfChanged({
    attempt,
    entries,
    now,
    currentSectionId,
    navigationRule,
    changed: true,
  });

  const freshState = buildSectionProgressState({
    sections,
    entries,
    now,
    currentSectionId,
    navigationRule,
  });

  return {
    attempt,
    status: freshState.sectionTimes[targetSectionId] || null,
    sectionState: freshState,
    nextSectionId,
  };
};

/**
 * Update time spent in section.
 * This endpoint remains for compatibility with existing clients.
 */
export const updateSectionTimeSpent = async (attemptId, sectionId, timeSpentSeconds) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const context = await buildAttemptContext(attempt);
  const targetSectionId = toIdString(sectionId);
  const targetSection = context.sectionMap.get(targetSectionId);
  if (!targetSection) {
    throw new Error('Section not found');
  }

  const { entries, now } = context;
  const entry = entries.get(targetSectionId);
  if (!entry) {
    throw new Error('Section timer state could not be initialized.');
  }

  entry.timeSpent = toNonNegativeInt(timeSpentSeconds, entry.timeSpent);
  entry.remainingSeconds = Math.max(entry.durationSeconds - entry.timeSpent, 0);
  if (entry.remainingSeconds <= 0) {
    lockTimerEntry(entry, now, { forceZeroRemaining: true });
  }

  persistTimerState({
    attempt,
    entries,
    now,
    currentSectionId: context.currentSectionId,
    navigationRule: context.navigationRule,
  });
  await attempt.save();

  const sectionState = buildSectionProgressState({
    sections: context.sections,
    entries,
    now,
    currentSectionId: context.currentSectionId,
    navigationRule: context.navigationRule,
  });

  return {
    attempt,
    status: sectionState.sectionTimes[targetSectionId] || null,
    sectionState,
  };
};

/**
 * Validate section navigation based on configured rule.
 */
export const validateSectionNavigation = async (attemptId, fromSectionId, toSectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  const context = await buildAttemptContext(attempt);
  const fromId = toIdString(fromSectionId);
  const toId = toIdString(toSectionId);

  const fromSection = context.sectionMap.get(fromId);
  const toSection = context.sectionMap.get(toId);

  if (!fromSection || !toSection) {
    throw new Error('Section not found');
  }

  if (fromSection.questionPaperId.toString() !== toSection.questionPaperId.toString()) {
    throw new Error('Sections must belong to the same question paper');
  }

  const rule = normalizeNavigationRule(
    toSection.navigationRule || fromSection.navigationRule || context.navigationRule
  );
  const toEntry = context.entries.get(toId);

  if (toEntry?.isLocked || toEntry?.isCompleted) {
    throw new Error('Section is locked');
  }

  if (isNoFreeNavigationRule(rule) && (toSection.order ?? 0) < (fromSection.order ?? 0)) {
    throw new Error('Cannot navigate backward in no-free navigation mode');
  }

  await saveContextIfChanged({ attempt, ...context });
  return true;
};

/**
 * Get all sections with question counts
 */
export const getSectionsWithStats = async (questionPaperId) => {
  const sections = await getSectionsByQuestionPaper(questionPaperId);

  const sectionsWithStats = await Promise.all(
    sections.map(async (section) => {
      const [questionCount, marksAgg] = await Promise.all([
        Question.countDocuments({ sectionId: section._id }),
        Question.aggregate([
          { $match: { sectionId: section._id } },
          { $group: { _id: null, totalMarks: { $sum: { $ifNull: ['$points', 0] } } } },
        ]),
      ]);
      const assignedMarks = Number.isFinite(Number(marksAgg?.[0]?.totalMarks))
        ? Math.max(0, Number(marksAgg[0].totalMarks))
        : 0;

      return {
        ...section.toObject(),
        questionCount,
        // Live totals — the authoritative "Section A · 10/10 assigned" and
        // marks figures. `marks` (legacy stored total) is kept for backward
        // compatibility only; consumers should prefer these live fields.
        assignedMarks,
        isOverCapacity: section.expectedQuestions > 0 && questionCount > section.expectedQuestions,
      };
    })
  );

  return sectionsWithStats;
};
