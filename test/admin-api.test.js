'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// Isolated DB — must be set before requiring server modules.
const tmpDb = path.join(os.tmpdir(), `qoder-proxy-admin-${Date.now()}.db`);
process.env.QODER_PROXY_DB = tmpDb;
delete process.env.PROXY_API_KEY; // deterministic: gateway starts open

require('../server/migrations').runMigrations(require('../server/db').db);

const qoderCli = require('../server/qoder-session');
const { createApp, resetLoginRateLimit } = require('../server/app');
const { AppError } = require('../server/errors');
const accountsStore = require('../server/stores/accounts');
const usersStore = require('../server/stores/users');
const usageStore = require('../server/stores/usage');

// Disable the background usage pre-refresh: its 3s startup sweep would race
// with mocked engines inside tests.
process.env.QODER_PROXY_NO_USAGE_REFRESH = '1';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function loginAs(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  assert.equal(body.ok, true, `login failed for ${username}`);
  return body.token;
}

async function setupAdmin(app, baseUrl) {
  usersStore.createUser({ username: 'root', password: 'root-pass-1', role: 'admin' });
  const token = await loginAs(baseUrl, 'root', 'root-pass-1');
  return { authorization: `Bearer ${token}` };
}

function authedFetch(baseUrl, headers, url, options = {}) {
  return fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...headers, ...(options.headers || {}) },
  });
}

test('admin account CRUD, PAT update and CLI verification', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const originalRun = qoderCli.runQoderCnCli;
  const originalLoad = qoderCli.loadModelCatalog;
  try {
    const headers = await setupAdmin(app, baseUrl);

    // Create
    const created = await authedFetch(baseUrl, headers, '/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: 'acc1',
        pat: 'pat-secret-aaaa',
        baseUrl: 'https://acc1.example.com',
        weight: 2,
        maxConcurrency: 1,
        remark: 'first',
      }),
    });
    assert.equal(created.status, 200);
    const { account } = await created.json();
    assert.equal(account.name, 'acc1');
    assert.equal(account.backendType, 'cn');
    assert.equal(account.baseUrl, 'https://acc1.example.com');
    assert.equal(account.weight, 2);
    assert.equal(account.maxConcurrency, 1);
    assert.equal(account.verifyStatus, 'unverified');
    assert.equal(account.patFingerprint ? String(account.patFingerprint).length > 0 : false, true);
    // The encrypted PAT never leaves the store
    assert.equal('patCiphertext' in account, false);

    // Duplicate name rejected
    const dup = await authedFetch(baseUrl, headers, '/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'acc1', pat: 'x' }),
    });
    assert.equal(dup.status, 400);

    // Update identity + schedule
    const patched = await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false, weight: 5, remark: 'paused' }),
    });
    assert.equal(patched.status, 200);
    const patchedBody = await patched.json();
    assert.equal(patchedBody.account.enabled, false);
    assert.equal(patchedBody.account.weight, 5);

    // PAT update resets verification
    const patRes = await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}/pat`, {
      method: 'POST',
      body: JSON.stringify({ pat: 'pat-secret-bbbb' }),
    });
    assert.equal(patRes.status, 200);
    const afterPat = await (await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}`)).json();
    assert.equal(afterPat.account.verifyStatus, 'unverified');
    assert.notEqual(afterPat.account.patFingerprint, account.patFingerprint);

    // Verify success path — the stored PAT must reach the SDK model catalog
    const seen = [];
    qoderCli.loadModelCatalog = async (opts) => {
      seen.push(opts);
      return { ok: true, models: [{ id: 'qwen3.8-max', name: 'Qwen3.8-Max' }, { id: 'glm-5.3', name: 'GLM-5.3' }] };
    };
    const verifyOk = await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}/verify`, {
      method: 'POST',
    });
    const verifyOkBody = await verifyOk.json();
    assert.equal(verifyOkBody.ok, true);
    assert.equal(verifyOkBody.verifyStatus, 'verified');
    assert.deepEqual(verifyOkBody.models, ['Qwen3.8-Max', 'GLM-5.3']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, 'pat-secret-bbbb');
    assert.equal(seen[0].baseUrl, 'https://acc1.example.com');

    // Verify failure path marks the account failed
    qoderCli.loadModelCatalog = async () => ({ ok: false, error: 'bad pat' });
    const verifyBad = await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}/verify`, {
      method: 'POST',
    });
    const verifyBadBody = await verifyBad.json();
    assert.equal(verifyBadBody.ok, false);
    assert.equal(verifyBadBody.verifyStatus, 'failed');
    const afterFail = await (await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}`)).json();
    assert.equal(afterFail.account.verifyStatus, 'failed');

    // Delete
    const del = await authedFetch(baseUrl, headers, `/admin/accounts/${account.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const list = await (await authedFetch(baseUrl, headers, '/admin/accounts')).json();
    assert.equal(list.accounts.length, 0);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    qoderCli.loadModelCatalog = originalLoad;
    server.close();
  }
});

