import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertDisposableTestDatabase, parseMongoTarget } from '../utils/testDatabaseSafety.js';

describe('Phase 5 disposable Mongo safety guard', () => {
  test('accepts a local replica-set URI with the dedicated database prefix', () => {
    const target = assertDisposableTestDatabase({
      nodeEnv: 'test',
      uri: 'mongodb://127.0.0.1:27018,localhost:27019/xamigo_phase5_e2e_run?replicaSet=testset',
    });
    assert.equal(target.databaseName, 'xamigo_phase5_e2e_run');
    assert.deepEqual(target.hosts, ['127.0.0.1', 'localhost']);
  });

  test('refuses destructive setup outside NODE_ENV=test', () => {
    assert.throws(
      () => assertDisposableTestDatabase({ nodeEnv: 'development', uri: 'mongodb://127.0.0.1/xamigo_phase5_e2e' }),
      /NODE_ENV=test/,
    );
  });

  test('refuses Atlas and other SRV targets', () => {
    assert.throws(
      () => assertDisposableTestDatabase({ nodeEnv: 'test', uri: 'mongodb+srv://example.mongodb.net/xamigo_phase5_e2e' }),
      /local mongodb:\/\//,
    );
  });

  test('refuses a local URI using the normal application database name', () => {
    assert.throws(
      () => assertDisposableTestDatabase({ nodeEnv: 'test', uri: 'mongodb://127.0.0.1:27017/exam_system' }),
      /must start/,
    );
  });

  test('refuses non-local standard MongoDB hosts', () => {
    assert.throws(
      () => assertDisposableTestDatabase({ nodeEnv: 'test', uri: 'mongodb://db.example.com/xamigo_phase5_e2e' }),
      /localhost/,
    );
  });

  test('parses an IPv6 localhost target', () => {
    assert.deepEqual(parseMongoTarget('mongodb://[::1]:27017/xamigo_phase5_e2e'), {
      uri: 'mongodb://[::1]:27017/xamigo_phase5_e2e',
      databaseName: 'xamigo_phase5_e2e',
      hosts: ['::1'],
    });
  });
});
