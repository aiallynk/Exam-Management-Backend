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
import QuestionPaper from '../models/QuestionPaper.js';

const roundMetric = (value, digits = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
};

const normalizeId = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) {
    return String(value._id);
  }
  return String(value);
};

const buildScoreBands = (values = []) => {
  const bands = [
    { min: 0, max: 20, label: '0-20' },
    { min: 20, max: 40, label: '20-40' },
    { min: 40, max: 60, label: '40-60' },
    { min: 60, max: 80, label: '60-80' },
    { min: 80, max: 100, label: '80-100' },
  ];

  return bands.map((band, index) => {
    const isLastBand = index === bands.length - 1;
    return {
      label: band.label,
      min: band.min,
      max: band.max,
      count: values.filter((value) => {
        if (value < band.min) return false;
        if (isLastBand) return value <= band.max;
        return value < band.max;
      }).length,
    };
  });
};

const buildDailyPerformanceTrend = ({ attempts = [], examLookup = new Map() } = {}) => {
  const byDate = new Map();

  attempts.forEach((attempt) => {
    const exam = examLookup.get(normalizeId(attempt.examId));
    if (!exam) return;
    const percentage = getAttemptPercentage(attempt);
    const threshold = Number.isFinite(Number(exam.passingPercentage))
      ? Number(exam.passingPercentage)
      : 60;
    const dateSource = attempt.submitTime || attempt.submittedAt || attempt.createdAt;
    const date = new Date(dateSource);
    if (Number.isNaN(date.getTime())) return;
    const dateKey = date.toISOString().split('T')[0];

    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, {
        date: dateKey,
        attempts: 0,
        totalScore: 0,
        passed: 0,
      });
    }

    const day = byDate.get(dateKey);
    day.attempts += 1;
    day.totalScore += percentage;
    if (percentage >= threshold) {
      day.passed += 1;
    }
  });

  return [...byDate.values()]
    .map((day) => ({
      date: day.date,
      attempts: day.attempts,
      averageScore: day.attempts > 0 ? roundMetric(day.totalScore / day.attempts) : 0,
      passRate: day.attempts > 0 ? roundMetric((day.passed / day.attempts) * 100) : 0,
    }))
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
};

const buildCandidatePerformanceInsights = ({ attempts = [], examLookup = new Map() } = {}) => {
  const byCandidate = new Map();

  attempts.forEach((attempt) => {
    const candidateId = normalizeId(attempt.userId);
    if (!candidateId) return;
    const exam = examLookup.get(normalizeId(attempt.examId));
    if (!exam) return;

    const percentage = getAttemptPercentage(attempt);
    const threshold = Number.isFinite(Number(exam.passingPercentage))
      ? Number(exam.passingPercentage)
      : 60;

    if (!byCandidate.has(candidateId)) {
      byCandidate.set(candidateId, {
        userId: candidateId,
        attempts: 0,
        passed: 0,
        totalScore: 0,
        bestScore: null,
        lastAttemptAt: null,
      });
    }

    const entry = byCandidate.get(candidateId);
    entry.attempts += 1;
    entry.totalScore += percentage;
    entry.bestScore =
      entry.bestScore === null ? percentage : Math.max(entry.bestScore, percentage);
    if (percentage >= threshold) {
      entry.passed += 1;
    }

    const attemptDate = new Date(attempt.submitTime || attempt.submittedAt || attempt.createdAt || 0);
    if (!Number.isNaN(attemptDate.getTime())) {
      const entryDate = entry.lastAttemptAt ? new Date(entry.lastAttemptAt) : null;
      if (!entryDate || attemptDate > entryDate) {
        entry.lastAttemptAt = attemptDate.toISOString();
      }
    }
  });

  const candidateRows = [...byCandidate.values()].map((entry) => {
    const averageScore = entry.attempts > 0 ? entry.totalScore / entry.attempts : 0;
    const passRate = entry.attempts > 0 ? (entry.passed / entry.attempts) * 100 : 0;

    return {
      userId: entry.userId,
      attempts: entry.attempts,
      averageScore: roundMetric(averageScore),
      passRate: roundMetric(passRate),
      bestScore: roundMetric(entry.bestScore || 0),
      lastAttemptAt: entry.lastAttemptAt,
    };
  });

  const topPerformers = [...candidateRows]
    .sort(
      (left, right) =>
        right.averageScore - left.averageScore ||
        right.passRate - left.passRate ||
        right.attempts - left.attempts
    )
    .slice(0, 10);

  const needsAttention = [...candidateRows]
    .filter((item) => item.attempts >= 2)
    .sort(
      (left, right) =>
        left.averageScore - right.averageScore ||
        left.passRate - right.passRate ||
        right.attempts - left.attempts
    )
    .slice(0, 10);

  return {
    totalCandidates: candidateRows.length,
    topPerformers,
    needsAttention,
  };
};

