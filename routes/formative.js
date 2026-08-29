import express from 'express';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import FormativeAnswerCheck from '../models/FormativeAnswerCheck.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, enforceTenantBoundaries } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import Exam from '../models/Exam.js';
import { canOperateExam } from '../services/academicAccessService.js';
import { hasRole } from '../utils/userRoles.js';
const router = express.Router();
const normal = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const objectiveScore = (question, answer) => {
  const expected = question.correctAnswer;
  if (Array.isArray(expected)) return expected.map(normal).sort().join('|') === (Array.isArray(answer) ? answer : [answer]).map(normal).sort().join('|');
  return normal(expected) === normal(answer);
};
const OBJECTIVE_TYPES = new Set(['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE', 'NUMBER', 'FILL_IN_THE_BLANK', 'SHORT_ANSWER', 'MATCHING']);

router.post('/attempts/:attemptId/check-answer', requireAuth, requireTenant, enforceTenantBoundaries, async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, tenantId: req.user.tenantId, userId: req.user._id, isCompleted: false }).populate('examId', 'assessmentPurpose resolvedSpecificationSnapshot').lean();
    if (!attempt) return res.status(404).json({ error: 'Active assessment attempt not found.' });
    if (attempt.examId?.assessmentPurpose !== 'FOR') return res.status(403).json({ error: 'Immediate feedback is only available for Assessment FOR Learning.' });
    const policy = attempt.examId.resolvedSpecificationSnapshot?.specification?.feedback || {};
    if (policy.mode !== 'AFTER_QUESTION') return res.status(403).json({ error: 'This assessment policy does not permit per-question feedback.' });
    const question = await Question.findOne({ _id: req.body.questionId, questionPaperId: attempt.questionPaperId }).lean();
    if (!question) return res.status(404).json({ error: 'Question is not in this assessment.' });
    if (!OBJECTIVE_TYPES.has(question.questionType)) return res.status(422).json({ error: 'Immediate automated feedback is unavailable for this response type. You may continue; feedback can be reviewed later.', code: 'FORMATIVE_SUBJECTIVE_PENDING' });
    const prior = await FormativeAnswerCheck.countDocuments({ tenantId: req.user.tenantId, attemptId: attempt._id, questionId: question._id });
    if (Number.isFinite(Number(policy.retries)) && prior >= Number(policy.retries) + 1) return res.status(409).json({ error: 'The configured feedback retry limit has been reached.' });
    const isCorrect = objectiveScore(question, req.body.answer);
    const feedback = isCorrect ? (question.evaluationConfig?.correctFeedback || 'Correct. Continue to the next question.') : (question.evaluationConfig?.incorrectFeedback || 'Not yet correct. Review the concept and try again.');
    await FormativeAnswerCheck.create({ tenantId: req.user.tenantId, attemptId: attempt._id, questionId: question._id, userId: req.user._id, answer: typeof req.body.answer === 'string' ? req.body.answer : JSON.stringify(req.body.answer ?? ''), isCorrect, feedback });
    return res.json({
      isCorrect,
      feedback,
      retriesRemaining: Number.isFinite(Number(policy.retries)) ? Math.max(0, Number(policy.retries) - prior) : null,
      // `showCorrectAnswer` is a frozen assessment-specification decision.
      // A correct learner response must not silently override a false policy.
      correctAnswer: policy.showCorrectAnswer ? question.correctAnswer : undefined,
      explanation: policy.showCorrectAnswer ? (question.evaluationConfig?.explanation || '') : undefined,
    });
  } catch (error) { return next(error); }
});
router.post('/recommend-purpose', requireAuth, requireTenant, enforceTenantBoundaries, (req, res) => {
  const text = `${req.body?.intent || ''} ${req.body?.assessmentType || ''}`.toLowerCase();
  const purpose = /(practice|diagnostic|feedback|remediation|retry)/.test(text) ? 'FOR' : /(reflection|self.?assessment|portfolio)/.test(text) ? 'AS' : 'OF';
  res.json({ purpose, source: 'deterministic-recommendation', explanation: 'Recommendation only; the creator retains control and the application resolves policy.' });
});
router.get('/insights', requireAuth, requireTenant, enforceTenantBoundaries, requireRole('TENANT_ADMIN', 'ACADEMIC_ADMIN', 'TEACHER', 'EXAM_CREATOR'), async (req, res, next) => {
  try {
    const match = { tenantId: req.user.tenantId };
    if (req.query.examId) {
      const exam = await Exam.findOne({ _id: req.query.examId, tenantId: req.user.tenantId }).select('_id tenantId createdBy academicContext').lean();
      if (!exam) return res.status(404).json({ error: 'Assessment not found.' });
      if (!hasRole(req.user, 'TENANT_ADMIN') && !await canOperateExam(req.user, exam)) {
        return res.status(403).json({ error: 'This assessment is outside your assigned scope.' });
      }
      const attempts = await ExamAttempt.find({ tenantId: req.user.tenantId, examId: req.query.examId }).distinct('_id');
      match.attemptId = { $in: attempts };
    } else if (!hasRole(req.user, 'TENANT_ADMIN')) {
      return res.status(400).json({ error: 'Select an assessment to view scoped formative insights.' });
    }
    const rows = await FormativeAnswerCheck.aggregate([
      { $match: match },
      { $group: { _id: '$questionId', checks: { $sum: 1 }, correct: { $sum: { $cond: ['$isCorrect', 1, 0] } }, latestAt: { $max: '$checkedAt' } } },
      { $lookup: { from: 'questions', localField: '_id', foreignField: '_id', as: 'question' } },
      { $unwind: '$question' },
      { $project: { questionId: '$_id', questionText: '$question.questionText', category: '$question.category', checks: 1, correct: 1, retries: { $max: [{ $subtract: ['$checks', 1] }, 0] }, masteryPercent: { $round: [{ $multiply: [{ $divide: ['$correct', { $max: ['$checks', 1] }] }, 100] }, 1] }, latestAt: 1 } },
      { $sort: { masteryPercent: 1, checks: -1 } },
      { $limit: 25 },
    ]);
    return res.json({ items: rows, generatedAt: new Date().toISOString() });
  } catch (error) { return next(error); }
});
export default router;
