'use strict';

/**
 * 预热进程池：提前 spawn CLI 进程，请求到来时直接取用，
 * 跳过 spawn node + bundle 加载的冷启动（实测 4-14s → 热路径 1.4-1.8s）。
 *
 * 生命周期语义（warm-pool 探针实证，2026-10-17）：
 *   - CLI 在收到 stdin 首条消息前完全静默，「预热」只能是 spawn 后保持
 *     存活等待，无法主动确认内部就绪；bundle 缺失/认证失败等早期死亡
 *     通过 exit 事件检测并丢弃。
 *   - 进程服务一轮对话即被 SDK abort/kill（用完即弃），绝不跨轮复用——
 *     同进程多轮共享上下文（隔离探针 FAIL），任意复用会泄露请求间信息。
 *   - auth payload 由池自建（QODER_SDK_AUTH_PAYLOAD_FILE）；SDK 的一次性
 *     payload 会话结束即删，不可复用。
 *
 * 预热是学习式的：首次请求仍冷启动，钩子在冷启动的同时为相同指纹
 * （账号 + 命令行参数 + 环境）补一个热进程，后续同指纹请求直接取用。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function poolSize() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_SIZE || 1));
}

function maxTotal() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_MAX_TOTAL || 3));
}

function ttlMs() {
  return Math.max(30_000, Number(process.env.QODER_WARM_POOL_TTL_MS || 10 * 60_000));
}

/**
 * 成熟期：spawn 后 bundle 加载完成前（实测约 4-6s）进程即使被取用也得
 * 等加载，总耗时接近冷启动（实证：age 2.6s 的进程响应 12.5s，age≥11s
 * 的进程 2.6s）。未满成熟期的进程不发放，留在池里继续保温。
 */
function readyMs() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_READY_MS || 6_000));
}

function isEnabled() {
  return !/^(0|false|off)$/i.test(process.env.QODER_WARM_POOL || '1');
}

/** env 中影响 CLI 行为的稳定部分（排除每请求变化的 auth payload 路径）。 */
function stableEnvPart(env) {
  const pairs = Object.entries(env || {})
    .filter(([k]) => /^QODER/i.test(k) && k !== 'QODER_SDK_AUTH_PAYLOAD_FILE')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(pairs);
}

/**
 * 池指纹：同一 (token, command, args, env) 组合共用热进程。
 * token 只参与哈希，不落池。
 */
function keyFor({ command, args, env, token }) {
  const tokenFp = token
    ? crypto.createHash('sha256').update(String(token), 'utf8').digest('hex').slice(0, 16)
    : 'notoken';
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([command, args, stableEnvPart(env), tokenFp]))
    .digest('hex')
    .slice(0, 24);
}