const summarizeQuestionDifficulty = (questionStats = []) => {
  const summary = {
    total: questionStats.length,
    easy: 0,
    medium: 0,
    hard: 0,
    unrated: 0,
  };

  questionStats.forEach((question) => {
    const difficulty = String(question?.difficulty || '').toUpperCase();
    if (difficulty === 'EASY') {
      summary.easy += 1;
    } else if (difficulty === 'MEDIUM') {
      summary.medium += 1;
    } else if (difficulty === 'HARD') {
      summary.hard += 1;
    } else {
      summary.unrated += 1;
    }
  });

  return summary;
};

const buildAdvancedInsights = ({
  attempts = [],
  scores = [],
  percentiles = [],
  examLookup = new Map(),
  performance = [],
  questionStats = [],
} = {}) => ({
  scoreDistribution: buildScoreBands(scores),
  percentileDistribution: buildScoreBands(percentiles),
  dailyPerformanceTrend: buildDailyPerformanceTrend({ attempts, examLookup }),
  candidatePerformance: buildCandidatePerformanceInsights({ attempts, examLookup }),
  examLevelAnalysis: [...(Array.isArray(performance) ? performance : [])].sort(
    (left, right) => (right.averageScore || 0) - (left.averageScore || 0)
  ),
  questionDifficultySummary: summarizeQuestionDifficulty(questionStats),
});

const buildCompletedAttemptQuery = (examId, questionPaperId = null) => {
  const query = {
    examId,
    isCompleted: true,
    isDisqualified: false,
  };

  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }

  return query;
};

const resolveQuestionPaperIdsForExam = async (examId, questionPaperId = null) => {
  if (questionPaperId) {
    return [questionPaperId];
  }

  const papers = await QuestionPaper.find({
    examId,
    isActive: true,
  })
    .select('_id')
    .lean();

  return papers.map((paper) => paper._id);
};

const buildQuestionPaperQuery = (questionPaperIds, questionPaperId = null) => {
  if (questionPaperId) {
    return questionPaperId;
  }

  if (!Array.isArray(questionPaperIds) || questionPaperIds.length === 0) {
    return null;
  }

  return { $in: questionPaperIds };
};

const classifyDifficultyFromSuccessRatio = (successRatio) => {
  if (successRatio >= 80) return 'EASY';
  if (successRatio < 50) return 'HARD';
  return 'MEDIUM';
};

const getAttemptPercentage = (attempt) => {
  return Number(attempt?.scoreSummary?.percentage) || 0;
};

/**
 * Get section-wise difficulty analysis
 */
