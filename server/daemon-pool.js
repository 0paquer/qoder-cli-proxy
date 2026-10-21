'use strict';

/**
 * 控制面 daemon 常驻池：每账号（token + baseUrl + backend 指纹）维持一个
 * 常驻 SDK daemon，同时服务模型目录与用量额度两种控制查询，免去每次查询
 * 重新 startDaemon 的初始化成本（实测约 7s；热查询 getModels/getUsageInfo
 * <100ms，见 qoder-session loadModelCatalog 注释）。
 *
 * 与对话 warm-pool 的分工（两池独立、互不挤占）：
 *   - 对话：warm-pool.js，用完即弃（隔离探针实证不可跨请求复用）；
 *   - 控制面：本模块，无状态控制请求安全复用常驻进程。
 *
 * 生命周期原则（与 warm-pool 一致）：
 *   - 好进程保温：空闲超过 QODER_DAEMON_TTL_MS 自动 stop 回收；
 *   - 坏进程剔除：daemon.state !== 'ready' 或查询抛错即 drop，下次重建，
 *     绝不让坏进程占坑持续失败；
 *   - 同指纹并发查询合并（inflight），首个调用负责 startDaemon。
 *
 * QODER_DAEMON_POOL=0 关闭复用：每次现起用完即 stop（等价旧行为）。
 */

const crypto = require('crypto');
const { startDaemon } = require('@qoder-ai/qoder-agent-sdk');

function isEnabled() {
  return !/^(0|false|off)$/i.test(process.env.QODER_DAEMON_POOL || '1');
}

/** 空闲回收时限：每次取用刷新，到点 stop。默认 4 小时——与对话 warm-pool
 *  的保温窗口对齐：闲置窗口内 daemon 常驻（模型/用量查询恒热），超窗才
 *  释放内存。曾默认 10 分钟，闲置稍久的首次查询要重付约 7-15s 初始化。 */
function ttlMs() {
  return Math.max(10_000, Number(process.env.QODER_DAEMON_TTL_MS || 4 * 60 * 60_000));
}

/** key = 账号凭据 + 后端 + baseUrl（env/bundle 均由其派生）。 */
function keyFor({ token, baseUrl, backendType }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([backendType || 'cn', baseUrl || '', String(token || '')]))
    .digest('hex')
    .slice(0, 24);
}

// key → { daemon, lastUsedAt, timer }
const entries = new Map();
// key → Promise<Daemon>（并发合并）
const inflight = new Map();

function logInfo(msg, meta) {
  try {
    console.log(`[daemon-pool] ${msg}`, meta || '');
  } catch (_) {
    // 日志失败不影响池。
  }
}

async function stopEntry(key, entry, reason) {
  if (entries.get(key) !== entry) return;
  entries.delete(key);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  try {
    await entry.daemon.stop();
    logInfo('daemon stopped', { key, reason });
  } catch (_) {
    // stop 失败（可能已死）无害。
  }
}

function scheduleTtl(key, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    // 到点再校验：期间被取用过则续期（touch 会重建定时器，此处防竞态）。
    if (entries.get(key) !== entry) return;
    if (Date.now() - entry.lastUsedAt < ttlMs()) {
      scheduleTtl(key, entry);
      return;
    }
    stopEntry(key, entry, 'ttl');
  }, ttlMs());
  entry.timer.unref?.();
}

/**
 * 取（或建）该账号的常驻 daemon。
 * startOptions：透传给 startDaemon 的构造参数（auth/env/bundlePath 等），
 * 由调用方按查询上下文提供，指纹与 key 一致。
 */
async function getDaemon(keyInput, startOptions) {
  const key = keyFor(keyInput);

  if (!isEnabled()) {
    // 关闭复用：用完即 stop 的一次性 daemon。
    const daemon = await startDaemon(startOptions);
    return {
      daemon,
      release: async () => {
        try {
          await daemon.stop();
        } catch (_) {
          // 一次性 daemon 收尾失败无害。
        }
      },
    };
  }

  const hit = entries.get(key);
  if (hit) {
    if (hit.daemon.state === 'ready') {
      hit.lastUsedAt = Date.now();
      scheduleTtl(key, hit);
      return { daemon: hit.daemon, release: null };
    }
    // 坏进程剔除：state 非 ready 立即丢弃重建。
    logInfo('daemon unhealthy, dropping', { key, state: hit.daemon.state });
    stopEntry(key, hit, 'unhealthy');
  }

  if (inflight.has(key)) {
    const daemon = await inflight.get(key);
    const entry = entries.get(key);
    if (entry) {
      entry.lastUsedAt = Date.now();
      scheduleTtl(key, entry);
    }
    return { daemon, release: null };
  }

  const promise = (async () => {
    const daemon = await startDaemon(startOptions);
    const entry = { daemon, lastUsedAt: Date.now(), timer: null, token: keyInput.token };
    entries.set(key, entry);
    scheduleTtl(key, entry);
    logInfo('daemon ready', { key });
    return daemon;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return { daemon: await promise, release: null };
}

/** 查询抛错时剔除该账号 daemon（坏进程不占坑），下次取用重建。 */
async function drop(keyInput) {
  if (!isEnabled()) return;
  const key = keyFor(keyInput);
  const entry = entries.get(key);
  if (entry) await stopEntry(key, entry, 'query-failed');
}

/** 进程退出时兜底回收全部常驻 daemon，避免孤儿子进程。 */
function shutdown() {
  for (const [key, entry] of [...entries.entries()]) {
    stopEntry(key, entry, 'shutdown');
  }
}
process.once('exit', shutdown);

/** 管理接口统计：不回传 token（仅供 admin-api 反查账号后脱敏输出）。 */
function stats() {
  const now = Date.now();
  const ttl = ttlMs();
  return {
    enabled: isEnabled(),
    ttlMs: ttl,
    entries: [...entries.entries()].map(([key, entry]) => ({
      key,
      state: entry.daemon ? entry.daemon.state : 'unknown',
      token: entry.token || null,
      lastUsedAgoMs: Math.max(0, now - entry.lastUsedAt),
      nextReclaimMs: Math.max(0, ttl - (now - entry.lastUsedAt)),
    })),
  };
}

/** 运行时改参：重读 env 后按新 TTL 重排全部回收定时器；池被关闭时全量回收。 */
function reconfigure() {
  if (!isEnabled()) {
    for (const [key, entry] of [...entries.entries()]) {
      stopEntry(key, entry, 'disabled');
    }
    return stats();
  }
  for (const [key, entry] of entries) scheduleTtl(key, entry);
  return stats();
}

/** 按指纹回收单个常驻 daemon；返回是否命中。 */
async function dropByKey(key) {
  const entry = entries.get(key);
  if (!entry) return false;
  await stopEntry(key, entry, 'manual-drop');
  return true;
}

/** 手动回收全部常驻 daemon（管理页「回收全部」）。 */
async function dropAll() {
  const n = entries.size;
  for (const [key, entry] of [...entries.entries()]) {
    await stopEntry(key, entry, 'manual-drop-all');
  }
  return n;
}

module.exports = {
  getDaemon,
  drop,
  shutdown,
  isEnabled,
  ttlMs,
  keyFor,
  stats,
  reconfigure,
  dropByKey,
  dropAll,
};
