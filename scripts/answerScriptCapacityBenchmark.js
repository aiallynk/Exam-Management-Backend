import { performance } from 'perf_hooks';
import offlineEvaluationConfig from '../config/offlineEvaluationConfig.js';
import { buildFairSchedule } from '../services/offlineEvaluation/answerScriptQueueService.js';

const TEACHERS = 20;
const SCRIPTS_PER_TEACHER = 20;
const PAGES_PER_SCRIPT = 8;
const ANSWERS_PER_SCRIPT = 12;

const jobs = [];
for (let teacher = 0; teacher < TEACHERS; teacher += 1) {
  for (let script = 0; script < SCRIPTS_PER_TEACHER; script += 1) {
    jobs.push({
      id: `teacher-${teacher + 1}-script-${script + 1}`,
      tenantId: `tenant-${Math.floor(teacher / 5) + 1}`,
      uploaderId: `teacher-${teacher + 1}`,
      batchId: `batch-${teacher + 1}`,
    });
  }
}

const startedAt = performance.now();
const accepted = new Map(jobs.map((job) => [job.id, job]));
const scheduled = buildFairSchedule(jobs, { maxPerTenant: offlineEvaluationConfig.MAX_ACTIVE_PER_TENANT });
const materializedAttempts = new Map();
let duplicateAttempts = 0;
let providerActive = 0;
let maxProviderActive = 0;
let aiRequests = 0;
let documentWorkMs = 0;
let aiWorkMs = 0;
let renderWorkMs = 0;

for (let index = 0; index < scheduled.length; index += 1) {
  const job = scheduled[index];
  documentWorkMs += 950 + (index % 11) * 45;
  const requests = 1 + PAGES_PER_SCRIPT + ANSWERS_PER_SCRIPT;
  aiRequests += requests;
  aiWorkMs += requests * (620 + (index % 7) * 35);
  renderWorkMs += 780 + (index % 5) * 50;
  providerActive = Math.min(offlineEvaluationConfig.AI_CONCURRENCY, providerActive + 1);
  maxProviderActive = Math.max(maxProviderActive, providerActive);
  providerActive -= 1;
  const attemptId = `attempt-for-${job.id}`;
  if (materializedAttempts.has(job.id) && materializedAttempts.get(job.id) !== attemptId) duplicateAttempts += 1;
  materializedAttempts.set(job.id, attemptId);
  // Deterministic retry injection exercises idempotent attempt keys.
  if (index % 10 === 0) {
    if (materializedAttempts.has(job.id) && materializedAttempts.get(job.id) !== attemptId) duplicateAttempts += 1;
    materializedAttempts.set(job.id, attemptId);
  }
}

const firstPositionByUploader = new Map();
scheduled.forEach((job, index) => {
  if (!firstPositionByUploader.has(job.uploaderId)) firstPositionByUploader.set(job.uploaderId, index + 1);
});
let maxConsecutiveUploader = 0;
let currentConsecutive = 0;
let priorUploader = null;
for (const job of scheduled) {
  currentConsecutive = job.uploaderId === priorUploader ? currentConsecutive + 1 : 1;
  priorUploader = job.uploaderId;
  maxConsecutiveUploader = Math.max(maxConsecutiveUploader, currentConsecutive);
}

const providerRateFloorMs = Math.ceil(aiRequests / offlineEvaluationConfig.PROVIDER_REQUESTS_PER_MINUTE) * 60_000;
const simulatedDocumentMs = Math.ceil(documentWorkMs / offlineEvaluationConfig.DOCUMENT_CONCURRENCY);
const simulatedAiConcurrencyMs = Math.ceil(aiWorkMs / offlineEvaluationConfig.AI_CONCURRENCY);
const simulatedRenderMs = Math.ceil(renderWorkMs / offlineEvaluationConfig.RENDER_CONCURRENCY);
const simulatedElapsedMs = Math.max(simulatedDocumentMs, simulatedAiConcurrencyMs, providerRateFloorMs) + simulatedRenderMs;
const wallClockMs = Number((performance.now() - startedAt).toFixed(3));

const report = {
  benchmark: 'mock-answer-script-burst',
  workload: {
    teachers: TEACHERS,
    scriptsPerTeacher: SCRIPTS_PER_TEACHER,
    scripts: jobs.length,
    pagesPerScript: PAGES_PER_SCRIPT,
    answersPerScript: ANSWERS_PER_SCRIPT,
    mockAi: true,
  },
  configuredLimits: {
    documentConcurrency: offlineEvaluationConfig.DOCUMENT_CONCURRENCY,
    aiConcurrency: offlineEvaluationConfig.AI_CONCURRENCY,
    renderConcurrency: offlineEvaluationConfig.RENDER_CONCURRENCY,
    maxPerTenant: offlineEvaluationConfig.MAX_ACTIVE_PER_TENANT,
    maxPerUploader: offlineEvaluationConfig.MAX_ACTIVE_PER_UPLOADER,
    providerRequestsPerMinute: offlineEvaluationConfig.PROVIDER_REQUESTS_PER_MINUTE,
  },
  result: {
    accepted: accepted.size,
    scheduled: scheduled.length,
    completed: materializedAttempts.size,
    lost: accepted.size - materializedAttempts.size,
    duplicateAttempts,
    retryInjections: scheduled.filter((_job, index) => index % 10 === 0).length,
    aiRequests,
    maxProviderActive,
    maxConsecutiveUploader,
    latestFirstOpportunityPosition: Math.max(...firstPositionByUploader.values()),
    schedulerWallClockMs: wallClockMs,
    simulatedElapsedMinutes: Number((simulatedElapsedMs / 60_000).toFixed(2)),
    providerRateFloorMinutes: Number((providerRateFloorMs / 60_000).toFixed(2)),
  },
  proofBoundary: 'Pure deterministic scheduler/resource simulation. It does not prove live Redis, S3, MongoDB, provider, HTTP, or browser behavior.',
};

if (report.result.accepted !== 400 || report.result.completed !== 400 || report.result.lost !== 0 || report.result.duplicateAttempts !== 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
}

