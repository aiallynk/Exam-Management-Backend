/**
 * Analytics Service
 * Provides section-wise difficulty analysis, question success ratios,
 * candidate drop-off per section, and time vs accuracy metrics
 */

import ExamAttempt from '../models/ExamAttempt.js';
import Answer from '../models/Answer.js';
import Question from '../models/Question.js';
import Section from '../models/Section.js';
import Exam from '../models/Exam.js';

/**
 * Get section-wise difficulty analysis
 */
export const getSectionDifficultyAnalysis = async (examId, questionPaperId = null) => {
  const query = { examId };
  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }
  
  const attempts = await ExamAttempt.find({
    ...query,
    isCompleted: true,
    isDisqualified: false,
  });
  
  if (attempts.length === 0) {
    return [];
  }
  
  // Get all sections for the question paper(s)
  const sections = await Section.find({
    questionPaperId: questionPaperId || { $exists: true },
    isActive: true,
  }).sort({ order: 1 });
  
  const sectionAnalysis = await Promise.all(
    sections.map(async (section) => {
      const questions = await Question.find({ sectionId: section._id });
      const questionIds = questions.map(q => q._id);
      
      if (questionIds.length === 0) {
        return {
          sectionId: section._id,
          sectionName: section.name,
          totalQuestions: 0,
          totalAttempts: 0,
          averageScore: 0,
          averageTimeSpent: 0,
          difficulty: 'N/A',
        };
      }
      
      // Get all answers for questions in this section
      const answers = await Answer.find({
        attemptId: { $in: attempts.map(a => a._id) },
        questionId: { $in: questionIds },
      }).populate('questionId', 'points');
      
      // Calculate statistics
      const questionStats = {};
      questions.forEach(q => {
        questionStats[q._id.toString()] = {
          questionId: q._id,
          questionText: q.questionText.substring(0, 50),
          totalAttempts: 0,
          correctAttempts: 0,
          totalTimeSpent: 0,
          points: q.points,
        };
      });
      
      answers.forEach(answer => {
        const qId = answer.questionId._id.toString();
        if (questionStats[qId]) {
          questionStats[qId].totalAttempts++;
          if (answer.isCorrect) {
            questionStats[qId].correctAttempts++;
          }
          questionStats[qId].totalTimeSpent += answer.timeSpent || 0;
        }
      });
      
      const questionStatsArray = Object.values(questionStats);
      const totalAttempts = questionStatsArray.reduce((sum, q) => sum + q.totalAttempts, 0);
      const totalCorrect = questionStatsArray.reduce((sum, q) => sum + q.correctAttempts, 0);
      const totalTimeSpent = questionStatsArray.reduce((sum, q) => sum + q.totalTimeSpent, 0);
      
      const averageScore = totalAttempts > 0 ? (totalCorrect / totalAttempts) * 100 : 0;
      const averageTimeSpent = totalAttempts > 0 ? totalTimeSpent / totalAttempts : 0;
      
      // Determine difficulty
      let difficulty = 'MEDIUM';
      if (averageScore >= 80) {
        difficulty = 'EASY';
      } else if (averageScore < 50) {
        difficulty = 'HARD';
      }
      
      return {
        sectionId: section._id,
        sectionName: section.name,
        totalQuestions: questions.length,
        totalAttempts,
        averageScore: Math.round(averageScore * 100) / 100,
        averageTimeSpent: Math.round(averageTimeSpent),
        difficulty,
        questionStats: questionStatsArray,
      };
    })
  );
  
  return sectionAnalysis;
};

/**
 * Get question success ratio
 */
export const getQuestionSuccessRatio = async (examId, questionPaperId = null) => {
  const query = { examId };
  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }
  
  const attempts = await ExamAttempt.find({
    ...query,
    isCompleted: true,
    isDisqualified: false,
  });
  
  if (attempts.length === 0) {
    return [];
  }
  
  const questionQuery = { questionPaperId: questionPaperId || { $exists: true } };
  const questions = await Question.find(questionQuery).sort({ order: 1 });
  
  const questionStats = await Promise.all(
    questions.map(async (question) => {
      const answers = await Answer.find({
        attemptId: { $in: attempts.map(a => a._id) },
        questionId: question._id,
      });
      
      const totalAttempts = answers.length;
      const correctAttempts = answers.filter(a => a.isCorrect).length;
      const successRatio = totalAttempts > 0 ? (correctAttempts / totalAttempts) * 100 : 0;
      const averageTimeSpent = totalAttempts > 0
        ? answers.reduce((sum, a) => sum + (a.timeSpent || 0), 0) / totalAttempts
        : 0;
      
      return {
        questionId: question._id,
        questionText: question.questionText.substring(0, 100),
        questionType: question.questionType,
        order: question.order,
        points: question.points,
        totalAttempts,
        correctAttempts,
        incorrectAttempts: totalAttempts - correctAttempts,
        successRatio: Math.round(successRatio * 100) / 100,
        averageTimeSpent: Math.round(averageTimeSpent),
      };
    })
  );
  
  return questionStats;
};