test('admin user management: users, keys, grants, quota', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    const headers = await setupAdmin(app, baseUrl);

    const acc = accountsStore.createAccount({ name: 'shared', pat: 'pat-shared' });
    assert.ok(acc.ok);

    // Create user
    const created = await authedFetch(baseUrl, headers, '/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'alice-pass-1' }),
    });
    assert.equal(created.status, 200);
    const { user } = await created.json();
    assert.equal(user.username, 'alice');
    assert.equal(user.role, 'user');

    // Duplicate username rejected
    const dup = await authedFetch(baseUrl, headers, '/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'alice-pass-2' }),
    });
    assert.equal(dup.status, 400);

    // User list includes counts
    const list = await (await authedFetch(baseUrl, headers, '/admin/users')).json();
    const alice = list.users.find((u) => u.username === 'alice');
    assert.equal(alice.keyCount, 0);
    assert.equal(alice.grantCount, 0);

    // Grants replace
    const grants = await authedFetch(baseUrl, headers, `/admin/users/${user.id}/grants`, {
      method: 'PUT',
      body: JSON.stringify({ accountIds: [acc.account.id] }),
    });
    assert.equal(grants.status, 200);
    assert.deepEqual((await grants.json()).accountIds, [acc.account.id]);

    // Create API key — plaintext returned once
    const keyRes = await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`, {
      method: 'POST',
      body: JSON.stringify({ name: 'ci-key', expiresInDays: 30 }),
    });
    assert.equal(keyRes.status, 200);
    const { apiKey } = await keyRes.json();
    assert.match(apiKey.key, /^qk-/);
    assert.ok(apiKey.keyPrefix.startsWith('qk-'));

    // Key list hides the plaintext
    const keys = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`)).json();
    assert.equal(keys.keys.length, 1);
    assert.equal(keys.keys[0].name, 'ci-key');
    assert.equal('key' in keys.keys[0], false);
    assert.ok(keys.keys[0].expiresAt);

    // Reveal the full key: decrypted plaintext matches the creation response
    const reveal = await authedFetch(baseUrl, headers, `/admin/keys/${apiKey.id}/secret`);
    assert.equal(reveal.status, 200);
    assert.equal((await reveal.json()).key, apiKey.key);

    // Quota set + read
    const quotaRes = await authedFetch(baseUrl, headers, `/admin/users/${user.id}/quota`, {
      method: 'PUT',
      body: JSON.stringify({ dailyTokenLimit: 5000, monthlyRequestLimit: 100 }),
    });
    assert.equal(quotaRes.status, 200);
    assert.equal((await quotaRes.json()).quota.dailyTokenLimit, 5000);
    const quotaGet = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/quota`)).json();
    assert.equal(quotaGet.quota.dailyTokenLimit, 5000);
    assert.equal(quotaGet.quota.monthlyRequestLimit, 100);

    // Disable user
    const patch = await authedFetch(baseUrl, headers, `/admin/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal((await patch.json()).user.enabled, false);

    // Revoke key
    const revoke = await authedFetch(baseUrl, headers, `/admin/keys/${apiKey.id}`, { method: 'DELETE' });
    assert.equal(revoke.status, 200);
    const keysAfter = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`)).json();
    assert.ok(keysAfter.keys[0].revokedAt);

    // Delete user
    const del = await authedFetch(baseUrl, headers, `/admin/users/${user.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const listAfter = await (await authedFetch(baseUrl, headers, '/admin/users')).json();
    assert.equal(listAfter.users.some((u) => u.username === 'alice'), false);
  } finally {
    server.close();
  }
});

