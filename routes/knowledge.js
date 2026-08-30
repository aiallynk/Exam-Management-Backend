import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { getJobStatus, getQueueHealth } from '../services/jobs/jobDispatcherService.js';
import { getWorkerHeartbeat } from '../services/jobs/knowledgeWorkerService.js';
import { previewAutoContextResources, refreshLibraryResource } from '../services/knowledgeMemoryService.js';
import { markStaleSources } from '../services/contentLibraryService.js';
import { resolveAcademicVisibility } from '../services/academicAccessService.js';

const router = express.Router();
const canRead = [requireAuth, requireTenant, requireRole('TEACHER', 'ACADEMIC_ADMIN', 'EXAM_CREATOR', 'TENANT_ADMIN')];

router.get('/jobs/:jobId', ...canRead, async (req, res, next) => {
  try {
    const status = await getJobStatus(req.params.jobId);
    if (!status) return res.status(404).json({ error: 'Job not found.' });
    if (status.tenantId && String(status.tenantId) !== String(req.user.tenantId)) {
      return res.status(403).json({ error: 'Job not found.' });
    }
    return res.json({ job: status });
  } catch (error) {
    return next(error);
  }
});

router.get('/ops/health', requireAuth, requireRole('SUPER_ADMIN', 'TENANT_ADMIN'), async (_req, res, next) => {
  try {
    const [queue, worker] = await Promise.all([getQueueHealth(), getWorkerHeartbeat()]);
    return res.json({ queue, worker });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/auto-context/preview',
  ...canRead,
  body('topic').optional().isString(),
  body('subject').optional().isString(),
  body('academicContext').optional().isObject(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const visibility = await resolveAcademicVisibility(req.user);
      const preview = await previewAutoContextResources({
        tenantId: visibility.tenantId,
        user: { ...req.user, visibilityRecord: visibility },
        academicContext: req.body.academicContext || {},
        topic: req.body.topic,
        subject: req.body.subject,
        courseId: req.body.academicContext?.courseId,
      });
      return res.json({ preview, message: 'Relevant material will be selected automatically.' });
    } catch (error) {
      return next(error);
    }
  }
);

router.post('/sources/:sourceId/retry', ...canRead, async (req, res, next) => {
  try {
    const result = await refreshLibraryResource({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      resourceId: null,
      sourceId: req.params.sourceId,
    });
    return res.status(202).json({ retry: true, ...result });
  } catch (error) {
    return next(error);
  }
});

router.post('/ops/mark-stale', requireAuth, requireRole('SUPER_ADMIN', 'TENANT_ADMIN'), async (_req, res, next) => {
  try {
    const marked = await markStaleSources();
    return res.json({ marked });
  } catch (error) {
    return next(error);
  }
});

export default router;
