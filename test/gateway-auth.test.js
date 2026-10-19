'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');

// Isolated DB — must be set before requiring server modules.
const tmpDb = path.join(os.tmpdir(), `qoder-proxy-auth-${Date.now()}.db`);
process.env.QODER_PROXY_DB = tmpDb;
delete process.env.PROXY_API_KEY; // deterministic: no legacy key configured

const { db } = require('../server/db');
const dbModule = require('../server/db');
require('../server/migrations').runMigrations(db);

const usersStore = require('../server/stores/users');
const usageStore = require('../server/stores/usage');
const { gatewayGuard, quotaGuard, adminGuard, resolvePrincipal } = require('../server/auth');

// Minimal app wiring the real guards
function buildApp() {
  const app = express();
  app.get('/test', gatewayGuard, quotaGuard, (req, res) => res.json({ principal: req.principal }));
  app.get('/admin', adminGuard, (req, res) => res.json({ ok: true, principal: req.principal }));
  return app;
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('resolvePrincipal: api key resolves to its owner; revoked keys fail', async () => {
  const user = usersStore.createUser({ username: 'guser', password: 'secret123' });
  assert.ok(user.ok);
  const key = usersStore.createApiKey(user.user.id, 'k');
  const principal = resolvePrincipal(key.apiKey.key);
  assert.equal(principal.type, 'api_key');
  assert.equal(principal.userId, user.user.id);
  assert.equal(principal.role, 'user');
  assert.equal(principal.apiKeyConfig, null);

  usersStore.revokeApiKey(key.apiKey.id);
  assert.equal(resolvePrincipal(key.apiKey.key), null);
  assert.equal(resolvePrincipal('qk-not-a-real-key'), null);
});

test('resolvePrincipal: api key carries its runtime overrides', () => {
  const user = usersStore.createUser({ username: 'guser-rt', password: 'secret123' });
  assert.ok(user.ok);
  const key = usersStore.createApiKey(user.user.id, 'rt', null, {
    baseUrl: 'https://vpc.example.com',
    reasoningEffort: 'low',
    contextWindow: 123456,
    maxOutputTokens: 4096,
    timeoutMs: '45000',
  });
  const principal = resolvePrincipal(key.apiKey.key);
  assert.deepEqual(principal.apiKeyConfig, {
    baseUrl: 'https://vpc.example.com',
    reasoningEffort: 'low',
    contextWindow: 123456,
    maxOutputTokens: 4096,
    timeoutMs: 45000,
  });

  // Resetting to all-empty drops the config entirely.
  usersStore.updateApiKeyRuntime(key.apiKey.id, {});
  assert.equal(resolvePrincipal(key.apiKey.key).apiKeyConfig, null);

  // Revoke: later tests rely on the gateway being open (no usable keys).
  usersStore.revokeApiKey(key.apiKey.id);
});

test('gateway is open in single-user mode (no keys configured)', async () => {
  // All keys created by earlier tests are revoked, PROXY_API_KEY unset.
  const { server, base } = await listen(buildApp());
  try {
    const res = await fetch(`${base}/test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.principal.type, 'anonymous');
  } finally {
    server.close();
  }
});

test('gateway enforces auth once any api key exists', async () => {
  const user = usersStore.createUser({ username: 'enforce', password: 'secret123' });
  const key = usersStore.createApiKey(user.user.id, 'gate');

  const { server, base } = await listen(buildApp());
  try {
    const denied = await fetch(`${base}/test`);
    assert.equal(denied.status, 401);

    const bad = await fetch(`${base}/test`, { headers: { authorization: 'Bearer qk-bogus' } });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${base}/test`, { headers: { authorization: `Bearer ${key.apiKey.key}` } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.principal.type, 'api_key');
    assert.equal(body.principal.username, 'enforce');
  } finally {
    server.close();
  }
});

test('quotaGuard returns 429 when a daily token limit is reached', async () => {
  const user = usersStore.createUser({ username: 'limited', password: 'secret123' });
  const key = usersStore.createApiKey(user.user.id, 'quota');
  usersStore.setQuota(user.user.id, { dailyTokenLimit: 10 });

  usageStore.recordUsage({ userId: user.user.id, model: 'm', inputTokens: 8, outputTokens: 4 });

  const { server, base } = await listen(buildApp());
  try {
    const res = await fetch(`${base}/test`, { headers: { authorization: `Bearer ${key.apiKey.key}` } });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.match(JSON.stringify(body), /quota_exceeded|Quota exceeded/i);
  } finally {
    server.close();
  }
});

test('quotaGuard passes when under the limit', async () => {
  const user = usersStore.createUser({ username: 'roomy', password: 'secret123' });
  const key = usersStore.createApiKey(user.user.id, 'roomy');
  usersStore.setQuota(user.user.id, { dailyTokenLimit: 100000 });

  const { server, base } = await listen(buildApp());
  try {
    const res = await fetch(`${base}/test`, { headers: { authorization: `Bearer ${key.apiKey.key}` } });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('adminGuard rejects non-admin sessions and accepts admins', async () => {
  const admin = usersStore.createUser({ username: 'boss', password: 'secret123', role: 'admin' });
  const plain = usersStore.createUser({ username: 'peon', password: 'secret123', role: 'user' });

  const adminSession = dbModule.createSession('boss', 1);
  const userSession = dbModule.createSession('peon', 1);

  const { server, base } = await listen(buildApp());
  try {
    const denied = await fetch(`${base}/admin`, { headers: { authorization: `Bearer ${userSession}` } });
    assert.equal(denied.status, 401);

    const ok = await fetch(`${base}/admin`, { headers: { authorization: `Bearer ${adminSession}` } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.principal.username, 'boss');
    assert.equal(body.principal.role, 'admin');
  } finally {
    server.close();
  }
});

test('legacy sha256-salt passwords upgrade to bcrypt on successful login', () => {
  const created = usersStore.createUser({ username: 'upgrader', password: 'secret123', passwordAlgo: 'sha256-salt' });
  assert.ok(created.ok);
  let row = usersStore.getUserByUsername('upgrader');
  assert.equal(row.password_algo, 'sha256-salt');

  assert.equal(usersStore.verifyUserPassword(row, 'secret123'), true);
  assert.equal(usersStore.verifyUserPassword(row, 'wrong'), false);

  row = usersStore.getUserByUsername('upgrader');
  assert.equal(row.password_algo, 'bcrypt');
  assert.equal(row.salt, null);
});

test.after(() => {
  db.close();
  try {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  } catch (_) {
    // ignore
  }
});
