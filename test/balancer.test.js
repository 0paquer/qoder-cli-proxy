'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Isolated DB for this test file — must be set before requiring server modules.
const tmpDb = path.join(os.tmpdir(), `qoder-proxy-balancer-${Date.now()}.db`);
process.env.QODER_PROXY_DB = tmpDb;

const { db } = require('../server/db');
require('../server/migrations').runMigrations(db);

const accounts = require('../server/stores/accounts');
const balancer = require('../server/balancer');

// Seed accounts fresh for every test via unique names.
let seq = 0;
function seed({ weight = 1, maxConcurrency = 0, enabled = true } = {}) {
  seq += 1;
  const name = `bal-test-${seq}-${Math.random().toString(16).slice(2)}`;
  const created = accounts.createAccount({ name, pat: `pat-${name}`, backendType: 'cn' });
  assert.equal(created.ok, true, created.error);
  const id = created.account.id;
  accounts.updateAccount(id, { enabled });
  accounts.updateSchedule(id, { weight, maxConcurrency });
  return id;
}

test('pickAccount skips disabled and zero-weight accounts when others exist', () => {
  const enabled = seed({ weight: 1 });
  const disabled = seed({ weight: 5, enabled: false });
  const zeroWeight = seed({ weight: 0 });

  for (let i = 0; i < 20; i += 1) {
    const picked = balancer.pickAccount({ backendType: 'cn' });
    assert.ok(picked, 'should pick someone');
    assert.notEqual(picked.id, disabled);
    assert.notEqual(picked.id, zeroWeight);
  }
  // 排除唯一正权账号后，绝不能返回被排除的账号（剩零权兜底或 null 均合法）
  const excludedPick = balancer.pickAccount({ backendType: 'cn', excludeIds: [enabled] });
  assert.notEqual(excludedPick?.id, enabled, 'excluded account must never be picked');
});

test('pickAccount honors excludeIds (no retry on the same account)', () => {
  const a = seed({});
  const b = seed({});
  const picked = balancer.pickAccount({ backendType: 'cn', excludeIds: [a, b] });
  const available = accounts.getAvailableAccounts('cn').map((r) => r.id);
  if (!available.includes(a) && !available.includes(b)) {
    // both excluded → must be null
    assert.equal(picked, null);
  } else {
    assert.ok(![a, b].includes(picked === null ? -1 : picked.id) || picked === null);
  }
});

test('zero-weight account is picked when it is the only candidate', () => {
  const only = seed({ weight: 0 });
  // Exclude everything else that might exist in the DB from other tests
  const others = accounts
    .getAvailableAccounts('cn')
    .filter((r) => r.id !== only)
    .map((r) => r.id);
  const picked = balancer.pickAccount({ backendType: 'cn', excludeIds: others });
  assert.ok(picked);
  assert.equal(picked.id, only);
});

test('max_concurrency limits in-flight requests; release frees the slot', () => {
  const id = seed({ maxConcurrency: 1 });
  balancer.acquireAccount(id);
  assert.equal(balancer.getActiveCounts()[id], 1);

  // Now the account is full — picking must not return it.
  const picked = balancer.pickAccount({ backendType: 'cn' });
  if (picked) assert.notEqual(picked.id, id);

  balancer.releaseAccount(id);
  assert.equal(balancer.getActiveCounts()[id], undefined);
});

test('checkoutAccount reserves the slot and marks last_used_at', () => {
  const others = accounts.getAvailableAccounts('cn').map((r) => r.id);
  const id = seed({});
  const account = balancer.checkoutAccount({ backendType: 'cn', excludeIds: others });
  assert.ok(account);
  assert.equal(account.id, id);
  assert.equal(balancer.getActiveCounts()[id], 1);
  const after = accounts.getAccount(id);
  assert.ok(after.lastUsedAt, 'last_used_at should be set');
  balancer.releaseAccount(id);
});

test('failures trigger exponential-backoff cooldown; success resets', () => {
  const id = seed({});

  // First failure: counter only, no cooldown.
  let result = balancer.reportFailure(id);
  assert.equal(result.failures, 1);
  assert.equal(result.cooldownUntil, null);
  assert.ok(accounts.getAvailableAccounts('cn').some((r) => r.id === id));

  // Second consecutive failure: 30s cooldown.
  result = balancer.reportFailure(id);
  assert.equal(result.failures, 2);
  assert.ok(result.cooldownUntil);
  assert.ok(!accounts.getAvailableAccounts('cn').some((r) => r.id === id));

  // Cooldown escalates: 3rd failure → 60s.
  result = balancer.reportFailure(id);
  assert.equal(result.failures, 3);

  // Cooldown is persisted in the schedule row.
  const schedule = db
    .prepare('SELECT cooldown_until, consecutive_failures FROM qoder_account_schedule WHERE account_id = ?')
    .get(id);
  assert.equal(schedule.consecutive_failures, 3);
  assert.ok(schedule.cooldown_until);

  // Backoff math
  assert.equal(balancer.cooldownForFailures(1), 0);
  assert.equal(balancer.cooldownForFailures(2), 30 * 1000);
  assert.equal(balancer.cooldownForFailures(3), 60 * 1000);
  assert.equal(balancer.cooldownForFailures(4), 120 * 1000);
  assert.equal(balancer.cooldownForFailures(20), 10 * 60 * 1000);

  // Success resets failures and clears cooldown.
  balancer.reportSuccess(id);
  const after = accounts.getAccount(id);
  assert.equal(after.consecutiveFailures, 0);
  assert.ok(accounts.getAvailableAccounts('cn').some((r) => r.id === id));
});

test('cooldown checks use the persisted timestamp (restart-safe)', () => {
  const id = seed({});
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60 * 1000).toISOString();

  accounts.setAccountCooldown(id, past);
  assert.ok(accounts.getAvailableAccounts('cn').some((r) => r.id === id), 'past cooldown = available');

  accounts.setAccountCooldown(id, future);
  assert.ok(!accounts.getAvailableAccounts('cn').some((r) => r.id === id), 'future cooldown = unavailable');

  accounts.setAccountCooldown(id, null);
  assert.ok(accounts.getAvailableAccounts('cn').some((r) => r.id === id));
});

test('weighted distribution roughly follows weights', () => {
  const heavy = seed({ weight: 9 });
  const light = seed({ weight: 1 });
  const others = accounts
    .getAvailableAccounts('cn')
    .filter((r) => r.id !== heavy && r.id !== light)
    .map((r) => r.id);

  let heavyPicks = 0;
  const runs = 400;
  for (let i = 0; i < runs; i += 1) {
    const picked = balancer.pickAccount({ backendType: 'cn', excludeIds: others });
    if (picked.id === heavy) heavyPicks += 1;
  }
  // Heavy should get clearly more than half (expected ~90%); loose bounds for flake safety.
  assert.ok(heavyPicks > runs * 0.6, `heavy picked ${heavyPicks}/${runs}`);
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
