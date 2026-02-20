/**
 * Section Service
 * Handles section CRUD within QuestionPapers, timer management, and navigation rule enforcement
 */

import Section from '../models/Section.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import ExamAttempt from '../models/ExamAttempt.js';

/**
 * Get all sections for a question paper
 */
export const getSectionsByQuestionPaper = async (questionPaperId) => {
  return await Section.find({ questionPaperId, isActive: true })
    .sort({ order: 1 })
    .populate('questionPaperId', 'setName examId');
};

/**
 * Get section by ID
 */
export const getSectionById = async (sectionId) => {
  return await Section.findById(sectionId).populate('questionPaperId', 'setName examId');
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
    negativeMarking,
    navigationRule,
    instructions,
  } = sectionData;
  
  // Verify question paper exists
  const questionPaper = await QuestionPaper.findById(questionPaperId);
  if (!questionPaper) {
    throw new Error('Question paper not found');
  }
  
  const section = new Section({
    questionPaperId,
    name,
    description: description || '',
    order: order !== undefined ? order : 0,
    duration: duration || 60,
    marks: marks || 0,
    negativeMarking: negativeMarking || 0,
    navigationRule: navigationRule || 'FREE',
    instructions: instructions || '',
    isActive: true,
  });
  
  const savedSection = await section.save();
  
  // Update question paper sections array
  if (!questionPaper.sections) {
    questionPaper.sections = [];
  }
  questionPaper.sections.push(savedSection._id);
  await questionPaper.save();
  
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
  
  Object.assign(section, updateData);
  return await section.save();
};

/**
 * Delete section (soft delete)
 */
export const deleteSection = async (sectionId) => {
  const section = await Section.findById(sectionId);
  if (!section) {
    throw new Error('Section not found');
  }
  
  // Check if section has questions
  const questionCount = await Question.countDocuments({ sectionId: section._id });
  if (questionCount > 0) {
    throw new Error('Cannot delete section with questions. Please reassign questions first.');
  }
  
  section.isActive = false;
  await section.save();
  
  // Remove from question paper
  const questionPaper = await QuestionPaper.findById(section.questionPaperId);
  if (questionPaper && questionPaper.sections) {
    questionPaper.sections = questionPaper.sections.filter(
      id => id.toString() !== sectionId.toString()
    );
    await questionPaper.save();
  }
  
  return section;
};

/**
 * Reorder sections
 */
export const reorderSections = async (questionPaperId, sectionOrders) => {
  // sectionOrders is an array of { sectionId, order }
  const updates = sectionOrders.map(({ sectionId, order }) => ({
    updateOne: {
      filter: { _id: sectionId, questionPaperId },
      update: { $set: { order } },
    },
  }));
  
  await Section.bulkWrite(updates);
  return await getSectionsByQuestionPaper(questionPaperId);
};

/**
 * Start section timer for an attempt
 */
export const startSectionTimer = async (attemptId, sectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  const section = await Section.findById(sectionId);
  if (!section) {
    throw new Error('Section not found');
  }
  
  if (!attempt.sectionTimers) {
    attempt.sectionTimers = new Map();
  }

  const sectionKey = sectionId.toString();
  const existingTimer = attempt.sectionTimers.get(sectionKey);
  if (existingTimer) {
    const now = new Date();
    const existingEndTime = existingTimer.endTime ? new Date(existingTimer.endTime) : null;
    const isExpired = existingEndTime ? existingEndTime.getTime() <= now.getTime() : false;

    if (isExpired && !existingTimer.isLocked) {
      existingTimer.isLocked = true;
      attempt.sectionTimers.set(sectionKey, existingTimer);
      return await attempt.save();
    }

    // Do not reset timer if section was already started.
    return attempt;
  }
  
  const now = new Date();
  const endTime = new Date(now.getTime() + section.duration * 60 * 1000);
  
  attempt.sectionTimers.set(sectionKey, {
    startTime: now,
    endTime,
    isLocked: false,
    timeSpent: 0,
  });
  
  return await attempt.save();
};

/**
 * Get section timer status
 */
export const getSectionTimerStatus = async (attemptId, sectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  if (!attempt.sectionTimers) {
    return null;
  }
  
  const timer = attempt.sectionTimers.get(sectionId.toString());
  if (!timer) {
    return null;
  }
  
  const now = new Date();
  const remaining = Math.max(0, timer.endTime.getTime() - now.getTime());
  const isExpired = remaining === 0;
  
  return {
    ...timer,
    remainingSeconds: Math.floor(remaining / 1000),
    isExpired,
    isLocked: timer.isLocked || isExpired,
  };
};

/**
 * Lock section (when timer expires or manually)
 */
export const lockSection = async (attemptId, sectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  if (!attempt.sectionTimers) {
    attempt.sectionTimers = new Map();
  }
  
  const timer = attempt.sectionTimers.get(sectionId.toString());
  if (timer) {
    timer.isLocked = true;
    attempt.sectionTimers.set(sectionId.toString(), timer);
  } else {
    attempt.sectionTimers.set(sectionId.toString(), {
      startTime: new Date(),
      endTime: new Date(),
      isLocked: true,
      timeSpent: 0,
    });
  }
  
  return await attempt.save();
};

/**
 * Update time spent in section
 */
export const updateSectionTimeSpent = async (attemptId, sectionId, timeSpentSeconds) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  if (!attempt.sectionTimers) {
    attempt.sectionTimers = new Map();
  }
  
  const timer = attempt.sectionTimers.get(sectionId.toString());
  if (timer) {
    timer.timeSpent = timeSpentSeconds;
    attempt.sectionTimers.set(sectionId.toString(), timer);
  }
  
  return await attempt.save();
};

/**
 * Check navigation rule and validate section access
 */
export const validateSectionNavigation = async (attemptId, fromSectionId, toSectionId) => {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  const fromSection = await Section.findById(fromSectionId);
  const toSection = await Section.findById(toSectionId);
  
  if (!fromSection || !toSection) {
    throw new Error('Section not found');
  }
  
  // Check if sections belong to same question paper
  if (fromSection.questionPaperId.toString() !== toSection.questionPaperId.toString()) {
    throw new Error('Sections must belong to the same question paper');
  }
  
  // Check navigation rule
  if (toSection.navigationRule === 'LINEAR') {
    // Can only move forward
    if (toSection.order <= fromSection.order) {
      throw new Error('Cannot navigate backward in linear mode');
    }
  } else if (toSection.navigationRule === 'ADMIN_CONFIGURED') {
    // Check if section is locked
    const timerStatus = await getSectionTimerStatus(attemptId, toSectionId);
    if (timerStatus && timerStatus.isLocked) {
      throw new Error('Section is locked');
    }
  }
  // FREE mode allows any navigation
  
  return true;
};

/**
 * Get all sections with question counts
 */
export const getSectionsWithStats = async (questionPaperId) => {
  const sections = await getSectionsByQuestionPaper(questionPaperId);
  
  const sectionsWithStats = await Promise.all(
    sections.map(async (section) => {
      const questionCount = await Question.countDocuments({
        sectionId: section._id,
      });
      
      return {
        ...section.toObject(),
        questionCount,
      };
    })
  );
  
  return sectionsWithStats;
};
