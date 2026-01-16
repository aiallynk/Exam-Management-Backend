/**
 * Normalization Service
 * Handles normalized score calculations, percentile calculations, and recalculation logic
 */

import NormalizationConfig from '../models/NormalizationConfig.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamSession from '../models/ExamSession.js';
import Exam from '../models/Exam.js';
import Tenant from '../models/Tenant.js';

/**
 * Get or create normalization config for exam
 */
export const getNormalizationConfig = async (examId) => {
  let config = await NormalizationConfig.findOne({ examId });
  
  if (!config) {
    // Create default config
    config = new NormalizationConfig({
      examId,
      formulaType: 'PERCENTILE_RANK',
      isLocked: false,
      shiftBased: false,
      sessionBased: true,
      createdBy: null, // Will be set by route
    });
    await config.save();
  }
  
  return config;
};

/**
 * Get or create normalization config for tenant
 */
export const getTenantNormalizationConfig = async (tenantId) => {
  let config = await NormalizationConfig.findOne({ tenantId });
  
  if (!config) {
    // Create default config
    config = new NormalizationConfig({
      tenantId,
      formulaType: 'PERCENTILE_RANK',
      isLocked: false,
      shiftBased: false,
      sessionBased: false, // Tenant-level is not session-based
      createdBy: null, // Will be set by route
    });
    await config.save();
  }
  
  return config;
};

/**
 * Update normalization config
 */
export const updateNormalizationConfig = async (examId, configData, userId) => {
  let config = await NormalizationConfig.findOne({ examId });
  
  if (!config) {
    config = new NormalizationConfig({
      examId,
      ...configData,
      createdBy: userId,
    });
  } else {
    // Don't allow updating if locked
    if (config.isLocked) {
      throw new Error('Normalization config is locked and cannot be modified');
    }
    
    Object.assign(config, configData);
  }
  
  return await config.save();
};

/**
 * Update tenant normalization config
 */
export const updateTenantNormalizationConfig = async (tenantId, configData, userId) => {
  let config = await NormalizationConfig.findOne({ tenantId });
  
  if (!config) {
    config = new NormalizationConfig({
      tenantId,
      ...configData,
      sessionBased: false, // Tenant-level is not session-based
      createdBy: userId,
    });
  } else {
    // Don't allow updating if locked
    if (config.isLocked) {
      throw new Error('Tenant normalization config is locked and cannot be modified');
    }
    
    Object.assign(config, configData);
    // Ensure sessionBased is false for tenant-level configs
    config.sessionBased = false;
  }
  
  return await config.save();
};

/**
 * Lock normalization config
 */
export const lockNormalizationConfig = async (examId, userId) => {
  const config = await NormalizationConfig.findOne({ examId });
  if (!config) {
    throw new Error('Normalization config not found');
  }
  
  config.isLocked = true;
  return await config.save();
};

/**
 * Lock tenant normalization config
 */
export const lockTenantNormalizationConfig = async (tenantId, userId) => {
  const config = await NormalizationConfig.findOne({ tenantId });
  if (!config) {
    throw new Error('Tenant normalization config not found');
  }
  
  config.isLocked = true;
  return await config.save();
};

/**
 * Calculate percentile rank for a score
 */
const calculatePercentileRank = (score, allScores) => {
  if (allScores.length === 0) return 0;
  
  const sortedScores = [...allScores].sort((a, b) => a - b);
  const belowCount = sortedScores.filter(s => s < score).length;
  const equalCount = sortedScores.filter(s => s === score).length;
  
  // Percentile = (number of scores below + 0.5 * number of equal scores) / total * 100
  return ((belowCount + 0.5 * equalCount) / sortedScores.length) * 100;
};

/**
 * Calculate z-score
 */
const calculateZScore = (score, mean, stdDev) => {
  if (stdDev === 0) return 0;
  return (score - mean) / stdDev;
};

/**
 * Linear normalization
 */
const linearNormalize = (score, minScore, maxScore, targetMin = 0, targetMax = 100) => {
  if (maxScore === minScore) return targetMax;
  return ((score - minScore) / (maxScore - minScore)) * (targetMax - targetMin) + targetMin;
};

