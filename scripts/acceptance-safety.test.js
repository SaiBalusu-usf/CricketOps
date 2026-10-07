import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAcceptanceDatabase, assertAcceptanceResetEnvironment } from './acceptance-safety.js';

const production = 'postgres://user:pass@postgres:5432/icat_cricket';
const isolated = 'postgres://user:pass@postgres:5432/icat_cricket_test';

test('acceptance refuses missing explicit test URL instead of falling back', () => {
  assert.throws(() => assertAcceptanceDatabase({ DATABASE_URL: production }), /ACCEPT_DATABASE_URL/);
});

test('acceptance refuses the production database even with a test URL variable', () => {
  assert.throws(() => assertAcceptanceDatabase({
    DATABASE_URL: production,
    ACCEPT_DATABASE_URL: production,
  }), /dedicated test|differ/);
  assert.throws(() => assertAcceptanceDatabase({
    DATABASE_URL: isolated,
    ACCEPT_DATABASE_URL: 'postgres://other:password@postgres:5432/icat_cricket_test',
  }), /differ/);
});

test('acceptance allows an explicitly isolated test database', () => {
  assert.equal(assertAcceptanceDatabase({
    DATABASE_URL: production,
    ACCEPT_DATABASE_URL: isolated,
  }), isolated);
});

test('startup reset refuses ordinary production and mismatched database environments', () => {
  assert.throws(() => assertAcceptanceResetEnvironment({
    DATABASE_URL: production,
    RESET_STORE_ON_START: '1',
  }), /acceptance reset guard/);
  assert.throws(() => assertAcceptanceResetEnvironment({
    DATABASE_URL: production,
    ACCEPT_DATABASE_URL: isolated,
    ACCEPT_PRODUCTION_DATABASE_URL: production,
    ACCEPTANCE_RESET_ALLOWED: '1',
  }), /must match/);
  assert.throws(() => assertAcceptanceResetEnvironment({
    DATABASE_URL: isolated,
    ACCEPT_DATABASE_URL: isolated,
    ACCEPT_PRODUCTION_DATABASE_URL: isolated,
    ACCEPTANCE_RESET_ALLOWED: '1',
  }), /differ/);
});

test('startup reset permits only the declared isolated test database', () => {
  assert.doesNotThrow(() => assertAcceptanceResetEnvironment({
    DATABASE_URL: isolated,
    ACCEPT_DATABASE_URL: isolated,
    ACCEPT_PRODUCTION_DATABASE_URL: production,
    ACCEPTANCE_RESET_ALLOWED: '1',
  }));
});