test('api key runtime config: create with overrides, patch and reset', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    const headers = await setupAdmin(app, baseUrl);
    const userRes = await authedFetch(baseUrl, headers, '/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'rt-user', password: 'rt-pass-123' }),
    });
    const { user } = await userRes.json();

    // Create key WITH runtime overrides
    const keyRes = await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'rt-key',
        runtime: {
          baseUrl: 'https://vpc.example.com',
          reasoningEffort: 'high',
          contextWindow: '200000',
          maxOutputTokens: 8192,
          timeoutMs: '90000',
        },
      }),
    });
    assert.equal(keyRes.status, 200);
    const { apiKey } = await keyRes.json();

    const keys = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`)).json();
    const withRt = keys.keys.find((k) => k.id === apiKey.id);
    assert.deepEqual(withRt.runtime, {
      baseUrl: 'https://vpc.example.com',
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 8192,
      timeoutMs: 90000,
    });

    // Key without runtime → runtime is null
    await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`, {
      method: 'POST',
      body: JSON.stringify({ name: 'plain-key' }),
    });
    const keys2 = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`)).json();
    assert.equal(keys2.keys.find((k) => k.name === 'plain-key').runtime, null);

    // PATCH replaces config; invalid effort is dropped
    const patch = await authedFetch(baseUrl, headers, `/admin/keys/${apiKey.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ runtime: { reasoningEffort: 'ultra', timeoutMs: '120000' } }),
    });
    assert.equal(patch.status, 200);
    const keys3 = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`)).json();
    const patched = keys3.keys.find((k) => k.id === apiKey.id);
    assert.equal(patched.runtime.reasoningEffort, null);
    assert.equal(patched.runtime.timeoutMs, 120000);
    assert.equal(patched.runtime.baseUrl, null);

    // All-empty PATCH resets to defaults
    const reset = await authedFetch(baseUrl, headers, `/admin/keys/${apiKey.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ runtime: { baseUrl: ' ', timeoutMs: '' } }),
    });
    assert.equal(reset.status, 200);
    const keys4 = await (await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`)).json();
    assert.equal(keys4.keys.find((k) => k.id === apiKey.id).runtime, null);

    // PATCH unknown key → 404
    const missing = await authedFetch(baseUrl, headers, '/admin/keys/999999', {
      method: 'PATCH',
      body: JSON.stringify({ runtime: { timeoutMs: 1000 } }),
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('playground: test-chat runs the CLI against a chosen account', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const originalRun = qoderCli.runQoderCnCli;
  try {
    const headers = await setupAdmin(app, baseUrl);
    const acc = accountsStore.createAccount({
      name: 'pg-acc',
      pat: 'pat-pg-1234',
      baseUrl: 'https://vpc.example.com',
    });
    const accId = acc.account.id;

    // Unknown account → 404.
    const missing = await authedFetch(baseUrl, headers, '/admin/test-chat', {
      method: 'POST',
      body: JSON.stringify({ accountId: 999999, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(missing.status, 404);

    // Empty messages → 400.
    const empty = await authedFetch(baseUrl, headers, '/admin/test-chat', {
      method: 'POST',
      body: JSON.stringify({ accountId: accId, messages: [] }),
    });
    assert.equal(empty.status, 400);

    // Model registry is exposed for the console dropdown.
    const models = await (await authedFetch(baseUrl, headers, '/admin/models')).json();
    assert.equal(models.ok, true);
    assert.ok(models.models.some((m) => m.id === 'qoder-cn'));

    // Happy path: the account PAT + baseUrl reach the CLI, usage flows back.
    const seen = [];
    qoderCli.runQoderCnCli = async (opts) => {
      seen.push(opts);
      if (typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 5, outputTokens: 3 });
      return 'pg reply';
    };
    const res = await authedFetch(baseUrl, headers, '/admin/test-chat', {
      method: 'POST',
      body: JSON.stringify({
        accountId: accId,
        model: 'glm-5.3',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hello' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.content, 'pg reply');
    assert.deepEqual(body.usage, { inputTokens: 5, outputTokens: 3 });
    assert.equal(typeof body.durationMs, 'number');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, 'pat-pg-1234');
    assert.equal(seen[0].baseUrl, 'https://vpc.example.com');
    assert.equal(seen[0].model, 'glm-5.3');
    assert.deepEqual(seen[0].messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);

    // CLI failure surfaces as ok:false with the error code, not an HTTP error.
    qoderCli.runQoderCnCli = async () => {
      throw new AppError(502, 'upstream_error', 'account down');
    };
    const bad = await authedFetch(baseUrl, headers, '/admin/test-chat', {
      method: 'POST',
      body: JSON.stringify({ accountId: accId, messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(bad.status, 200);
    const badBody = await bad.json();
    assert.equal(badBody.ok, false);
    assert.equal(badBody.code, 'upstream_error');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('gateway: granted account PAT reaches the CLI and usage is recorded', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const originalRun = qoderCli.runQoderCnCli;
  try {
    const headers = await setupAdmin(app, baseUrl);
    const acc = accountsStore.createAccount({ name: 'gw-acc', pat: 'pat-gw-1234' });
    const userRes = await authedFetch(baseUrl, headers, '/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'bob-pass-123' }),
    });
    const { user } = await userRes.json();
    await authedFetch(baseUrl, headers, `/admin/users/${user.id}/grants`, {
      method: 'PUT',
      body: JSON.stringify({ accountIds: [acc.account.id] }),
    });
    const { apiKey } = await (
      await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'k' }),
      })
    ).json();

    const seen = [];
    qoderCli.runQoderCnCli = async (opts) => {
      seen.push(opts);
      if (typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 11, outputTokens: 7 });
      return 'hello from qoder';
    };

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
      body: JSON.stringify({ model: 'qoder-cn', messages: [{ role: 'user', content: 'hi there' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'hello from qoder');

    // The account's decrypted PAT — not the env token — reached the CLI.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, 'pat-gw-1234');

    // One usage_record with real token counts.
    const records = usageStore.getRecentRecords(10, user.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].user_id, user.id);
    assert.equal(records[0].account_id, acc.account.id);
    assert.equal(records[0].token_source, 'actual');
    assert.equal(records[0].input_tokens, 11);
    assert.equal(records[0].output_tokens, 7);
    assert.equal(records[0].status, 'success');

    // usage overview exposes it to the console
    const overview = await (await authedFetch(baseUrl, headers, '/admin/usage/overview')).json();
    assert.equal(overview.ok, true);
    assert.equal(overview.today.requests, 1);
    assert.equal(overview.byUser[0].username, 'bob');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('gateway: failed account rotates to another and failures are tracked', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const originalRun = qoderCli.runQoderCnCli;
  try {
    const headers = await setupAdmin(app, baseUrl);
    const accA = accountsStore.createAccount({ name: 'rot-a', pat: 'pat-rot-a' });
    const accB = accountsStore.createAccount({ name: 'rot-b', pat: 'pat-rot-b' });
    const userRes = await authedFetch(baseUrl, headers, '/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'carol', password: 'carol-pass' }),
    });
    const { user } = await userRes.json();
    await authedFetch(baseUrl, headers, `/admin/users/${user.id}/grants`, {
      method: 'PUT',
      body: JSON.stringify({ accountIds: [accA.account.id, accB.account.id] }),
    });
    const { apiKey } = await (
      await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'k' }),
      })
    ).json();

    let calls = 0;
    const triedTokens = [];
    qoderCli.runQoderCnCli = async (opts) => {
      calls += 1;
      triedTokens.push(opts.token);
      if (calls === 1) throw new AppError(502, 'upstream_error', 'first account is down');
      return 'recovered';
    };

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(triedTokens.sort(), ['pat-rot-a', 'pat-rot-b']);

    // The failed account's failure streak incremented; the other succeeded.
    const afterA = accountsStore.getAccount(accA.account.id);
    const afterB = accountsStore.getAccount(accB.account.id);
    const failedOne = afterA.consecutiveFailures === 1 ? afterA : afterB;
    const successOne = failedOne === afterA ? afterB : afterA;
    assert.equal(failedOne.consecutiveFailures, 1);
    assert.equal(successOne.consecutiveFailures, 0);

    // One success record for the request, attributed to the second account.
    const records = usageStore.getRecentRecords(5, user.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'success');
    assert.equal(records[0].account_id, successOne.id);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('gateway: a user without grants never falls back to the env token', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const originalRun = qoderCli.runQoderCnCli;
  try {
    const headers = await setupAdmin(app, baseUrl);
    accountsStore.createAccount({ name: 'admin-only', pat: 'pat-admin-only' });
    const userRes = await authedFetch(baseUrl, headers, '/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'dave', password: 'dave-pass-1' }),
    });
    const { user } = await userRes.json();
    const { apiKey } = await (
      await authedFetch(baseUrl, headers, `/admin/users/${user.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'k' }),
      })
    ).json();

    let cliCalled = false;
    qoderCli.runQoderCnCli = async () => {
      cliCalled = true;
      return 'should never run';
    };

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'no_account_granted');
    assert.equal(cliCalled, false);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('/admin/me works for any logged-in user and rejects strangers', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    usersStore.createUser({ username: 'eve', password: 'eve-pass-123', role: 'user' });
    const token = await loginAs(baseUrl, 'eve', 'eve-pass-123');

    const me = await fetch(`${baseUrl}/admin/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.ok, true);
    assert.equal(body.username, 'eve');
    assert.equal(body.role, 'user');

    const anon = await fetch(`${baseUrl}/admin/me`);
    assert.equal(anon.status, 401);

    const bogus = await fetch(`${baseUrl}/admin/me`, {
      headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(bogus.status, 401);
  } finally {
    server.close();
  }
});

test('forced first-login password change: default admin is locked out until changed', async () => {
  const db = require('../server/db');
  // 模拟 initialize() 的种子行为（本文件不调用 initialize）
  const seeded = db.createAdminUser('admin', 'admin123', 'admin');
  assert.equal(seeded.ok, true, 'fresh test DB should not have a default admin yet');

  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    // 登录响应携带 mustChangePassword 标记
    const loginRes = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const loginBody = await loginRes.json();
    assert.equal(loginBody.ok, true);
    assert.equal(loginBody.mustChangePassword, true);
    const headers = { authorization: `Bearer ${loginBody.token}` };

    // 默认密码未改：白名单外的管理接口一律 403 default_password
    const users = await authedFetch(baseUrl, headers, '/admin/users');
    assert.equal(users.status, 403);
    assert.equal((await users.json()).error.code, 'default_password');

    // 白名单端点保持可用：/me 独立于 adminGuard
    const me = await fetch(`${baseUrl}/admin/me`, {
      headers: { authorization: headers.authorization },
    });
    assert.equal(me.status, 200);

    // 不允许改回默认密码
    const revert = await authedFetch(baseUrl, headers, '/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', newPassword: 'admin123' }),
    });
    assert.equal(revert.status, 400);

    // 正常改密成功
    const change = await authedFetch(baseUrl, headers, '/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', newPassword: 'new-admin-pass-9' }),
    });
    assert.equal(change.status, 200);

    // 改密后：mustChangePassword 变为 false，管理接口放行
    const relRes = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'new-admin-pass-9' }),
    });
    const relBody = await relRes.json();
    assert.equal(relBody.ok, true);
    assert.equal(relBody.mustChangePassword, false);
    const usersAfter = await authedFetch(
      baseUrl,
      { authorization: `Bearer ${relBody.token}` },
      '/admin/users'
    );
    assert.equal(usersAfter.status, 200);
  } finally {
    server.close();
  }
});

test('balancer: persistent failures are classified and cool down for an hour', async () => {
  const balancer = require('../server/balancer');
  const { db } = require('../server/db');

  assert.equal(balancer.isPersistentFailure({ message: 'Credit usage limit reached' }), true);
  assert.equal(balancer.isPersistentFailure('额度已用尽，请升级套餐'), true);
  assert.equal(balancer.isPersistentFailure({ code: 'insufficient_quota', message: '' }), true);
  assert.equal(balancer.isPersistentFailure({ message: 'connection refused' }), false);
  assert.equal(balancer.isPersistentFailure(null), false);
  assert.equal(balancer.isPersistentFailure(''), false);

  // First persistent failure → cooldown ≈ 1h (not the 2-failure backoff ladder).
  const created = accountsStore.createAccount({
    name: `cooldown-${Date.now()}`,
    pat: 'pat-cooldown',
    backendType: 'cn',
  });
  assert.equal(created.ok, true, `createAccount failed: ${created.error}`);
  const acc = created.account;
  try {
    const outcome = balancer.reportFailure(acc.id, { message: 'Credit usage limit reached' });
    assert.equal(outcome.persistent, true);
    assert.ok(outcome.cooldownUntil, 'first persistent failure must set a cooldown');
    const remainingMs = new Date(outcome.cooldownUntil).getTime() - Date.now();
    assert.ok(
      remainingMs > 55 * 60 * 1000,
      `persistent cooldown should be ~1h, got ${remainingMs}ms`
    );
    const row = db
      .prepare('SELECT cooldown_until, consecutive_failures FROM qoder_account_schedule WHERE account_id = ?')
      .get(acc.id);
    assert.equal(row.consecutive_failures, 1);
    assert.ok(row.cooldown_until);

    // Non-persistent failure keeps the backoff ladder (1 failure = no cooldown).
    const created2 = accountsStore.createAccount({
      name: `ladder-${Date.now()}`,
      pat: 'pat-ladder',
      backendType: 'cn',
    });
    const acc2 = created2.account;
    const outcome2 = balancer.reportFailure(acc2.id, { message: 'connection reset' });
    assert.equal(outcome2.persistent, false);
    assert.equal(outcome2.cooldownUntil, null);
  } finally {
    accountsStore.deleteAccount(acc.id);
  }
});

test('runtime-status, update-env deletes and removed get-proxy-key', async () => {
  // 保持 NO_RESTART 常驻到进程结束：update-env 的重启是「500ms 后 exit(0)」，
  // 若 finally 恢复标志，定时器会把排在后面的顶层用例整批带走（node:test
  // 的队列调度不保活事件循环，曾致用例随机丢失）。
  process.env.QODER_PROXY_NO_RESTART = '1';
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    const headers = await setupAdmin(app, baseUrl);

    // The unauthenticated proxy-key endpoint is gone for good.
    const gone = await authedFetch(baseUrl, headers, '/admin/get-proxy-key');
    assert.equal(gone.status, 404);

    const status = await authedFetch(baseUrl, headers, '/admin/runtime-status');
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.ok, true);
    const runtime = statusBody.status;
    assert.ok(runtime.version, 'runtime-status should report the app version');
    assert.ok(runtime.nodeVersion, 'runtime-status should report the Node version');
    assert.ok(Number.isFinite(runtime.uptimeSeconds));
    assert.ok('cliBackend' in runtime);

    // update-env: add a variable, then delete it again.
    const add = await authedFetch(baseUrl, headers, '/admin/update-env', {
      method: 'POST',
      body: JSON.stringify({ updates: { TEST_DELETE_VAR: '1' } }),
    });
    assert.equal(add.status, 200);
    const afterAdd = await (await authedFetch(baseUrl, headers, '/admin/env-config')).json();
    assert.equal(afterAdd.config.TEST_DELETE_VAR, '1');

    const del = await authedFetch(baseUrl, headers, '/admin/update-env', {
      method: 'POST',
      body: JSON.stringify({ deletes: ['TEST_DELETE_VAR'] }),
    });
    assert.equal(del.status, 200);
    const afterDel = await (await authedFetch(baseUrl, headers, '/admin/env-config')).json();
    assert.ok(!('TEST_DELETE_VAR' in afterDel.config), 'deleted variable should be gone');

    // PROXY_API_KEY is retired: no longer protected, deletable like any other key.
    const delLegacy = await authedFetch(baseUrl, headers, '/admin/update-env', {
      method: 'POST',
      body: JSON.stringify({ deletes: ['PROXY_API_KEY'] }),
    });
    assert.equal(delLegacy.status, 200);

    // Malformed payload is rejected.
    const malformed = await authedFetch(baseUrl, headers, '/admin/update-env', {
      method: 'POST',
      body: JSON.stringify({ deletes: 'not-an-array' }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    server.close();
  }
});

// Account usage query: cached, per-account scope.
// Stays before the rate-limit test (which must remain last).
test('system logs: buffer query, filters, incremental fetch and clear', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    const headers = await setupAdmin(app, baseUrl);

    // Unauthenticated access is rejected like every other admin endpoint.
    const anon = await fetch(`${baseUrl}/admin/logs`);
    assert.equal(anon.status, 401);

    const { log: logLine } = require('../server/logger');
    const marker = `hello-logs-${Date.now()}`;
    logLine('marker info line', { marker });
    console.warn(`marker warn line ${marker}`);
    console.error(`marker error line ${marker}`);

    const res = await authedFetch(baseUrl, headers, '/admin/logs?limit=100');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.total >= 3, 'buffer should hold at least the seeded lines');
    const texts = body.entries.map((e) => e.text).join('\n');
    assert.ok(texts.includes(marker), 'seeded info line must be captured');
    assert.ok(body.entries.every((e) => e.seq > 0 && e.ts && e.text), 'entries carry seq/ts/text');

    // Ordered oldest → newest.
    const seqs = body.entries.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'entries must be time-ordered');

    // Level filter.
    const errRes = await authedFetch(baseUrl, headers, '/admin/logs?level=error&limit=100');
    const errBody = await errRes.json();
    assert.ok(errBody.entries.some((e) => e.text.includes(marker)), 'error filter finds seeded line');
    assert.ok(errBody.entries.every((e) => e.level === 'error'), 'level=error only returns errors');

    // Search filter.
    const searchRes = await authedFetch(
      baseUrl,
      headers,
      `/admin/logs?search=${encodeURIComponent(marker)}&limit=100`,
    );
    const searchBody = await searchRes.json();
    assert.equal(searchBody.entries.length, 3, 'search matches all three seeded lines');

    // Incremental fetch: nothing new since latestSeq.
    const incRes = await authedFetch(
      baseUrl,
      headers,
      `/admin/logs?since=${searchBody.latestSeq}&search=${encodeURIComponent(marker)}`,
    );
    const incBody = await incRes.json();
    assert.equal(incBody.entries.length, 0, 'since excludes already-seen entries');

    // Clear empties the buffer view.
    const delRes = await authedFetch(baseUrl, headers, '/admin/logs', { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const afterRes = await authedFetch(
      baseUrl,
      headers,
      `/admin/logs?search=${encodeURIComponent(marker)}`,
    );
    const afterBody = await afterRes.json();
    assert.equal(afterBody.entries.length, 0, 'cleared buffer no longer returns seeded lines');
  } finally {
    server.close();
  }
});


test('admin restart: port optional (empty body restarts with current config)', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const prevNoRestart = process.env.QODER_PROXY_NO_RESTART;
  process.env.QODER_PROXY_NO_RESTART = '1';
  try {
    const headers = await setupAdmin(app, baseUrl);

    // 设置页「重启服务」按钮发空 body：不应再报 port must be 1-65535
    const okRes = await authedFetch(baseUrl, headers, '/admin/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);

    // 显式传入非法值仍要拒绝
    for (const bad of ['abc', 70000, 0]) {
      const badRes = await authedFetch(baseUrl, headers, '/admin/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: bad }),
      });
      assert.equal(badRes.status, 400, `port=${bad} must be rejected`);
    }
  } finally {
    if (prevNoRestart === undefined) delete process.env.QODER_PROXY_NO_RESTART;
    else process.env.QODER_PROXY_NO_RESTART = prevNoRestart;
    server.close();
  }
});

test('account usage query: cached and account-scoped', async () => {
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  const sdkEngine = require('../server/qoder-session');
  const originalLoadUsage = sdkEngine.loadAccountUsage;
  let accA = null;
  let accB = null;
  let calls = 0;
  try {
    const headers = await setupAdmin(app, baseUrl);
    accA = accountsStore.createAccount({ name: 'usage-a', pat: 'pat-usage-a' });
    accB = accountsStore.createAccount({ name: 'usage-b', pat: 'pat-usage-b' });
    assert.equal(accA.ok, true);
    assert.equal(accB.ok, true);
    const aId = accA.account.id;
    const bId = accB.account.id;

    // Unknown account → 404.
    const missing = await authedFetch(baseUrl, headers, '/admin/accounts/999999/usage', {
      method: 'POST',
    });
    assert.equal(missing.status, 404);

    // Engine results flow through, second call is cached.
    sdkEngine.loadAccountUsage = async () => {
      calls += 1;
      return {
        ok: true,
        usage: {
          buckets: [
            { label: '组织资源包', total: 5000, used: 4707, remaining: 293, percentage: 95 },
          ],
          totalUsagePercentage: 0,
          isQuotaExceeded: false,
          expiresAt: 1794153600000,
        },
      };
    };
    const first = await (
      await authedFetch(baseUrl, headers, `/admin/accounts/${aId}/usage`, { method: 'POST' })
    ).json();
    assert.equal(first.ok, true);
    assert.equal(first.usage.buckets[0].used, 4707);
    assert.equal(first.usage.buckets[0].total, 5000);
    const second = await (
      await authedFetch(baseUrl, headers, `/admin/accounts/${aId}/usage`, { method: 'POST' })
    ).json();
    assert.equal(second.cached, true);
    assert.equal(calls, 1, 'engine must not be called again while the cache is fresh');

    // Cache is per-account: b's first query runs the engine again.
    const other = await (
      await authedFetch(baseUrl, headers, `/admin/accounts/${bId}/usage`, { method: 'POST' })
    ).json();
    assert.equal(other.ok, true);
    assert.equal(calls, 2, 'a separate account must not reuse another account cache');
  } finally {
    sdkEngine.loadAccountUsage = originalLoadUsage;
    if (accA?.account) accountsStore.deleteAccount(accA.account.id);
    if (accB?.account) accountsStore.deleteAccount(accB.account.id);
    server.close();
  }
});

// 前后都重置限速状态：本用例自身不依赖执行顺序，也不会把锁留给后续用例。
test('login rate limiting locks the IP after repeated failures', async () => {
  resetLoginRateLimit();
  const app = createApp();
  const { server, baseUrl } = await listen(app);
  try {
    const attempt = () =>
      fetch(`${baseUrl}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ratelimit-user', password: 'wrong-password' }),
      });

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      assert.equal(res.status, 200, 'failures still answer with a normal response body');
      const body = await res.json();
      assert.equal(body.ok, false);
    }

    const locked = await attempt();
    assert.equal(locked.status, 429);
    const lockedBody = await locked.json();
    assert.match(lockedBody.error, /Too many attempts/i);
  } finally {
    server.close();
    resetLoginRateLimit();
  }
});
