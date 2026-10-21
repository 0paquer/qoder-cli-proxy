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
 *
 * 空闲保温（keepalive）：学习式补位只在「请求发生时」触发，指纹超过 TTL
 * 无请求就会回冷。保温巡检按间隔扫描已知指纹，发现池内无热进程即补位；
 * TTL 销毁热进程时经 removeEntry 钩子即时重建（30s 冷却防风暴）——默认
 * 保温窗口为 0（永不过期），指纹一旦建立即永久保温，长时间闲置后的首个
 * 请求依然是热路径。设正数窗口则超窗停保释放内存。启动预热见
 * admin-api.js 的 prewarmChatPools（解决「服务启动后的首个请求」）。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function poolSize() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_SIZE || 2));
}

function maxTotal() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_MAX_TOTAL || 5));
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

/** 保温巡检间隔（毫秒）：发现某指纹池内无热进程即补位。0 关闭。 */
function keepaliveMs() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_KEEPALIVE_MS || 60_000));
}

/**
 * 保温窗口（毫秒）：距最后一次请求超过该时长的指纹停止保温。
 * 默认 0 = 永不过期——TTL 销毁热进程的同时即时重建，指纹永久保温，
 * 长时间闲置后的首个请求依然是热路径；设为正数则超窗停保释放内存。
 */