/**
 * Get candidate drop-off per section
 */
export const getSectionDropoffAnalysis = async (examId, questionPaperId = null) => {
  const query = { examId };
  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }
  
  const attempts = await ExamAttempt.find({
    ...query,
    isCompleted: false, // Incomplete attempts
    isDisqualified: false,
  });
  
  const sections = await Section.find({
    questionPaperId: questionPaperId || { $exists: true },
    isActive: true,
  }).sort({ order: 1 });
  
  const dropoffAnalysis = await Promise.all(
    sections.map(async (section, index) => {
      const questions = await Question.find({ sectionId: section._id });
      const questionIds = questions.map(q => q._id);
      
      // Count attempts that started but didn't complete this section
      const sectionAttempts = attempts.filter(attempt => {
        // Check if attempt has answers for previous sections but not this one
        // This is a simplified check - in production, you'd track section progress more precisely
        return true; // Placeholder logic
      });
      
      return {
        sectionId: section._id,
        sectionName: section.name,
        sectionOrder: section.order,
        totalQuestions: questions.length,
        dropoffCount: sectionAttempts.length,
        dropoffPercentage: attempts.length > 0
          ? (sectionAttempts.length / attempts.length) * 100
          : 0,
      };
    })
  );
  
  return dropoffAnalysis;
};

/**
 * Get time vs accuracy graph data
 */
export const getTimeAccuracyData = async (examId, questionPaperId = null) => {
  const query = { examId };
  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }
  
  const attempts = await ExamAttempt.find({
    ...query,
    isCompleted: true,
    isDisqualified: false,
  });
  
  if (attempts.length === 0) {
    return [];
  }
  
  const timeAccuracyData = attempts.map(attempt => {
    const startTime = new Date(attempt.startTime);
    const submitTime = attempt.submitTime ? new Date(attempt.submitTime) : new Date();
    const totalTimeMinutes = (submitTime - startTime) / (1000 * 60);
    const accuracy = attempt.scoreSummary?.percentage || 0;
    
    return {
      attemptId: attempt._id,
      userId: attempt.userId,
      totalTimeMinutes: Math.round(totalTimeMinutes),
      accuracy: Math.round(accuracy * 100) / 100,
      score: attempt.scoreSummary?.totalScore || 0,
      maxScore: attempt.scoreSummary?.maxScore || 0,
    };
  });
  
  // Group by time ranges for visualization
  const timeRanges = [
    { min: 0, max: 30, label: '0-30 min' },
    { min: 30, max: 60, label: '30-60 min' },
    { min: 60, max: 90, label: '60-90 min' },
    { min: 90, max: 120, label: '90-120 min' },
    { min: 120, max: Infinity, label: '120+ min' },
  ];
  
  const groupedData = timeRanges.map(range => {
    const rangeData = timeAccuracyData.filter(
      d => d.totalTimeMinutes >= range.min && d.totalTimeMinutes < range.max
    );
    
    const averageAccuracy = rangeData.length > 0
      ? rangeData.reduce((sum, d) => sum + d.accuracy, 0) / rangeData.length
      : 0;
    
    return {
      timeRange: range.label,
      minMinutes: range.min,
      maxMinutes: range.max === Infinity ? null : range.max,
      attemptCount: rangeData.length,
      averageAccuracy: Math.round(averageAccuracy * 100) / 100,
      dataPoints: rangeData,
    };
  });
  
  return {
    rawData: timeAccuracyData,
    groupedData,
  };
};

/**
 * Get comprehensive exam analytics
 */
export const getExamAnalytics = async (examId) => {
  const exam = await Exam.findById(examId);
  if (!exam) {
    throw new Error('Exam not found');
  }
  
  const attempts = await ExamAttempt.find({
    examId,
    isCompleted: true,
    isDisqualified: false,
  });
  
  const totalAttempts = attempts.length;
  const totalCandidates = new Set(attempts.map(a => a.userId.toString())).size;
  
  const scores = attempts.map(a => a.scoreSummary?.percentage || 0);
  const averageScore = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;
  
  const sortedScores = [...scores].sort((a, b) => a - b);
  const medianScore = sortedScores.length > 0
    ? sortedScores[Math.floor(sortedScores.length / 2)]
    : 0;
  
  const sectionAnalysis = await getSectionDifficultyAnalysis(examId);
  const questionStats = await getQuestionSuccessRatio(examId);
  const timeAccuracyData = await getTimeAccuracyData(examId);
  
  return {
    examId,
    examTitle: exam.title,
    totalAttempts,
    totalCandidates,
    averageScore: Math.round(averageScore * 100) / 100,
    medianScore: Math.round(medianScore * 100) / 100,
    minScore: sortedScores.length > 0 ? Math.min(...scores) : 0,
    maxScore: sortedScores.length > 0 ? Math.max(...scores) : 0,
    sectionAnalysis,
    questionStats,
    timeAccuracyData,
  };
};
