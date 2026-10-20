'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createWarmPool, keyFor, isEnabled, stableEnvPart } = require('../server/warm-pool');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    if (child.exitCode !== null) return true;
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  return child;
}

const SPEC = (overrides = {}) => ({
  command: 'node.exe',
  args: ['bundle.js', '--print'],
  env: { QODERCN_BASE_URL: 'https://api.example.com' },
  token: 'pat-test-token',
  ...overrides,
});

test('warm pool: keyFor is stable and isolates by token/args/env', () => {
  const a = keyFor(SPEC());
  const b = keyFor(SPEC());
  assert.equal(a, b, 'same spec must produce the same key');

  assert.notEqual(keyFor(SPEC({ token: 'pat-A' })), keyFor(SPEC({ token: 'pat-B' })));
  assert.notEqual(keyFor(SPEC({ args: ['bundle.js', '--model', 'x'] })), keyFor(SPEC()));
  assert.notEqual(
    keyFor(SPEC({ env: { QODERCN_BASE_URL: 'https://other.example.com' } })),
    keyFor(SPEC())
  );
  // 每请求变化的 auth payload 路径不影响指纹。
  assert.equal(
    keyFor(SPEC({ env: { QODERCN_BASE_URL: 'https://api.example.com', QODER_SDK_AUTH_PAYLOAD_FILE: 'C:/tmp/a.json' } })),
    keyFor(SPEC())
  );
  assert.equal(stableEnvPart({ QODER_SDK_AUTH_PAYLOAD_FILE: 'x' }), '[]');
});

test('warm pool: offer then acquire hands out the process once', () => {
  const pool = createWarmPool({ spawnFn: () => makeFakeChild(), size: 1, maxTotal: 3, ttl: 60_000, readyMs: 0 });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  assert.equal(pool.stats().idle, 1);

  const child = pool.acquire(key);
  assert.ok(child, 'acquire must return the prewarmed child');
  assert.equal(pool.stats().idle, 0);
  assert.equal(pool.acquire(key), null, 'second acquire on an empty pool returns null');
  pool.shutdown();
});

test('warm pool: dead processes are discarded on acquire', () => {
  const pool = createWarmPool({ spawnFn: () => makeFakeChild(), size: 1, maxTotal: 3, ttl: 60_000, readyMs: 0 });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  const child = pool.acquire(key);
  child.kill();
  assert.equal(pool.acquire(key), null);
  pool.shutdown();
});

test('warm pool: process that exits before use is reclaimed', () => {
  let child;
  const pool = createWarmPool({
    spawnFn: () => {
      child = makeFakeChild();
      return child;
    },
    size: 1,
    maxTotal: 3,
    ttl: 60_000,
    readyMs: 0,
  });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  assert.equal(pool.stats().idle, 1);
  child.emit('exit', 41, null);
  assert.equal(pool.stats().idle, 0, 'early exit must be reclaimed');
  assert.equal(pool.acquire(key), null);
  pool.shutdown();
});

test('warm pool: ttl reclaims idle processes', async () => {
  const pool = createWarmPool({ spawnFn: () => makeFakeChild(), size: 1, maxTotal: 3, ttl: 100, readyMs: 0 });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  assert.equal(pool.stats().idle, 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pool.stats().idle, 0, 'ttl must reclaim the idle process');
  pool.shutdown();
});

test('warm pool: immature processes are withheld until readyMs elapses', async () => {
  const pool = createWarmPool({ spawnFn: () => makeFakeChild(), size: 1, maxTotal: 3, ttl: 60_000, readyMs: 150 });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  assert.equal(pool.acquire(key), null, 'immature process must not be handed out');
  assert.equal(pool.stats().idle, 1, 'immature process stays in the pool to mature');
  await new Promise((r) => setTimeout(r, 220));
  const child = pool.acquire(key);
  assert.ok(child, 'mature process is handed out');
  pool.shutdown();
});

test('warm pool: size and maxTotal caps are enforced', () => {
  const spawned = [];
  const pool = createWarmPool({
    spawnFn: () => {
      const c = makeFakeChild();
      spawned.push(c);
      return c;
    },
    size: 1,
    maxTotal: 1,
    ttl: 60_000,
    readyMs: 0,
  });
  const keyA = keyFor(SPEC({ token: 'pat-A' }));
  const keyB = keyFor(SPEC({ token: 'pat-B' }));
  pool.offer(keyA, SPEC({ token: 'pat-A' }));
  pool.offer(keyA, SPEC({ token: 'pat-A' })); // size=1：同 key 第二次被拒
  assert.equal(spawned.length, 1);
  pool.offer(keyB, SPEC({ token: 'pat-B' })); // maxTotal=1：跨 key 也被拒
  assert.equal(spawned.length, 1);
  assert.equal(pool.stats().idle, 1);
  pool.shutdown();
});