function createWarmPool({ size, maxTotal: maxTotalLimit, ttl, readyMs: readyMsLimit, spawnFn, log } = {}) {
  const cfg = {
    size: Math.max(0, Number(size != null ? size : poolSize())),
    maxTotal: Math.max(0, Number(maxTotalLimit != null ? maxTotalLimit : maxTotal())),
    // 注入路径允许极短 ttl（测试用）；环境变量路径由 ttlMs() 保证下限。
    ttl: Math.max(50, Number(ttl != null ? ttl : ttlMs())),
    // 注入路径允许 0（测试即时取用）；环境变量路径无下限需求。
    readyMs: Math.max(0, Number(readyMsLimit != null ? readyMsLimit : readyMs())),
  };
  const doSpawn =
    spawnFn ||
    ((command, args, opts) => spawn(command, args, opts));

  // key -> [entry]
  const idle = new Map();
  let stopped = false;

  function logInfo(msg, meta) {
    if (typeof log === 'function') log(msg, meta);
  }

  function totalIdle() {
    let n = 0;
    for (const list of idle.values()) n += list.length;
    return n;
  }

  function cleanupPayload(entry) {
    if (entry.payloadCleaned) return;
    entry.payloadCleaned = true;
    try {
      fs.rmSync(entry.payloadDir, { recursive: true, force: true });
    } catch (_) {
      // 临时目录清理失败无害，OS 会兜底回收。
    }
  }

  function discard(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.status = 'discarded';
    cleanupPayload(entry);
  }

  function removeEntry(key, entry) {
    const list = idle.get(key);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) idle.delete(key);
    discard(entry);
  }

  function spawnEntry(key, spec) {
    const payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-warm-auth-'));
    const payloadFile = path.join(payloadDir, 'payload.json');
    fs.writeFileSync(
      payloadFile,
      JSON.stringify({ type: 'accessToken', accessToken: String(spec.token) }),
      { mode: 0o600 }
    );

    const child = doSpawn(spec.command, spec.args, {
      cwd: spec.cwd || process.cwd(),
      env: { ...(spec.env || {}), QODER_SDK_AUTH_PAYLOAD_FILE: payloadFile },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry = {
      key,
      status: 'idle',
      child,
      payloadDir,
      spawnedAt: Date.now(),
      exited: false,
      timer: null,
    };

    child.on('exit', (code, signal) => {
      entry.exited = true;
      if (entry.status === 'taken') {
        // 所有权已移交请求，仅清理 payload。
        cleanupPayload(entry);
        return;
      }
      removeEntry(key, entry);
      logInfo('warm pool process exited before use', {
        key,
        ageMs: Date.now() - entry.spawnedAt,
        code,
        signal,
      });
    });
    child.on('error', (err) => {
      entry.exited = true;
      if (entry.status !== 'taken') removeEntry(key, entry);
      logInfo('warm pool process spawn error', { key, error: err && err.message });
    });

    entry.timer = setTimeout(() => {
      if (entry.status === 'taken') return;
      removeEntry(key, entry);
      try {
        child.kill();
      } catch (_) {
        // 进程可能已退出。
      }
      logInfo('warm pool process reclaimed by ttl', { key });
    }, cfg.ttl);
    entry.timer.unref?.();

    return entry;
  }

  return {
    /** 取走一个成热的热进程（child-like 对象）；无可发放进程返回 null。不自动补位。 */
    acquire(key) {
      if (stopped) return null;
      const list = idle.get(key);
      if (!list || list.length === 0) return null;
      const now = Date.now();
      while (list.length) {
        const entry = list[0];
        // 未满成熟期：不消费，留在队首继续保温（取用未成熟进程≈冷启动）。
        if (now - entry.spawnedAt < cfg.readyMs) return null;
        list.shift();
        if (list.length === 0) idle.delete(key);
        if (entry.exited || entry.child.killed || entry.child.exitCode !== null) {
          discard(entry);
          continue;
        }
        entry.status = 'taken';
        if (entry.timer) clearTimeout(entry.timer);
        return entry.child;
      }
      return null;
    },

    /** 学习式补位：为该指纹异步预热一个进程（受池大小与并发限制）。 */
    offer(key, spec) {
      if (stopped || !spec || !spec.token) return;
      const list = idle.get(key) || [];
      if (list.length >= cfg.size) return;
      if (totalIdle() >= cfg.maxTotal) return;
      // offer 同步执行（spawnEntry 不是异步的），无需并发闸门；
      // 上限由上面的 size / maxTotal 两个池容量条件控制。
      try {
        const entry = spawnEntry(key, spec);
        list.push(entry);
        idle.set(key, list);
        logInfo('warm pool process prewarmed', { key, total: totalIdle() });
      } catch (err) {
        // 补位失败只记日志不冒泡：offer 在热路径 acquire 成功后被调用，
        // 抛错会让请求失败且刚取走（taken）的进程无人管理成为孤儿
        logInfo('warm pool refill failed', { key, message: err && err.message });
      }
    },

    stats() {
      return {
        enabled: isEnabled(),
        keys: idle.size,
        idle: totalIdle(),
        size: cfg.size,
        maxTotal: cfg.maxTotal,
        ttlMs: cfg.ttl,
        readyMs: cfg.readyMs,
      };
    },

    shutdown() {
      stopped = true;
      for (const [key, list] of idle.entries()) {
        for (const entry of list) {
          try {
            entry.child.kill();
          } catch (_) {
            // 已退出。
          }
          discard(entry);
        }
      }
      idle.clear();
    },
  };
}

const defaultPool = createWarmPool({
  log: (msg, meta) => {
    try {
      console.log(`[warm-pool] ${msg}`, meta || '');
    } catch (_) {
      // 日志失败不影响池本身。
    }
  },
});

module.exports = {
  createWarmPool,
  defaultPool,
  keyFor,
  isEnabled,
  stableEnvPart,
};
