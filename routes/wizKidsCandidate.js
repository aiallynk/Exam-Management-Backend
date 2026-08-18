import express from 'express';
import ExamSession from '../models/ExamSession.js';
import WizKidsExamConfig from '../models/WizKidsExamConfig.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { requireRole } from '../middleware/roles.js';
import { canCandidateAccessSession } from '../middleware/examPermissions.js';
import { requireTenantFeature, resolveTenantFeature } from '../services/tenantFeatureService.js';

const MODE_CAPABILITY = Object.freeze({ PRACTICE: 'WIZKIDS_PRACTICE', SPEED: 'WIZKIDS_SPEED_MODE' });
const router = express.Router();
router.use(requireAuth, requireTenant, requireRole('CANDIDATE'), requireTenantFeature('WIZKIDS'));

router.get('/available', async (req, res, next) => {
  try {
    const sessions = await ExamSession.find({ tenantId: req.user.tenantId, isActive: true })
      .populate('examId', 'title description duration productModule maxAttempts')
      .populate('questionPaperId', 'setName')
      .sort({ startTime: 1 })
      .lean();
    const wizSessionRows = sessions.filter((session) => session.examId?.productModule === 'WIZKIDS');
    const configs = wizSessionRows.length
      ? await WizKidsExamConfig.find({ tenantId: req.user.tenantId, examId: { $in: wizSessionRows.map((session) => session.examId._id) } }).lean()
      : [];
    const configByExamId = new Map(configs.map((config) => [String(config.examId), config]));
    const modeStates = new Map();
    const available = [];
    const now = new Date();
    for (const session of wizSessionRows) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await canCandidateAccessSession(req.user._id, session))) continue;
      const config = configByExamId.get(String(session.examId._id));
      if (!config) continue;
      const capability = MODE_CAPABILITY[config.mode];
      if (capability) {
        if (!modeStates.has(capability)) {
          // eslint-disable-next-line no-await-in-loop
          modeStates.set(capability, await resolveTenantFeature(req.user.tenantId, capability));
        }
        if (!modeStates.get(capability)?.effectiveEnabled) continue;
      }
      available.push({
        session: {
          _id: session._id,
          startTime: session.startTime,
          endTime: session.endTime,
          isActive: session.isActive,
          questionPaperId: session.questionPaperId?._id || session.questionPaperId,
        },
        exam: session.examId,
        config,
        availability: now >= new Date(session.startTime) && now <= new Date(session.endTime) ? 'OPEN' : now < new Date(session.startTime) ? 'UPCOMING' : 'ENDED',
      });
    }
    return res.json({ available });
  } catch (error) {
    return next(error);
  }
});

export default router;
