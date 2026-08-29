import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getQueueMode, QUEUE_MODE } from '../services/jobs/jobDispatcherService.js';
import { mapFrameworkMemoryPolicy, REPEAT_POLICIES } from '../services/questionMemoryService.js';
import { computeSourceAuthorityRank } from '../services/knowledgeMemoryService.js';
import { isAiIndexingEnabled } from '../services/knowledgeMemoryService.js';

test('queue mode is unavailable in production without redis', () => {
  const original = process.env.NODE_ENV;
  const redis = process.env.REDIS_URL;
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  assert.equal(getQueueMode(), QUEUE_MODE.UNAVAILABLE);
  process.env.NODE_ENV = original;
  if (redis) process.env.REDIS_URL = redis;
});

test('framework memory policy maps BLOCK action', () => {
  const policy = mapFrameworkMemoryPolicy({ action: 'BLOCK' });
  assert.equal(policy.exact, REPEAT_POLICIES.BLOCK);
  assert.equal(policy.semantic, REPEAT_POLICIES.BLOCK);
});

test('source authority ranks curriculum above teacher notes', () => {
  const curriculum = computeSourceAuthorityRank({ resourceType: 'CURRICULUM_DOCUMENT', approvalStatus: 'APPROVED', visibility: 'ACADEMIC_SHARED' });
  const notes = computeSourceAuthorityRank({ resourceType: 'TEACHER_NOTES', approvalStatus: 'READY', visibility: 'PRIVATE' });
  assert.ok(curriculum > notes);
});

test('isAiIndexingEnabled is exported for entitlement checks', () => {
  assert.equal(typeof isAiIndexingEnabled, 'function');
});