/**
 * Execute custom formula
 */
const executeCustomFormula = (formula, score, context) => {
  try {
    // Create safe evaluation context
    const safeContext = {
      score,
      mean: context.mean || 0,
      stdDev: context.stdDev || 1,
      min: context.min || 0,
      max: context.max || 100,
      percentile: context.percentile || 0,
      ...context,
    };
    
    // Replace variables in formula
    let formulaCode = formula;
    Object.keys(safeContext).forEach(key => {
      formulaCode = formulaCode.replace(new RegExp(`\\b${key}\\b`, 'g'), `safeContext.${key}`);
    });
    
    // Evaluate formula (in production, use a safer evaluator like mathjs)
    const func = new Function('safeContext', `return ${formulaCode}`);
    return func(safeContext);
  } catch (error) {
    console.error('Error executing custom formula:', error);
    return score; // Fallback to original score
  }
};

/**
 * Calculate normalized score for an attempt
 * Supports both exam-level and tenant-level normalization
 */
export const calculateNormalizedScore = async (attemptId, config) => {
  const attempt = await ExamAttempt.findById(attemptId).populate('sessionId').populate('examId');
  if (!attempt) {
    throw new Error('Attempt not found');
  }
  
  if (!attempt.isCompleted) {
    throw new Error('Attempt must be completed to calculate normalized score');
  }
  
  // If no config provided, try to get tenant-level config first, then exam-level
  if (!config) {
    const exam = await Exam.findById(attempt.examId);
    if (exam && exam.tenantId) {
      // Try tenant-level config first
      config = await NormalizationConfig.findOne({ tenantId: exam.tenantId });
    }
    
    // Fallback to exam-level config
    if (!config) {
      config = await getNormalizationConfig(attempt.examId);
    }
  }
  
  const rawScore = attempt.scoreSummary?.totalScore || 0;
  
  // Get all attempts for comparison
  let comparisonAttempts;
  
  // Check if this is a tenant-level config
  if (config.tenantId) {
    // Tenant-level: compare across all exams in the tenant
    const exam = await Exam.findById(attempt.examId);
    if (!exam || !exam.tenantId) {
      throw new Error('Attempt exam does not belong to a tenant');
    }
    
    // Get all exams in the tenant
    const tenantExams = await Exam.find({ tenantId: exam.tenantId });
    const examIds = tenantExams.map(e => e._id);
    
    comparisonAttempts = await ExamAttempt.find({
      examId: { $in: examIds },
      isCompleted: true,
      isDisqualified: false,
    });
  } else if (config.sessionBased && attempt.sessionId) {
    // Session-based: compare within session
    comparisonAttempts = await ExamAttempt.find({
      sessionId: attempt.sessionId,
      isCompleted: true,
      isDisqualified: false,
    });
  } else {
    // Exam-based: compare within exam
    comparisonAttempts = await ExamAttempt.find({
      examId: attempt.examId,
      isCompleted: true,
      isDisqualified: false,
    });
  }
  
  if (comparisonAttempts.length === 0) {
    // No comparison data, return raw score
    return {
      normalizedScore: rawScore,
      percentile: 0,
      sessionPercentile: 0,
    };
  }
  
  const scores = comparisonAttempts.map(a => a.scoreSummary?.totalScore || 0);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length;
  const stdDev = Math.sqrt(variance);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  
  let normalizedScore = rawScore;
  let percentile = 0;
  
  // Calculate based on formula type
  switch (config.formulaType) {
    case 'PERCENTILE_RANK':
      percentile = calculatePercentileRank(rawScore, scores);
      normalizedScore = percentile; // Use percentile as normalized score
      break;
      
    case 'Z_SCORE':
      const zScore = calculateZScore(rawScore, mean, stdDev);
      // Convert z-score to 0-100 scale (assuming normal distribution)
      normalizedScore = 50 + (zScore * 10); // Mean=50, stdDev=10
      normalizedScore = Math.max(0, Math.min(100, normalizedScore));
      percentile = calculatePercentileRank(rawScore, scores);
      break;
      
    case 'LINEAR':
      normalizedScore = linearNormalize(rawScore, minScore, maxScore);
      percentile = calculatePercentileRank(rawScore, scores);
      break;
      
    case 'CUSTOM':
      if (!config.customFormula) {
        throw new Error('Custom formula not provided');
      }
      const context = {
        score: rawScore,
        mean,
        stdDev,
        min: minScore,
        max: maxScore,
        percentile: calculatePercentileRank(rawScore, scores),
      };
      normalizedScore = executeCustomFormula(config.customFormula, rawScore, context);
      percentile = calculatePercentileRank(rawScore, scores);
      break;
      
    default:
      percentile = calculatePercentileRank(rawScore, scores);
      normalizedScore = rawScore;
  }
  
  // Calculate session percentile if session-based (only for exam-level configs, not tenant-level)
  let sessionPercentile = percentile;
  if (!config.tenantId && config.sessionBased && attempt.sessionId) {
    const sessionAttempts = await ExamAttempt.find({
      sessionId: attempt.sessionId,
      isCompleted: true,
      isDisqualified: false,
    });
    const sessionScores = sessionAttempts.map(a => a.scoreSummary?.totalScore || 0);
    sessionPercentile = calculatePercentileRank(rawScore, sessionScores);
  }
  
  return {
    normalizedScore: Math.round(normalizedScore * 100) / 100,
    percentile: Math.round(percentile * 100) / 100,
    sessionPercentile: Math.round(sessionPercentile * 100) / 100,
  };
};

