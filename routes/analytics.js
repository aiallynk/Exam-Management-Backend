import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import {
  getSectionDifficultyAnalysis,
  getQuestionSuccessRatio,
  getSectionDropoffAnalysis,
  getTimeAccuracyData,
  getExamAnalytics,
} from '../services/analyticsService.js';

const router = express.Router();

// Get comprehensive exam analytics
router.get('/exam/:examId', requireAuth, requireTenant, requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const analytics = await getExamAnalytics(req.params.examId);
    res.json({ analytics });
  } catch (error) {
    next(error);
  }
});

// Get section difficulty analysis
router.get('/exam/:examId/sections/difficulty', requireAuth, requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const analysis = await getSectionDifficultyAnalysis(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json({ analysis });
  } catch (error) {
    next(error);
  }
});

// Get question success ratio
router.get('/exam/:examId/questions/success', requireAuth, requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const stats = await getQuestionSuccessRatio(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json({ stats });
  } catch (error) {
    next(error);
  }
});

// Get section drop-off analysis
router.get('/exam/:examId/sections/dropoff', requireAuth, requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const analysis = await getSectionDropoffAnalysis(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json({ analysis });
  } catch (error) {
    next(error);
  }
});

// Get time vs accuracy data
router.get('/exam/:examId/time-accuracy', requireAuth, requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), async (req, res, next) => {
  try {
    const data = await getTimeAccuracyData(
      req.params.examId,
      req.query.questionPaperId || null
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
