import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTenantOwnedSourceFilter } from '../services/contextRetrievalService.js';

// Tenant isolation / IDOR guard — routes/ai.js's generate-questions
// handler builds its "does every requested contextSourceId actually
// belong to this tenant and READY" check via this exact function. These
// are pure query-object-construction tests (no DB): they prove the
// filter always scopes by the tenantId argument and never lets a
// caller-controlled value widen the match set.

describe('buildTenantOwnedSourceFilter', () => {
  test('always includes tenantId from the function argument', () => {
    const filter = buildTenantOwnedSourceFilter({ tenantId: 'tenant-a', sourceIds: ['src-1'] });
    assert.equal(filter.tenantId, 'tenant-a');
  });

  test('scopes the $in match set to exactly the provided sourceIds — a cross-tenant ID cannot smuggle its way in via a different argument shape', () => {
    const tenantASourceIds = ['src-1', 'src-2'];
    const filter = buildTenantOwnedSourceFilter({ tenantId: 'tenant-a', sourceIds: tenantASourceIds });
    assert.deepEqual(filter._id.$in, tenantASourceIds);
    // The filter object has no path by which a document belonging to
    // tenant-b could match: MongoDB will only return docs where BOTH
    // tenantId === 'tenant-a' AND _id is in this exact list.
    assert.equal(Object.keys(filter).sort().join(','), '_id,tenantId');
  });

  test('optionally scopes by status (used to require READY before generation)', () => {
    const filter = buildTenantOwnedSourceFilter({ tenantId: 'tenant-a', sourceIds: ['src-1'], status: 'READY' });
    assert.equal(filter.status, 'READY');
  });

  test('throws rather than silently building an unscoped filter when tenantId is missing', () => {
    assert.throws(() => buildTenantOwnedSourceFilter({ tenantId: null, sourceIds: ['src-1'] }));
    assert.throws(() => buildTenantOwnedSourceFilter({ tenantId: undefined, sourceIds: ['src-1'] }));
  });

  test('throws rather than silently building a filter with a non-array sourceIds', () => {
    assert.throws(() => buildTenantOwnedSourceFilter({ tenantId: 'tenant-a', sourceIds: 'src-1' }));
  });
});