/**
 * Recalculate normalized scores for all attempts in an exam
 */
export const recalculateExamNormalization = async (examId, userId) => {
  const config = await getNormalizationConfig(examId);
  
  if (config.isLocked) {
    throw new Error('Normalization is locked. Cannot recalculate.');
  }
  
  const exam = await Exam.findById(examId);
  if (!exam) {
    throw new Error('Exam not found');
  }
  
  // Get all completed attempts
  const attempts = await ExamAttempt.find({
    examId,
    isCompleted: true,
    isDisqualified: false,
  });
  
  const results = [];
  
  for (const attempt of attempts) {
    try {
      const normalized = await calculateNormalizedScore(attempt._id, config);
      
      attempt.normalizedScore = normalized.normalizedScore;
      attempt.percentile = normalized.percentile;
      attempt.sessionPercentile = normalized.sessionPercentile;
      
      await attempt.save();
      
      results.push({
        attemptId: attempt._id,
        success: true,
        normalizedScore: normalized.normalizedScore,
        percentile: normalized.percentile,
      });
    } catch (error) {
      results.push({
        attemptId: attempt._id,
        success: false,
        error: error.message,
      });
    }
  }
  
  // Update config
  config.lastRecalculatedAt = new Date();
  config.lastRecalculatedBy = userId;
  await config.save();
  
  // Update session normalization flags
  const sessions = await ExamSession.find({ examId });
  for (const session of sessions) {
    session.normalizationApplied = true;
    await session.save();
  }
  
  return {
    totalAttempts: attempts.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };
};

/**
 * Recalculate normalized scores for all attempts in a tenant
 */
export const recalculateTenantNormalization = async (tenantId, userId) => {
  const config = await getTenantNormalizationConfig(tenantId);
  
  if (config.isLocked) {
    throw new Error('Normalization is locked. Cannot recalculate.');
  }
  
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    throw new Error('Tenant not found');
  }
  
  // Get all exams in the tenant
  const exams = await Exam.find({ tenantId });
  const examIds = exams.map(e => e._id);
  
  if (examIds.length === 0) {
    return {
      totalAttempts: 0,
      successful: 0,
      failed: 0,
      results: [],
    };
  }
  
  // Get all completed attempts across all exams in tenant
  const attempts = await ExamAttempt.find({
    examId: { $in: examIds },
    isCompleted: true,
    isDisqualified: false,
  });
  
  const results = [];
  
  for (const attempt of attempts) {
    try {
      const normalized = await calculateNormalizedScore(attempt._id, config);
      
      attempt.normalizedScore = normalized.normalizedScore;
      attempt.percentile = normalized.percentile;
      attempt.sessionPercentile = normalized.sessionPercentile;
      
      await attempt.save();
      
      results.push({
        attemptId: attempt._id,
        examId: attempt.examId,
        success: true,
        normalizedScore: normalized.normalizedScore,
        percentile: normalized.percentile,
      });
    } catch (error) {
      results.push({
        attemptId: attempt._id,
        examId: attempt.examId,
        success: false,
        error: error.message,
      });
    }
  }
  
  // Update config
  config.lastRecalculatedAt = new Date();
  config.lastRecalculatedBy = userId;
  await config.save();
  
  return {
    totalAttempts: attempts.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };
};

