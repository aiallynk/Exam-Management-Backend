import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import {
  API_RATE_LIMITS,
  resolveApiRateLimitKey,
  resolveApiRateLimitMax,
  shouldSkipApiRateLimitPath,
} from '../middleware/rateLimiter.js';

const request = ({ method = 'GET', path = '/tenant/features', authorization = '', ip = '198.51.100.24' } = {}) => ({
  method,
  path,
  ip,
  headers: authorization ? { authorization } : {},
});

describe('general API rate limiting', () => {
  test('groups valid authenticated workspace reads by signed user and tenant, not shared IP', () => {
    const firstToken = jwt.sign({ sub: 'user-a', tenantId: 'tenant-a' }, config.jwtSecret);
    const secondToken = jwt.sign({ sub: 'user-b', tenantId: 'tenant-a' }, config.jwtSecret);
    const first = request({ authorization: `Bearer ${firstToken}`, ip: '203.0.113.10' });
    const second = request({ authorization: `Bearer ${secondToken}`, ip: '203.0.113.10' });

    assert.equal(resolveApiRateLimitKey(first), 'user:user-a:tenant:tenant-a');
    assert.equal(resolveApiRateLimitKey(second), 'user:user-b:tenant:tenant-a');
    assert.equal(resolveApiRateLimitMax(first), API_RATE_LIMITS.AUTHENTICATED_READ);
  });

  test('keeps anonymous and invalid-token traffic in IP budgets', () => {
    const anonymous = request({ ip: '203.0.113.11' });
    const invalid = request({ authorization: 'Bearer invalid-token', ip: '203.0.113.11' });

    assert.equal(resolveApiRateLimitKey(anonymous), 'ip:203.0.113.11');
    assert.equal(resolveApiRateLimitKey(invalid), 'ip:203.0.113.11');
    assert.equal(resolveApiRateLimitMax(anonymous), API_RATE_LIMITS.ANONYMOUS_READ);
    assert.equal(resolveApiRateLimitMax(request({ method: 'POST' })), API_RATE_LIMITS.ANONYMOUS_MUTATION);
  });

  test('leaves auth, upload, preflight, and exam workflow routes to their own protections', () => {
    assert.equal(shouldSkipApiRateLimitPath(request({ path: '/auth/login', method: 'POST' })), true);
    assert.equal(shouldSkipApiRateLimitPath(request({ path: '/upload', method: 'POST' })), true);
    assert.equal(shouldSkipApiRateLimitPath(request({ path: '/tenant/features', method: 'OPTIONS' })), true);
    assert.equal(shouldSkipApiRateLimitPath(request({ path: '/exam-attempts/current' })), true);
    assert.equal(shouldSkipApiRateLimitPath(request({ path: '/tenant/features' })), false);
  });
});