function keepaliveWindowMs() {
  return Math.max(0, Number(process.env.QODER_WARM_POOL_KEEPALIVE_WINDOW_MS || 0));
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

function createWarmPool({
  size,
  maxTotal: maxTotalLimit,
  ttl,
  readyMs: readyMsLimit,
  keepaliveMs: keepaliveOpt,
  keepaliveWindowMs: keepaliveWindowOpt,
  spawnFn,
  log,
} = {}) {
  const cfg = {
    size: Math.max(0, Number(size != null ? size : poolSize())),
    maxTotal: Math.max(0, Number(maxTotalLimit != null ? maxTotalLimit : maxTotal())),
    // 注入路径允许极短 ttl（测试用）；环境变量路径由 ttlMs() 保证下限。
    ttl: Math.max(50, Number(ttl != null ? ttl : ttlMs())),
    // 注入路径允许 0（测试即时取用）；环境变量路径无下限需求。
    readyMs: Math.max(0, Number(readyMsLimit != null ? readyMsLimit : readyMs())),
    // 默认关闭，仅 defaultPool 按环境变量显式开启（测试注入路径保持确定性）。
    keepalive: Math.max(0, Number(keepaliveOpt != null ? keepaliveOpt : 0)),
    keepaliveWindow: Math.max(0, Number(keepaliveWindowOpt != null ? keepaliveWindowOpt : keepaliveWindowMs())),
  };

  /** 重读环境变量刷新全部容量/巡检参数。仅 defaultPool 的管理接口调用
   *  （测试注入的确定性配置会被环境变量覆盖，测试不应调用）。 */
  function refreshCfg() {
    cfg.size = Math.max(0, Number(poolSize()));
    cfg.maxTotal = Math.max(0, Number(maxTotal()));
    cfg.ttl = Math.max(50, Number(ttlMs()));
    cfg.readyMs = Math.max(0, Number(readyMs()));
    cfg.keepalive = Math.max(0, Number(keepaliveMs()));
    cfg.keepaliveWindow = Math.max(0, Number(keepaliveWindowMs()));
  }

  const doSpawn =
    spawnFn ||
    ((command, args, opts) => spawn(command, args, opts));

  // key -> [entry]
  const idle = new Map();
  // key -> { spec, lastSeen }：保温巡检的已知指纹表。offer/acquire（每次
  // 请求都会走到）刷新 lastSeen，超过保温窗口后由巡检清理。
  const specs = new Map();
  // key -> 上次即时补位时间（30s 冷却，防「补出的进程立刻又死」的风暴）。
  const instantRefill = new Map();
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
    if (list.length === 0) {
      idle.delete(key);
      // 池内归零（TTL 回收/进程早亡）：立即补位，不等下一轮巡检。
      ensureWarmed(key);
    }
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

  /** 补位实现（学习式请求路径与保温巡检共用）；不刷新 lastSeen。 */
  function offerImpl(key, spec) {
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
  }

  /** 池内归零后的即时补位：用已存 spec 立刻重建，不等下一轮巡检（回冷
   *  空档从「巡检间隔 + 成熟期」缩到仅成熟期）。30s 冷却防死亡风暴；
   *  保温关闭或指纹超窗时不补。 */
  function ensureWarmed(key) {
    if (stopped || cfg.keepalive <= 0) return;
    const tracked = specs.get(key);
    if (!tracked) return;
    if (cfg.keepaliveWindow > 0 && Date.now() - tracked.lastSeen > cfg.keepaliveWindow) {
      specs.delete(key);
      instantRefill.delete(key);
      return;
    }
    const last = instantRefill.get(key) || 0;
    if (Date.now() - last < 30_000) return;
    instantRefill.set(key, Date.now());
    offerImpl(key, tracked.spec);
  }

  // 空闲保温巡检：对窗口内的已知指纹，池内无热进程（TTL 回收/进程早亡）
  // 即补位。容量仍受 size/maxTotal 约束；unref 不阻塞进程退出。
  function keepaliveTick() {
    if (stopped || !isEnabled()) return;
    const now = Date.now();
    for (const [key, tracked] of specs) {
      if (cfg.keepaliveWindow > 0 && now - tracked.lastSeen > cfg.keepaliveWindow) {
        specs.delete(key);
        instantRefill.delete(key);
        continue;
      }
      const list = idle.get(key);
      if (!list || list.length === 0) offerImpl(key, tracked.spec);
    }
  }

  // 巡检定时器按当前 cfg.keepalive 重建：运行时改参经 startKeepalive 生效。
  let keepaliveTimer = null;
  function startKeepalive() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (stopped || cfg.keepalive <= 0) return;
    keepaliveTimer = setInterval(keepaliveTick, cfg.keepalive);
    keepaliveTimer.unref?.();
  }
  startKeepalive();

  /** 杀掉某指纹的全部空闲进程。调用方须先删 spec，否则归零钩子会重建。
   *  返回杀掉的进程数。 */
  function killIdleOfKey(key) {
    const list = idle.get(key);
    if (!list) return 0;
    let killed = 0;
    for (const entry of list.slice()) {
      removeEntry(key, entry);
      try {
        entry.child.kill();
        killed += 1;
      } catch (_) {
        // 进程可能已退出。
      }
    }
    idle.delete(key);
    return killed;
  }

  function killAllIdle() {
    let killed = 0;
    for (const key of Array.from(idle.keys())) killed += killIdleOfKey(key);
    return killed;
  }

  function buildStats() {
    return {
      enabled: isEnabled(),
      keys: idle.size,
      idle: totalIdle(),
      size: cfg.size,
      maxTotal: cfg.maxTotal,
      ttlMs: cfg.ttl,
      readyMs: cfg.readyMs,
      keepaliveMs: cfg.keepalive,
      keepaliveWindowMs: cfg.keepaliveWindow,
      trackedSpecs: specs.size,
    };
  }

  return {
    /** 取走一个成热的热进程（child-like 对象）；无可发放进程返回 null。不自动补位。 */
    acquire(key) {
      if (stopped) return null;
      const tracked = specs.get(key);
      if (tracked) tracked.lastSeen = Date.now();
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

    /** 学习式补位：为该指纹预热一个进程（受池大小与并发限制），并登记保温。 */
    offer(key, spec) {
      if (stopped || !spec || !spec.token) return;
      specs.set(key, { spec, lastSeen: Date.now() });
      offerImpl(key, spec);
    },

    stats() {
      return buildStats();
    },

    /** 运行时改参：重读环境变量刷新容量/巡检配置并立即按新容量补位。
     *  缩小上限不立刻杀进程，随 TTL 回收逐步收敛；返回新统计。 */
    reconfigure() {
      if (stopped) return buildStats();
      refreshCfg();
      startKeepalive();
      keepaliveTick(); // 立即应用窗口收缩（超窗指纹出表）并补位一轮
      // 按新容量把各指纹填满（受 size/maxTotal 约束，guard 防异常自旋）
      let spawned = 0;
      for (const [key, tracked] of specs) {
        for (let guard = 0; guard < 64; guard += 1) {
          const before = (idle.get(key) || []).length;
          if (before >= cfg.size || totalIdle() >= cfg.maxTotal) break;
          instantRefill.delete(key);
          offerImpl(key, tracked.spec);
          if ((idle.get(key) || []).length <= before) break; // spawn 失败，等下轮巡检
          spawned += 1;
        }
      }
      if (spawned) logInfo('warm pool reconfigured', { spawned, size: cfg.size, maxTotal: cfg.maxTotal });
      return buildStats();
    },

    /** 管理面：逐指纹列出池状态。rows 含 spec（内含 token，调用方映射账号后必须剔除）。 */
    list() {
      const now = Date.now();
      const rows = new Map();
      for (const [key, tracked] of specs) {
        rows.set(key, {
          key,
          spec: tracked.spec,
          lastSeenAgoMs: now - tracked.lastSeen,
          entries: [],
        });
      }
      for (const [key, list] of idle) {
        let row = rows.get(key);
        if (!row) {
          row = { key, spec: null, lastSeenAgoMs: null, entries: [] };
          rows.set(key, row);
        }
        row.entries = list.map((e) => ({
          ageMs: now - e.spawnedAt,
          immature: now - e.spawnedAt < cfg.readyMs,
        }));
      }
      for (const row of rows.values()) {
        const last = instantRefill.get(row.key) || 0;
        row.refillCooldownMs = Math.max(0, 30_000 - (now - last));
      }
      return Array.from(rows.values());
    },

    /** 手动预热：为指定（省略则全部）已登记指纹补进程，绕过 30s 补位冷却，
     *  仍受 size / maxTotal 容量上限约束。返回实际补位数。 */
    prewarm(key) {
      if (stopped) return 0;
      const targets = key ? [key] : Array.from(specs.keys());
      let spawned = 0;
      for (const k of targets) {
        const tracked = specs.get(k);
        if (!tracked) continue;
        const before = (idle.get(k) || []).length;
        instantRefill.delete(k); // 手动操作不吃冷却
        offerImpl(k, tracked.spec);
        spawned += (idle.get(k) || []).length - before;
      }
      if (spawned) logInfo('warm pool manual prewarm', { requested: targets.length, spawned });
      return spawned;
    },

    /** 驱逐指纹：杀其空闲热进程并从保温表移除（请求中的 taken 进程不受影响）。
     *  返回杀掉的进程数。 */
    evict(key) {
      const hadSpec = specs.delete(key);
      instantRefill.delete(key);
      const killed = killIdleOfKey(key);
      logInfo('warm pool evicted', { key, hadSpec, killed });
      return killed;
    },

    /** 清空热池：杀掉全部空闲热进程并清空保温表（下次请求重新学习）。
     *  返回杀掉的进程数。 */
    clear() {
      // 先清保温表再杀进程：否则归零钩子会按 spec 立即重建。
      specs.clear();
      instantRefill.clear();
      const killed = killAllIdle();
      logInfo('warm pool cleared', { killed });
      return killed;
    },

    shutdown() {
      stopped = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      specs.clear();
      instantRefill.clear();
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
  // 空闲保温仅默认池开启（测试注入路径默认关闭，保持确定性）。
  keepaliveMs: keepaliveMs(),
  keepaliveWindowMs: keepaliveWindowMs(),
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