/**
 * Get normalization statistics for an exam
 */
export const getNormalizationStats = async (examId) => {
  const attempts = await ExamAttempt.find({
    examId,
    isCompleted: true,
    isDisqualified: false,
  });
  
  if (attempts.length === 0) {
    return {
      totalAttempts: 0,
      normalizedAttempts: 0,
      averageRawScore: 0,
      averageNormalizedScore: 0,
      averagePercentile: 0,
    };
  }
  
  const rawScores = attempts.map(a => a.scoreSummary?.totalScore || 0);
  const normalizedScores = attempts
    .map(a => a.normalizedScore)
    .filter(s => s !== null && s !== undefined);
  const percentiles = attempts
    .map(a => a.percentile)
    .filter(p => p !== null && p !== undefined);
  
  return {
    totalAttempts: attempts.length,
    normalizedAttempts: normalizedScores.length,
    averageRawScore: rawScores.reduce((a, b) => a + b, 0) / rawScores.length,
    averageNormalizedScore: normalizedScores.length > 0
      ? normalizedScores.reduce((a, b) => a + b, 0) / normalizedScores.length
      : 0,
    averagePercentile: percentiles.length > 0
      ? percentiles.reduce((a, b) => a + b, 0) / percentiles.length
      : 0,
    minRawScore: Math.min(...rawScores),
    maxRawScore: Math.max(...rawScores),
    minNormalizedScore: normalizedScores.length > 0 ? Math.min(...normalizedScores) : 0,
    maxNormalizedScore: normalizedScores.length > 0 ? Math.max(...normalizedScores) : 0,
  };
};

/**
 * Get normalization statistics for a tenant
 */
export const getTenantNormalizationStats = async (tenantId) => {
  // Get all exams in the tenant
  const exams = await Exam.find({ tenantId });
  const examIds = exams.map(e => e._id);
  
  if (examIds.length === 0) {
    return {
      totalAttempts: 0,
      normalizedAttempts: 0,
      totalExams: 0,
      averageRawScore: 0,
      averageNormalizedScore: 0,
      averagePercentile: 0,
    };
  }
  
  // Get all completed attempts across all exams in tenant
  const attempts = await ExamAttempt.find({
    examId: { $in: examIds },
    isCompleted: true,
    isDisqualified: false,
  });
  
  if (attempts.length === 0) {
    return {
      totalAttempts: 0,
      normalizedAttempts: 0,
      totalExams: exams.length,
      averageRawScore: 0,
      averageNormalizedScore: 0,
      averagePercentile: 0,
    };
  }
  
  const rawScores = attempts.map(a => a.scoreSummary?.totalScore || 0);
  const normalizedScores = attempts
    .map(a => a.normalizedScore)
    .filter(s => s !== null && s !== undefined);
  const percentiles = attempts
    .map(a => a.percentile)
    .filter(p => p !== null && p !== undefined);
  
  return {
    totalAttempts: attempts.length,
    normalizedAttempts: normalizedScores.length,
    totalExams: exams.length,
    averageRawScore: rawScores.reduce((a, b) => a + b, 0) / rawScores.length,
    averageNormalizedScore: normalizedScores.length > 0
      ? normalizedScores.reduce((a, b) => a + b, 0) / normalizedScores.length
      : 0,
    averagePercentile: percentiles.length > 0
      ? percentiles.reduce((a, b) => a + b, 0) / percentiles.length
      : 0,
    minRawScore: Math.min(...rawScores),
    maxRawScore: Math.max(...rawScores),
    minNormalizedScore: normalizedScores.length > 0 ? Math.min(...normalizedScores) : 0,
    maxNormalizedScore: normalizedScores.length > 0 ? Math.max(...normalizedScores) : 0,
  };
};