export const getSectionDifficultyAnalysis = async (examId, questionPaperId = null) => {
  const questionPaperIds = await resolveQuestionPaperIdsForExam(examId, questionPaperId);
  const questionPaperQuery = buildQuestionPaperQuery(questionPaperIds, questionPaperId);
  if (!questionPaperQuery) {
    return [];
  }

  const attempts = await ExamAttempt.find(buildCompletedAttemptQuery(examId, questionPaperId));

  if (attempts.length === 0) {
    return [];
  }

  // Get all sections for the question paper(s)
  const sections = await Section.find({
    questionPaperId: questionPaperQuery,
    isActive: true,
  })
    .sort({ order: 1 })
    .lean();

  const sectionAnalysis = await Promise.all(
    sections.map(async (section) => {
      const questions = await Question.find({ sectionId: section._id })
        .select('_id questionText points')
        .lean();
      const questionIds = questions.map((q) => q._id);

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
      })
        .populate('questionId', 'points');

      // Calculate statistics
      const questionStats = {};
      questions.forEach(q => {
        questionStats[q._id.toString()] = {
          questionId: q._id,
          questionText: String(q.questionText || '').substring(0, 50),
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

      return {
        sectionId: section._id,
        sectionName: section.name,
        totalQuestions: questions.length,
        totalAttempts,
        averageScore: roundMetric(averageScore),
        averageTimeSpent: Math.round(averageTimeSpent),
        difficulty: classifyDifficultyFromSuccessRatio(averageScore),
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
  const questionPaperIds = await resolveQuestionPaperIdsForExam(examId, questionPaperId);
  const questionPaperQuery = buildQuestionPaperQuery(questionPaperIds, questionPaperId);
  if (!questionPaperQuery) {
    return [];
  }

  const attempts = await ExamAttempt.find(buildCompletedAttemptQuery(examId, questionPaperId));

  if (attempts.length === 0) {
    return [];
  }

  const questionQuery = { questionPaperId: questionPaperQuery };
  const questions = await Question.find(questionQuery)
    .select('questionText questionType questionFormat options correctAnswer points order title')
    .sort({ order: 1 })
    .lean();

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
        questionText: String(question.questionText || question.title || '').substring(0, 100),
        questionType: question.questionType,
        questionFormat: question.questionFormat,
        order: question.order,
        points: question.points,
        options: Array.isArray(question.options) ? question.options : [],
        correctAnswer: question.correctAnswer || '',
        totalAttempts,
        correctAttempts,
        incorrectAttempts: totalAttempts - correctAttempts,
        successRatio: roundMetric(successRatio),
        averageTimeSpent: Math.round(averageTimeSpent),
        difficulty: classifyDifficultyFromSuccessRatio(successRatio),
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
  
  const questionPaperIds = await resolveQuestionPaperIdsForExam(examId, questionPaperId);
  const questionPaperQuery = buildQuestionPaperQuery(questionPaperIds, questionPaperId);
  if (!questionPaperQuery) {
    return [];
  }

  const sections = await Section.find({
    questionPaperId: questionPaperQuery,
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
  const attempts = await ExamAttempt.find(buildCompletedAttemptQuery(examId, questionPaperId));

  if (attempts.length === 0) {
    return [];
  }
  
  const timeAccuracyData = attempts.map(attempt => {
    const startTime = new Date(attempt.startTime);
    const submitTime = attempt.submitTime ? new Date(attempt.submitTime) : new Date();
    const totalTimeMinutes = (submitTime - startTime) / (1000 * 60);
    const accuracy = getAttemptPercentage(attempt);
    
    return {
      attemptId: attempt._id,
      userId: attempt.userId,
      totalTimeMinutes: Math.round(totalTimeMinutes),
      accuracy: roundMetric(accuracy),
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
      averageAccuracy: roundMetric(averageAccuracy),
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

  const attempts = await ExamAttempt.find(buildCompletedAttemptQuery(examId));

  const totalAttempts = attempts.length;
  const totalCandidates = new Set(attempts.map(a => a.userId.toString())).size;

  const scores = attempts.map((attempt) => getAttemptPercentage(attempt));
  const averageScore = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;

  const sortedScores = [...scores].sort((a, b) => a - b);
  const medianScore = sortedScores.length > 0
    ? sortedScores[Math.floor(sortedScores.length / 2)]
    : 0;
  const passingThreshold = Number.isFinite(Number(exam.passingPercentage))
    ? Number(exam.passingPercentage)
    : 60;
  const passCount = attempts.filter((attempt) => getAttemptPercentage(attempt) >= passingThreshold).length;
  const failCount = Math.max(totalAttempts - passCount, 0);
  const sectionAnalysis = await getSectionDifficultyAnalysis(examId);
  const questionStats = await getQuestionSuccessRatio(examId);
  const timeAccuracyData = await getTimeAccuracyData(examId);

  return {
    examId,
    examTitle: exam.title,
    totalAttempts,
    totalCandidates,
    totalStudents: totalCandidates,
    averageScore: roundMetric(averageScore),
    medianScore: roundMetric(medianScore),
    minScore: sortedScores.length > 0 ? Math.min(...scores) : 0,
    maxScore: sortedScores.length > 0 ? Math.max(...scores) : 0,
    passCount,
    failCount,
    passedCount: passCount,
    failedCount: failCount,
    sectionAnalysis,
    questionStats,
    timeAccuracyData,
  };
};

const buildEmptyDashboardAnalytics = ({ exams, selectedExamId }) => ({
  exams: exams.map((exam) => ({
    _id: exam._id,
    title: exam.title,
  })),
  totalExams: exams.length,
  totalAttempts: 0,
  totalStudents: 0,
  totalParticipants: 0,
  averageScore: 0,
  averagePercentile: 0,
  passCount: 0,
  failCount: 0,
  passedCount: 0,
  failedCount: 0,
  successRate: 0,
  activityTrend: [],
  charts: {
    performance: [],
  },
  performanceOverview: [],
  questionStats: [],
  emptyStateMessage: selectedExamId
    ? 'No candidates have attempted this exam yet.'
    : 'No candidates have attempted your exams yet.',
});

export const getTenantAnalyticsDashboard = async ({
  tenantId,
  viewerRole,
  viewerUserId,
  examId = null,
  startDate = null,
  endDate = null,
  includeAdvanced = false,
}) => {
  const examFilter = { tenantId };
  if (viewerRole === 'EXAM_CREATOR') {
    examFilter.createdBy = viewerUserId;
  }

  const exams = await Exam.find(examFilter)
    .select('_id title passingPercentage createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const examLookup = new Map(
    exams.map((exam) => [normalizeId(exam._id), exam])
  );
  const selectedExamId = examId && examLookup.has(normalizeId(examId))
    ? normalizeId(examId)
    : '';

  if (exams.length === 0) {
    const emptyResponse = buildEmptyDashboardAnalytics({ exams: [], selectedExamId });
    if (includeAdvanced) {
      emptyResponse.advancedInsights = buildAdvancedInsights();
      emptyResponse.reportsMode = 'advanced';
    }
    return emptyResponse;
  }

  const attemptFilter = {
    tenantId,
    examId: selectedExamId
      ? selectedExamId
      : { $in: exams.map((exam) => exam._id) },
    isCompleted: true,
    isDisqualified: false,
  };

  const dateRange = {};
  if (startDate instanceof Date && !Number.isNaN(startDate.getTime())) {
    dateRange.$gte = startDate;
  }
  if (endDate instanceof Date && !Number.isNaN(endDate.getTime())) {
    dateRange.$lte = endDate;
  }
  if (Object.keys(dateRange).length > 0) {
    attemptFilter.$or = [
      { submitTime: dateRange },
      { submittedAt: dateRange },
      { createdAt: dateRange },
    ];
  }

  const attempts = await ExamAttempt.find(attemptFilter)
    .select('_id examId userId submitTime submittedAt createdAt scoreSummary percentile')
    .lean();

  const baseResponse = buildEmptyDashboardAnalytics({ exams, selectedExamId });

  const selectedQuestionStats = selectedExamId
    ? (() => resolveQuestionPaperIdsForExam(selectedExamId))()
    : Promise.resolve([]);

  if (attempts.length === 0) {
    const questionPaperIds = await selectedQuestionStats;
    if (selectedExamId && questionPaperIds.length > 0) {
      const questions = await Question.find({
        questionPaperId: { $in: questionPaperIds },
      })
        .select('questionText title questionType questionFormat options correctAnswer points order')
        .sort({ order: 1, createdAt: 1 })
        .lean();

      baseResponse.questionStats = questions.map((question, index) => ({
        questionId: question._id,
        questionText: String(question.questionText || question.title || '').trim(),
        questionType: question.questionType,
        questionFormat: question.questionFormat,
        order: Number.isFinite(Number(question.order)) ? Number(question.order) : index + 1,
        points: Number(question.points) || 0,
        options: Array.isArray(question.options) ? question.options : [],
        correctAnswer: question.correctAnswer || '',
        totalAttempts: 0,
        correctAttempts: 0,
        incorrectAttempts: 0,
        successRatio: 0,
        difficulty: 'MEDIUM',
      }));
    }

    if (includeAdvanced) {
      baseResponse.advancedInsights = buildAdvancedInsights({
        attempts: [],
        scores: [],
        percentiles: [],
        examLookup,
        performance: [],
        questionStats: baseResponse.questionStats,
      });
      baseResponse.reportsMode = 'advanced';
    }

    return baseResponse;
  }

  let passedCount = 0;
  let failedCount = 0;
  const uniqueStudents = new Set();
  const scores = [];
  const percentiles = [];
  const trendMap = new Map();
  const examPerformanceMap = new Map();

  attempts.forEach((attempt) => {
    const normalizedExamId = normalizeId(attempt.examId);
    const exam = examLookup.get(normalizedExamId);
    if (!exam) {
      return;
    }

    const percentage = getAttemptPercentage(attempt);
    const percentile = Number(attempt.percentile);
    const threshold = Number.isFinite(Number(exam.passingPercentage))
      ? Number(exam.passingPercentage)
      : 60;
    const dateValue = attempt.submitTime || attempt.submittedAt || attempt.createdAt;
    const dateKey = new Date(dateValue).toISOString().split('T')[0];

    scores.push(percentage);
    if (Number.isFinite(percentile)) {
      percentiles.push(percentile);
    }
    uniqueStudents.add(normalizeId(attempt.userId));
    if (percentage >= threshold) {
      passedCount += 1;
    } else {
      failedCount += 1;
    }

    trendMap.set(dateKey, (trendMap.get(dateKey) || 0) + 1);

    if (!examPerformanceMap.has(normalizedExamId)) {
      examPerformanceMap.set(normalizedExamId, {
        attempts: 0,
        passed: 0,
        totalScore: 0,
        maxScore: null,
        minScore: null,
      });
    }

    const performanceEntry = examPerformanceMap.get(normalizedExamId);
    performanceEntry.attempts += 1;
    performanceEntry.totalScore += percentage;
    performanceEntry.maxScore =
      performanceEntry.maxScore === null
        ? percentage
        : Math.max(performanceEntry.maxScore, percentage);
    performanceEntry.minScore =
      performanceEntry.minScore === null
        ? percentage
        : Math.min(performanceEntry.minScore, percentage);
    if (percentage >= threshold) {
      performanceEntry.passed += 1;
    }
  });

  const activityTrend = [...trendMap.entries()]
    .map(([date, count]) => ({
      date,
      attempts: count,
    }))
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());

  const performanceSource = selectedExamId
    ? exams.filter((exam) => normalizeId(exam._id) === selectedExamId)
    : exams;

  const performance = performanceSource
    .map((exam) => {
      const stats = examPerformanceMap.get(normalizeId(exam._id));
      if (!stats || stats.attempts === 0) {
        return null;
      }

      const averageExamScore = stats.totalScore / stats.attempts;
      const passRate = (stats.passed / stats.attempts) * 100;

      return {
        id: exam._id,
        examId: exam._id,
        name: exam.title,
        examTitle: exam.title,
        attempts: stats.attempts,
        score: roundMetric(averageExamScore),
        averageScore: roundMetric(averageExamScore),
        passRate: roundMetric(passRate),
        maxScore: roundMetric(stats.maxScore),
        minScore: roundMetric(stats.minScore),
      };
    })
    .filter(Boolean);

  const response = {
    exams: exams.map((exam) => ({
      _id: exam._id,
      title: exam.title,
    })),
    totalExams: exams.length,
    totalAttempts: attempts.length,
    totalStudents: uniqueStudents.size,
    totalParticipants: uniqueStudents.size,
    averageScore: roundMetric(
      scores.reduce((sum, value) => sum + value, 0) / scores.length
    ),
    averagePercentile: percentiles.length > 0
      ? roundMetric(percentiles.reduce((sum, value) => sum + value, 0) / percentiles.length)
      : 0,
    passCount: passedCount,
    failCount: failedCount,
    passedCount,
    failedCount,
    successRate: attempts.length > 0
      ? roundMetric((passedCount / attempts.length) * 100)
      : 0,
    activityTrend,
    charts: {
      performance,
    },
    performanceOverview: performance,
    questionStats: [],
    emptyStateMessage: selectedExamId
      ? 'No candidates have attempted this exam yet.'
      : 'No candidates have attempted your exams yet.',
  };

  if (includeAdvanced) {
    response.advancedInsights = buildAdvancedInsights({
      attempts,
      scores,
      percentiles,
      examLookup,
      performance,
      questionStats: response.questionStats,
    });
    response.reportsMode = 'advanced';
  }

  if (!selectedExamId) {
    return response;
  }

  const selectedExamQuestionPaperIds = await selectedQuestionStats;
  if (selectedExamQuestionPaperIds.length === 0) {
    return response;
  }

  const questions = await Question.find({
    questionPaperId: { $in: selectedExamQuestionPaperIds },
  })
    .select('questionText title questionType questionFormat options correctAnswer points order')
    .sort({ order: 1, createdAt: 1 })
    .lean();

  if (questions.length === 0) {
    return response;
  }

  const questionStatsMap = new Map(
    questions.map((question, index) => [
      normalizeId(question._id),
      {
        questionId: question._id,
        questionText: String(question.questionText || question.title || '').trim(),
        questionType: question.questionType,
        questionFormat: question.questionFormat,
        order: Number.isFinite(Number(question.order)) ? Number(question.order) : index + 1,
        points: Number(question.points) || 0,
        options: Array.isArray(question.options) ? question.options : [],
        correctAnswer: question.correctAnswer || '',
        totalAttempts: 0,
        correctAttempts: 0,
        incorrectAttempts: 0,
      },
    ])
  );

  const answers = await Answer.find({
    attemptId: { $in: attempts.map((attempt) => attempt._id) },
    questionId: { $in: questions.map((question) => question._id) },
  })
    .select('questionId isCorrect aiEvaluation')
    .lean();

  answers.forEach((answer) => {
    const entry = questionStatsMap.get(normalizeId(answer.questionId));
    if (!entry) {
      return;
    }

    entry.totalAttempts += 1;
    const codingPassed =
      answer?.aiEvaluation?.type === 'CODING' &&
      Number(answer?.aiEvaluation?.failed) === 0 &&
      Number(answer?.aiEvaluation?.passed) > 0;

    if (answer.isCorrect === true || codingPassed) {
      entry.correctAttempts += 1;
    } else {
      entry.incorrectAttempts += 1;
    }
  });

  response.questionStats = [...questionStatsMap.values()].map((entry) => {
    const successRatio = entry.totalAttempts > 0
      ? (entry.correctAttempts / entry.totalAttempts) * 100
      : 0;

    return {
      ...entry,
      successRatio: roundMetric(successRatio),
      difficulty: classifyDifficultyFromSuccessRatio(successRatio),
    };
  });

  if (includeAdvanced) {
    response.advancedInsights = buildAdvancedInsights({
      attempts,
      scores,
      percentiles,
      examLookup,
      performance,
      questionStats: response.questionStats,
    });
    response.reportsMode = 'advanced';
  }

  return response;
};