test('warm pool: shutdown kills idle processes and stops offering', () => {
  const pool = createWarmPool({ spawnFn: () => makeFakeChild(), size: 2, maxTotal: 3, ttl: 60_000, readyMs: 0 });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  const child = pool.acquire(key); // taken：生命周期归 SDK abort 管，池不再负责
  assert.ok(child);
  pool.shutdown();
  assert.equal(pool.stats().idle, 0, 'shutdown must clear the pool');
  pool.offer(key, SPEC());
  assert.equal(pool.stats().idle, 0, 'no offers after shutdown');
});

test('warm pool: enabled by default, disabled via QODER_WARM_POOL', () => {
  assert.equal(isEnabled(), true);
  process.env.QODER_WARM_POOL = '0';
  try {
    assert.equal(isEnabled(), false);
  } finally {
    delete process.env.QODER_WARM_POOL;
  }
});

test('warm pool: keepalive respawns lost idle processes within window', async () => {
  let spawned = 0;
  let child;
  const pool = createWarmPool({
    spawnFn: () => {
      spawned += 1;
      child = makeFakeChild();
      return child;
    },
    size: 1,
    maxTotal: 3,
    ttl: 60_000,
    readyMs: 0,
    keepaliveMs: 40,
    keepaliveWindowMs: 60_000,
  });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  assert.equal(spawned, 1);
  child.emit('exit', 1, null); // 池内热进程意外死亡
  // 即时补位（removeEntry 钩子）当场接力，空窗只存在于同步调用栈内。
  assert.equal(pool.stats().idle, 1, 'instant refill already refilled synchronously');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(spawned >= 2, 'keepalive must respawn the lost process');
  assert.equal(pool.stats().idle, 1, 'respawned process sits idle for next request');
  pool.shutdown();
  assert.equal(pool.stats().idle, 0);
});

test('warm pool: keepalive stops after window expires', async () => {
  let spawned = 0;
  let child;
  const pool = createWarmPool({
    spawnFn: () => {
      spawned += 1;
      child = makeFakeChild();
      return child;
    },
    size: 1,
    maxTotal: 3,
    ttl: 60_000,
    readyMs: 0,
    keepaliveMs: 50,
    keepaliveWindowMs: 20, // 窗口短于首个巡检点：首轮即过期
  });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  const afterOffer = spawned;
  await new Promise((r) => setTimeout(r, 60)); // 超过窗口(20ms)，巡检(50ms)先清档
  child.emit('exit', 1, null); // 池内变空，超窗指纹不得被即时补位复活
  assert.equal(pool.stats().idle, 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spawned, afterOffer, 'expired fingerprint must not be respawned');
  pool.shutdown();
});

test('warm pool: ttl reclaim refills instantly without waiting for keepalive tick', async () => {
  let spawned = 0;
  let first;
  const pool = createWarmPool({
    spawnFn: () => {
      spawned += 1;
      first = makeFakeChild();
      return first;
    },
    size: 1,
    maxTotal: 3,
    ttl: 60_000,
    readyMs: 0,
    keepaliveMs: 60_000, // 巡检根本来不及跑：补位只能来自移除钩子
    keepaliveWindowMs: 60_000,
  });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  assert.equal(spawned, 1);
  first.kill(); // 池内归零（TTL 回收与进程早亡同走 removeEntry 钩子）
  assert.equal(spawned, 2, 'refill must happen immediately from stored spec');
  assert.equal(pool.stats().idle, 1, 'refilled process sits idle for next request');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawned, 2, 'keepalive tick (60s) has not run yet');
  pool.shutdown();
});

test('warm pool: instant refill cools down when respawned process dies at once', async () => {
  let spawned = 0;
  const children = [];
  const pool = createWarmPool({
    spawnFn: () => {
      spawned += 1;
      const c = makeFakeChild();
      children.push(c);
      return c;
    },
    size: 1,
    maxTotal: 3,
    ttl: 100,
    readyMs: 0,
    keepaliveMs: 60_000,
    keepaliveWindowMs: 60_000,
  });
  const key = keyFor(SPEC());
  pool.offer(key, SPEC());
  // @100ms TTL 回收 → 即时补位(spawned=2)；@200ms 补出的进程再回收，
  // 命中 30s 冷却不得再补——否则进入无限重生风暴。
  // 轮询而非固定 sleep：机器高负载下定时器漂移会让固定等待先于第二次回收触发。
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(spawned === 2 && pool.stats().idle === 0)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(spawned, 2, 'ttl reclaim refilled once');
  assert.equal(pool.stats().idle, 0, 'second reclaim is held by cooldown');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spawned, 2, 'cooldown must block a respawn storm');
  pool.shutdown();
});
