'use strict';

/**
 * Multi-account gateway admin API.
 *
 * Mounted at /admin in app.js, ahead of the legacy single-user admin routes
 * (login, env-config, restart…), which stay in app.js and keep working —
 * paths that the router defines take precedence, everything else falls
 * through unchanged.
 *
 * Domains:
 *   /admin/accounts*            — Qoder accounts (identity + PAT + schedule)
 *   /admin/users*               — gateway users, API keys, grants, quotas
 *   /admin/keys/:id             — key revocation / deletion
 *   /admin/usage/*              — aggregated usage facts for the console
 */

const express = require('express');
const { AppError, openAiError } = require('./errors');
const { adminGuard } = require('./auth');
const dbModule = require('./db');
const accountsStore = require('./stores/accounts');
const usersStore = require('./stores/users');
const usageStore = require('./stores/usage');
const balancer = require('./balancer');
const qoderCli = require('./qoder-engine');
const warmPool = require('./warm-pool');
const { getLogs, clearLogs } = require('./logger');
const { MODELS } = require('./models');

const { db } = dbModule;

function fail(res, error) {
  const appError =
    error instanceof AppError
      ? error
      : new AppError(400, 'invalid_request', String((error && error.message) || error));
  return openAiError(res, appError);
}

function notFound(res, message) {
  return fail(res, new AppError(404, 'not_found', message));
}

function createAdminApi() {
  const router = express.Router();

  // ── Session identity (any logged-in user, not just admins) ────────────────
  router.get('/me', (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) {
      return fail(res, new AppError(401, 'unauthorized', 'Not logged in.'));
    }

    const session = dbModule.verifySession(token);
    if (!session) {
      return fail(res, new AppError(401, 'unauthorized', 'Invalid or expired token.'));
    }
    const user = usersStore.getUserByUsername(session.username);
    if (!user || !user.enabled) {
      return fail(res, new AppError(401, 'unauthorized', 'Invalid or expired token.'));
    }
    return res.json({
      ok: true,
      authenticated: true,
      authType: 'session',
      user: { id: user.id, username: user.username, role: user.role },
      role: user.role,
      username: user.username,
    });
  });

  // ── Accounts ───────────────────────────────────────────────────────────────

  /** 已缓存额度快照（来自 usage 查询），无缓存/过期返回 null——列表只读缓存，不触发实时查询。 */
  function quotaSnapshot(accountId) {
    const hit = accountUsageCache.get(accountId);
    if (!hit || !hit.ok || !hit.usage || !Array.isArray(hit.usage.buckets)) return null;
    const { buckets } = hit.usage;
    if (buckets.length === 0) return null;
    const total = buckets.reduce((sum, b) => sum + b.total, 0);
    const remaining = buckets.reduce((sum, b) => sum + b.remaining, 0);
    return {
      remaining,
      total,
      usedPercentage: total > 0 ? Math.round(((total - remaining) / total) * 100) : 0,
      isQuotaExceeded: Boolean(hit.usage.isQuotaExceeded),
      expiresAt: hit.usage.expiresAt,
      buckets,
      queriedAt: hit.at,
    };
  }

  router.get('/accounts', adminGuard, (_req, res) => {
    res.json({
      ok: true,
      accounts: accountsStore.listAccounts().map((a) => ({ ...a, quota: quotaSnapshot(a.id) })),
    });
  });

  router.post('/accounts', adminGuard, (req, res) => {
    const body = req.body || {};
    const result = accountsStore.createAccount({
      name: body.name,
      backendType: body.backendType,
      baseUrl: body.baseUrl,
      pat: body.pat,
      weight: body.weight,
      maxConcurrency: body.maxConcurrency,
      remark: body.remark,
    });
    if (!result.ok) return fail(res, new AppError(400, 'invalid_request', result.error));
    res.json({ ok: true, account: result.account });
  });

  router.get('/accounts/:id', adminGuard, (req, res) => {
    const account = accountsStore.getAccount(req.params.id);
    if (!account) return notFound(res, 'Account not found');
    res.json({ ok: true, account });
  });

  router.patch('/accounts/:id', adminGuard, (req, res) => {
    const body = req.body || {};
    const result = accountsStore.updateAccount(req.params.id, {
      name: body.name,
      backendType: body.backendType,
      baseUrl: body.baseUrl,
      enabled: body.enabled,
      remark: body.remark,
    });
    if (!result.ok) {
      return result.error === 'Account not found'
        ? notFound(res, result.error)
        : fail(res, new AppError(400, 'invalid_request', result.error));
    }
    if (body.weight !== undefined || body.maxConcurrency !== undefined) {
      accountsStore.updateSchedule(req.params.id, {
        weight: body.weight,
        maxConcurrency: body.maxConcurrency,
      });
    }
    res.json({ ok: true, account: accountsStore.getAccount(req.params.id) });
  });

  router.delete('/accounts/:id', adminGuard, (req, res) => {
    if (!accountsStore.deleteAccount(req.params.id)) {
      return notFound(res, 'Account not found');
    }
    res.json({ ok: true });
  });

  router.post('/accounts/:id/pat', adminGuard, (req, res) => {
    const pat = String((req.body || {}).pat || '').trim();
    if (!pat) return fail(res, new AppError(400, 'invalid_request', 'PAT is required'));
    const result = accountsStore.setAccountPat(req.params.id, pat);
    if (!result.ok) return notFound(res, result.error);
    res.json({ ok: true });
  });

  /**
   * Real verification: load the model catalog from the SDK daemon with the
   * stored PAT. Proves the credential works without consuming chat tokens —
   * triggered explicitly from the console.
   */
  router.post('/accounts/:id/verify', adminGuard, async (req, res) => {
    const account = accountsStore.getAccount(req.params.id);
    if (!account) return notFound(res, 'Account not found');
    const pat = accountsStore.getPat(account.id);
    if (!pat) return fail(res, new AppError(400, 'invalid_request', 'Account has no PAT stored'));

    const started = Date.now();
    const result = await qoderCli.loadModelCatalog({
      token: pat,
      baseUrl: account.baseUrl || undefined,
      backendType: account.backendType || 'cn',
    }).catch((error) => ({
      ok: false,
      error: error instanceof AppError ? error.message : String((error && error.message) || error),
    }));
    if (result.ok) {
      accountsStore.setVerifyStatus(account.id, 'verified');
      balancer.reportSuccess(account.id);
      res.json({
        ok: true,
        verifyStatus: 'verified',
        models: (result.models || []).map((m) => m.name || m.id),
        durationMs: Date.now() - started,
      });
    } else {
      accountsStore.setVerifyStatus(account.id, 'failed');
      balancer.reportFailure(account.id, result.error);
      res.json({
        ok: false,
        verifyStatus: 'failed',
        error: result.error,
        durationMs: Date.now() - started,
      });
    }
  });

  // ── 账号额度查询（SDK 控制协议，零 token）───────────────────────────────────
  // 与模型缓存同策略：成功 60s / 失败 15s。只读查询，不影响调度状态。
  const accountUsageCache = new Map();

  function cacheUsageResult(accountId, result) {
    if (result && result.ok) {
      accountUsageCache.set(accountId, { at: Date.now(), ok: true, usage: result.usage });
      // 额度快照落定即更新调度权重：effectiveWeight = 配置权重 × 剩余比例。
      // 这是权重刷新的合适时机（后台预刷新/手动查询），不做常驻轮询。
      syncQuotaFactor(accountId, result.usage);
    } else {
      const message = (result && result.error) || 'Usage query failed';
      accountUsageCache.set(accountId, {
        at: Date.now(),
        ok: false,
        error: message instanceof AppError ? message : new AppError(502, 'upstream_error', String(message)),
      });
    }
  }

  /** 由额度桶计算调度因子：剩余比例 clamp 0..1；超限或无剩余 → 0。 */
  function syncQuotaFactor(accountId, usage) {
    if (!usage || !Array.isArray(usage.buckets) || usage.buckets.length === 0) return;
    const total = usage.buckets.reduce((sum, b) => sum + (Number(b.total) || 0), 0);
    const remaining = usage.buckets.reduce((sum, b) => sum + (Number(b.remaining) || 0), 0);
    if (usage.isQuotaExceeded || total <= 0) {
      balancer.setQuotaFactor(accountId, 0);
      return;
    }
    balancer.setQuotaFactor(accountId, Math.max(0, Math.min(1, remaining / total)));
  }

  // 后台预刷新：单次额度查询需 spawn CLI（实测 9-14s/账号），列表页无法
  // 逐账号现查。定时串行刷新 enabled 账号，GET /accounts 即可直接带快照。
  // unref + 测试门控（QODER_PROXY_NO_USAGE_REFRESH）保证不挂测试进程。
  const USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

  async function refreshAllAccountUsage() {
    const accounts = accountsStore.listAccounts().filter((a) => a.enabled);
    for (const account of accounts) {
      const pat = accountsStore.getPat(account.id);
      if (!pat) continue;
      try {
        cacheUsageResult(
          account.id,
          await qoderCli.loadAccountUsage({
            token: pat,
            baseUrl: account.baseUrl || undefined,
            backendType: account.backendType || 'cn',
          })
        );
      } catch (error) {
        cacheUsageResult(account.id, { ok: false, error });
      }
    }
  }

  if (process.env.QODER_PROXY_NO_USAGE_REFRESH !== '1') {
    const usageRefreshTimer = setInterval(() => {
      refreshAllAccountUsage().catch(() => {});
    }, USAGE_REFRESH_INTERVAL_MS);
    usageRefreshTimer.unref?.();
    // 启动后 3s 先刷一轮，让首次打开账号页就有快照。
    setTimeout(() => {
      refreshAllAccountUsage().catch(() => {});
    }, 3000).unref?.();

    // ─── 对话进程启动预热 ────────────────────────────────────────
    // warm-pool 是学习式的：首个对话请求必须自己冷启动（实测约 20s）。
    // 这里启动后在后台把冷启动先跑掉：对每个启用账号各发一次极小对话——
    // 流式与非流式各一次（CLI 带不带 --include-partial-messages 会分叉池
    // 指纹，必须分别补位）——probe 自身冷启动发生在后台，同时 offer 出
    // 成熟热进程，用户首个请求即可命中热路径。每次启动每账号约几十 token。
    // QODER_WARM_POOL_PREWARM=0 关闭；与用量刷新共用测试门控。
    async function prewarmChatPools() {
      if (!warmPool.isEnabled()) return;
      if (/^(0|false|off)$/i.test(process.env.QODER_WARM_POOL_PREWARM || '1')) return;
      const accounts = accountsStore.listAccounts().filter((a) => a.enabled);
      for (const account of accounts) {
        const pat = accountsStore.getPat(account.id);
        if (!pat) continue;
        const base = {
          messages: [{ role: 'user', content: '只回复 OK' }],
          model: 'auto',
          token: pat,
          baseUrl: account.baseUrl || undefined,
          backendType: account.backendType || 'cn',
          timeoutMs: 60000,
        };
        const variants = [
          ['non-stream', () => qoderCli.runQoderCnCli(base)],
          ['stream', () => qoderCli.runQoderCnCliStream({ ...base, onDelta: () => {} })],
        ];
        for (const [label, run] of variants) {
          const started = Date.now();
          try {
            await run();
            console.log('[chat-prewarm] probe done', { accountId: account.id, label, ms: Date.now() - started });
          } catch (error) {
            console.log('[chat-prewarm] probe failed', {
              accountId: account.id,
              label,
              ms: Date.now() - started,
              message: error && error.message,
            });
          }
        }
      }
    }
    // 晚于用量刷新启动，避免与 daemon 初始化抢跑；unref 不阻塞退出。
    setTimeout(() => {
      prewarmChatPools().catch(() => {});
    }, 8000).unref?.();
  }

  router.post('/accounts/:id/usage', adminGuard, async (req, res) => {
    const account = accountsStore.getAccount(req.params.id);
    if (!account) return notFound(res, 'Account not found');

    const hit = accountUsageCache.get(account.id);
    if (hit && Date.now() - hit.at < (hit.ok ? 60000 : 15000)) {
      return hit.ok ? res.json({ ok: true, usage: hit.usage, cached: true }) : fail(res, hit.error);
    }

    const started = Date.now();
    try {
      const pat = accountsStore.getPat(account.id);
      if (!pat) throw new AppError(400, 'invalid_request', 'Account has no PAT stored');
      const result = await qoderCli.loadAccountUsage({
        token: pat,
        baseUrl: account.baseUrl || undefined,
        backendType: account.backendType || 'cn',
      });
      if (result.ok) {
        cacheUsageResult(account.id, result);
        return res.json({ ok: true, usage: result.usage, durationMs: Date.now() - started });
      }
      throw new AppError(502, 'upstream_error', result.error || 'Usage query failed');
    } catch (error) {
      cacheUsageResult(account.id, { ok: false, error });
      return fail(res, error);
    }
  });

  // ── Playground（测试对话）───────────────────────────────────────────────────
  const staticModels = () => MODELS.map(({ id, name }) => ({ id, name }));

  /**
   * GET /admin/models            → 静态模型表
   * GET /admin/models?accountId= → 该账号的真实模型（SDK daemon 模型目录，
   *                                 自带 credit 倍率 rate，零 token）
   *                                 失败/无 PAT 时回退静态表（source 标记来源）
   * 测试对话专用：永远不使用缓存（force），每次真实查询，确保下拉实时反映
   * 服务端模型目录变化。
   */
  router.get('/models', adminGuard, async (req, res) => {
    const accountId = Number(req.query.accountId);
    if (!accountId) return res.json({ ok: true, source: 'static', models: staticModels() });

    const account = accountsStore.getAccount(accountId);
    if (!account) return notFound(res, 'Account not found');

    try {
      const pat = accountsStore.getPat(accountId);
      if (!pat) throw new AppError(400, 'invalid_request', 'Account has no PAT stored');
      const baseUrl = account.baseUrl || undefined;
      const backendType = account.backendType || 'cn';
      const catalog = await qoderCli.loadModelCatalog({ token: pat, baseUrl, backendType, force: true });
      // 字段语义与 /v1/models 统一：id/value/displayName = 模型显示名称
      // （客户端读 id 展示），modelId = CLI 内部代号（对话交互字段）；
      // 其余原始 ModelInfo 字段原样透传。
      const models = (catalog.models || [])
        .filter((m) => m && typeof m === 'object')
        .map((m) => {
          const raw = m.raw && typeof m.raw === 'object' ? m.raw : null;
          const code = String(m.id ?? '').trim() || String(raw?.modelId ?? raw?.value ?? '').trim();
          const official =
            String(m.name ?? '').trim() || String(raw?.displayName ?? raw?.value ?? '').trim();
          if (!code) return null;
          return {
            ...(raw || {}),
            modelId: code,
            value: official || code,
            displayName: official || code,
            id: official || code,
          };
        })
        .filter(Boolean);
      const ok = models.length > 0;
      return res.json(
        ok
          ? { ok: true, source: 'account', models }
          : { ok: true, source: 'static', models: staticModels() }
      );
    } catch (error) {
      return fail(res, error);
    }
  });

  /**
   * Test chat: run one real CLI request against a specific account.
   * Bypasses the balancer and quota accounting on purpose — this is the
   * admin console's playground, not a gateway path. Success/failure still
   * feeds the balancer so cooldown state stays truthful.
   */
  router.post('/test-chat', adminGuard, async (req, res) => {
    const body = req.body || {};
    const account = accountsStore.getAccount(Number(body.accountId));
    if (!account) return notFound(res, 'Account not found');
    const pat = accountsStore.getPat(account.id);
    if (!pat) return fail(res, new AppError(400, 'invalid_request', 'Account has no PAT stored'));

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m) =>
          m &&
          typeof m.content === 'string' &&
          m.content.trim() &&
          ['user', 'assistant', 'system'].includes(m.role)
      )
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length) {
      return fail(res, new AppError(400, 'invalid_request', 'messages is required'));
    }

    const started = Date.now();
    let usage = null;
    let thinking = '';
    try {
      const content = await qoderCli.runQoderCnCli({
        messages,
        model: String(body.model || 'qoder-cn'),
        token: pat,
        baseUrl: account.baseUrl || undefined,
        backendType: account.backendType || 'cn',
        onUsage: (u) => {
          usage = u;
        },
        onThinking: (t) => {
          thinking = t;
        },
      });
      balancer.reportSuccess(account.id);
      res.json({ ok: true, content, thinking: thinking || undefined, usage, durationMs: Date.now() - started });
    } catch (error) {
      balancer.reportFailure(account.id, error);
      res.json({
        ok: false,
        error: error.message,
        code: error.code || 'internal_error',
        durationMs: Date.now() - started,
      });
    }
  });

  /**
   * Streaming variant of /test-chat (SSE). Emits:
   *   data: {"type":"delta","delta":"..."}   incremental text
   *   data: {"type":"done",...}              final summary (same shape as /test-chat)
   *   data: [DONE]
   * Client disconnects abort the upstream CLI call via the engine signal.
   */
  router.post('/test-chat/stream', adminGuard, async (req, res) => {
    const body = req.body || {};
    const account = accountsStore.getAccount(Number(body.accountId));
    if (!account) return notFound(res, 'Account not found');
    const pat = accountsStore.getPat(account.id);
    if (!pat) return fail(res, new AppError(400, 'invalid_request', 'Account has no PAT stored'));

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m) =>
          m &&
          typeof m.content === 'string' &&
          m.content.trim() &&
          ['user', 'assistant', 'system'].includes(m.role)
      )
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length) {
      return fail(res, new AppError(400, 'invalid_request', 'messages is required'));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    const controller = new AbortController();
    // 注意：新版 Node 中 req 的 'close' 在请求体读完即触发（非断连），
    // 必须监听 res 并用 writableEnded 区分「正常结束」与「客户端提前断开」。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const started = Date.now();
    let usage = null;
    let thinking = '';
    try {
      const content = await qoderCli.runQoderCnCliStream({
        messages,
        model: String(body.model || 'qoder-cn'),
        token: pat,
        baseUrl: account.baseUrl || undefined,
        backendType: account.backendType || 'cn',
        signal: controller.signal,
        onDelta: (delta) => send({ type: 'delta', delta }),
        onThinking: (t) => {
          thinking += t;
          send({ type: 'thinking', delta: t });
        },
        onUsage: (u) => {
          usage = u;
        },
      });
      balancer.reportSuccess(account.id);
      send({ type: 'done', ok: true, content, thinking: thinking || undefined, usage, durationMs: Date.now() - started });
    } catch (error) {
      balancer.reportFailure(account.id, error);
      send({
        type: 'done',
        ok: false,
        error: error.message,
        code: error.code || 'internal_error',
        durationMs: Date.now() - started,
      });
    } finally {
      res.end('data: [DONE]\n\n');
    }
  });

  // ── 按需预热（换模型/换账号）────────────────────────────────────────────────
  // Playground 切换模型或账号时前端 fire-and-forget 调用：对指定
  // （账号 × 模型 × 流式）指纹跑一次极小对话，probe 冷启动发生在后台，
  // warm-pool 学习式补位留下热进程，用户随后发送的第一条消息即命中热路径。
  // 门控顺序：账号校验 → 测试环境 → 预热开关 → 冷却 → 池满 → 进行中，
  // 全部通过才登记冷却并启动 probe（被挡下的调用不吃冷却、不花 token）。
  const prewarmRecent = new Map(); // `账号:流式:模型` -> 上次预热时间
  const PREWARM_COOLDOWN_MS = 60_000;
  let prewarmProbeRunning = false;

  router.post('/prewarm-chat', adminGuard, (req, res) => {
    const body = req.body || {};
    const account = accountsStore.getAccount(Number(body.accountId));
    if (!account) return notFound(res, 'Account not found');
    // 测试环境禁止拉真进程（与用量刷新/启动预热共用门控）。
    if (process.env.QODER_PROXY_NO_USAGE_REFRESH === '1') {
      return res.json({ ok: true, skipped: 'test' });
    }
    if (
      !warmPool.isEnabled() ||
      /^(0|false|off)$/i.test(process.env.QODER_WARM_POOL_PREWARM || '1')
    ) {
      return res.json({ ok: true, skipped: 'disabled' });
    }
    const pat = accountsStore.getPat(account.id);
    if (!pat) return fail(res, new AppError(400, 'invalid_request', 'Account has no PAT stored'));

    const model = String(body.model || 'auto');
    const stream = body.stream === true;
    const key = `${account.id}:${stream ? 'stream' : 'non-stream'}:${model}`;
    const now = Date.now();
    if (now - (prewarmRecent.get(key) || 0) < PREWARM_COOLDOWN_MS) {
      return res.json({ ok: true, skipped: 'cooldown' });
    }
    // 池满：补位无名额，probe 冷启动完即弃 = 白花 token。
    const poolStats = warmPool.defaultPool.stats();
    if (poolStats.idle >= poolStats.maxTotal) {
      return res.json({ ok: true, skipped: 'pool-full' });
    }
    if (prewarmProbeRunning) return res.json({ ok: true, skipped: 'busy' });

    prewarmRecent.set(key, now);
    prewarmProbeRunning = true;
    const base = {
      messages: [{ role: 'user', content: '只回复 OK' }],
      model,
      token: pat,
      baseUrl: account.baseUrl || undefined,
      backendType: account.backendType || 'cn',
      timeoutMs: 60000,
    };
    const started = Date.now();
    const run = stream
      ? qoderCli.runQoderCnCliStream({ ...base, onDelta: () => {} })
      : qoderCli.runQoderCnCli(base);
    run
      .then(() => {
        console.log('[chat-prewarm] on-demand probe done', {
          accountId: account.id,
          model,
          stream,
          ms: Date.now() - started,
        });
      })
      .catch((error) => {
        console.log('[chat-prewarm] on-demand probe failed', {
          accountId: account.id,
          model,
          stream,
          ms: Date.now() - started,
          message: error && error.message,
        });
      })
      .finally(() => {
        prewarmProbeRunning = false;
      });
    return res.json({ ok: true, queued: true });
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  router.get('/users', adminGuard, (_req, res) => {
    const users = usersStore.listUsers().map((user) => ({
      ...user,
      keyCount: db
        .prepare('SELECT COUNT(*) AS n FROM api_key WHERE user_id = ? AND revoked_at IS NULL')
        .get(user.id).n,
      grantCount: usersStore.listGrants(user.id).length,
      hasQuota: Boolean(usersStore.getQuota(user.id)),
    }));
    res.json({ ok: true, users });
  });

  router.post('/users', adminGuard, (req, res) => {
    const body = req.body || {};
    const result = usersStore.createUser({
      username: body.username,
      password: body.password,
      role: body.role,
    });
    if (!result.ok) return fail(res, new AppError(400, 'invalid_request', result.error));
    res.json({ ok: true, user: result.user });
  });

  router.patch('/users/:id', adminGuard, (req, res) => {
    const body = req.body || {};
    const before = usersStore.getUserById(req.params.id);
    const result = usersStore.updateUser(req.params.id, {
      role: body.role,
      enabled: body.enabled,
    });
    if (!result.ok) return notFound(res, result.error);
    if (body.password) {
      const pw = usersStore.updateUserPassword(req.params.id, body.password);
      if (!pw.ok) return fail(res, new AppError(400, 'invalid_request', pw.error));
      // 改密吊销该用户其他会话（保留当前请求 token，管理员改自己密码不被踢出）
      if (before?.username) {
        const auth = req.headers.authorization || '';
        const currentToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        db.prepare('DELETE FROM sessions WHERE username = ? AND token != ?').run(before.username, currentToken || '');
      }
    }
    res.json({ ok: true, user: usersStore.getUserById(req.params.id) });
  });

  router.delete('/users/:id', adminGuard, (req, res) => {
    if (!usersStore.deleteUser(req.params.id)) return notFound(res, 'User not found');
    res.json({ ok: true });
  });

  // ── API keys ───────────────────────────────────────────────────────────────
  router.get('/users/:id/keys', adminGuard, (req, res) => {
    res.json({ ok: true, keys: usersStore.listApiKeys(req.params.id) });
  });

  /**
   * 明文密钥返回一次，同时以 AES-256-GCM 加密副本入库（key_enc），
   * 供控制台事后查看。
   */
  router.post('/users/:id/keys', adminGuard, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim() || 'Unnamed key';
    const expiresInDays = Number(body.expiresInDays) || 0;
    const expiresAt =
      expiresInDays > 0
        ? new Date(Date.now() + expiresInDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')
        : null;
    const result = usersStore.createApiKey(req.params.id, name, expiresAt, body.runtime || null);
    if (!result.ok) return notFound(res, result.error);
    res.json({ ok: true, apiKey: result.apiKey });
  });

  /** 查看完整密钥（AES 解密）；旧版仅哈希的密钥不可恢复。 */
  router.get('/keys/:keyId/secret', adminGuard, (req, res) => {
    const result = usersStore.revealApiKey(req.params.keyId);
    if (!result.ok) {
      if (result.error === 'legacy') {
        return res.status(409).json({
          ok: false,
          error: '该密钥创建于旧版本（仅存哈希），无法查看，请吊销后重新生成',
        });
      }
      return notFound(res, 'API key not found');
    }
    res.json({ ok: true, key: result.key });
  });

  /** Replace a key's per-key runtime overrides (all-empty resets to defaults). */
  router.patch('/keys/:keyId', adminGuard, (req, res) => {
    const result = usersStore.updateApiKeyRuntime(req.params.keyId, (req.body || {}).runtime || null);
    if (!result.ok) return notFound(res, result.error);
    res.json({ ok: true });
  });

  /**
   * 调用配置的当前生效默认值（config 表 → 环境变量 → 内置默认），
   * 供生成/编辑密钥表单预填，减少手动输入。
   */
  router.get('/runtime-defaults', adminGuard, (_req, res) => {
    const pick = (key) => {
      try {
        const v = db.getConfig(key);
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      } catch (_) {
        // config 表不可用时退回环境变量
      }
      const e = process.env[key];
      return e && String(e).trim() !== '' ? String(e).trim() : null;
    };
    const num = (key) => {
      const v = pick(key);
      return v === null ? null : Number(v) || null;
    };
    res.json({
      ok: true,
      defaults: {
        baseUrl: pick('QODERCN_BASE_URL') || '',
        reasoningEffort: pick('QODERCN_REASONING_EFFORT'),
        contextWindow: num('QODERCN_CONTEXT_WINDOW'),
        maxOutputTokens: num('QODERCN_MAX_OUTPUT_TOKENS'),
        timeoutMs: num('QODERCN_TIMEOUT_MS') ?? 300000,
      },
    });
  });

  /**
   * 运行状态（系统设置页状态卡）：进程信息 + 当前生效配置。
   * cliBackend 读 process.env —— server.js 启动时已用 config 表同步，
   * 与运行时模块（qoder-engine 等）看到的值一致。
   */
  router.get('/runtime-status', adminGuard, (_req, res) => {
    let version = '';
    try {
      version = require('../package.json').version || '';
    } catch (_) {
      // package.json 不可读时版本留空
    }
    const uptimeSeconds = Math.round(process.uptime());
    const cfg = (key) => {
      try {
        return dbModule.getConfig(key);
      } catch (_) {
        return undefined;
      }
    };
    res.json({
      ok: true,
      status: {
        version,
        nodeVersion: process.version,
        pid: process.pid,
        startedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
        uptimeSeconds,
        port: Number(cfg('PORT') || process.env.PORT || 1300),
        bindHost: cfg('BIND_HOST') || process.env.BIND_HOST || '127.0.0.1',
        cliBackend: (process.env.CLI_BACKEND || 'cn').toLowerCase(),
        warmPool: require('./warm-pool').defaultPool.stats(),
      },
    });
  });

  // ── System logs ─────────────────────────────────────────────────────────────
  /** 内存日志缓冲查询：level/search 过滤，since 增量拉取。 */
  router.get('/logs', adminGuard, (req, res) => {
    const level = ['info', 'warn', 'error'].includes(String(req.query.level))
      ? String(req.query.level)
      : 'all';
    res.json({
      ok: true,
      ...getLogs({
        limit: Number(req.query.limit) || 500,
        level,
        search: String(req.query.search || ''),
        since: Number(req.query.since) || 0,
      }),
    });
  });

  /** 清空内存日志缓冲（仅影响页面查看，不影响控制台真实输出）。 */
  router.delete('/logs', adminGuard, (_req, res) => {
    clearLogs();
    res.json({ ok: true });
  });

  router.delete('/keys/:keyId', adminGuard, (req, res) => {
    const purge = req.query.purge === '1' || req.query.purge === 'true';
    const hadActive = usersStore.hasAnyApiKeys();
    const ok = purge
      ? usersStore.deleteApiKey(req.params.keyId)
      : usersStore.revokeApiKey(req.params.keyId);
    if (!ok) return notFound(res, 'API key not found');
    // 吊销后若网关回到开放模式（已无任何有效 key），必须明确告知
    let warning;
    if (hadActive && !usersStore.hasAnyApiKeys()) {
      warning =
        '这是最后一个有效的 API Key —— /v1 网关已回到开放模式，本机任意进程均可调用。请新建密钥。';
    }
    res.json(warning ? { ok: true, warning } : { ok: true });
  });

  // ── Account grants (N:M) ───────────────────────────────────────────────────
  router.get('/users/:id/grants', adminGuard, (req, res) => {
    if (!usersStore.getUserById(req.params.id)) return notFound(res, 'User not found');
    res.json({ ok: true, accountIds: usersStore.listGrants(req.params.id) });
  });

  /** Replace the user's entire grant set in one transaction. */
  router.put('/users/:id/grants', adminGuard, (req, res) => {
    const user = usersStore.getUserById(req.params.id);
    if (!user) return notFound(res, 'User not found');
    const raw = (req.body || {}).accountIds;
    if (!Array.isArray(raw)) {
      return fail(res, new AppError(400, 'invalid_request', 'accountIds must be an array'));
    }
    const accountIds = [...new Set(raw.map(Number).filter(Number.isFinite))];
    db.transaction(() => {
      db.prepare('DELETE FROM user_account_grant WHERE user_id = ?').run(user.id);
      for (const accountId of accountIds) {
        usersStore.grantAccount(user.id, accountId);
      }
    })();
    res.json({ ok: true, accountIds: usersStore.listGrants(user.id) });
  });

  // ── Quota ──────────────────────────────────────────────────────────────────
  router.get('/users/:id/quota', adminGuard, (req, res) => {
    if (!usersStore.getUserById(req.params.id)) return notFound(res, 'User not found');
    res.json({
      ok: true,
      quota: usersStore.getQuota(req.params.id),
      usage: usageStore.getQuotaUsage(Number(req.params.id)),
    });
  });

  router.put('/users/:id/quota', adminGuard, (req, res) => {
    const user = usersStore.getUserById(req.params.id);
    if (!user) return notFound(res, 'User not found');
    const body = req.body || {};
    const quota = usersStore.setQuota(user.id, {
      dailyTokenLimit: body.dailyTokenLimit ?? null,
      dailyRequestLimit: body.dailyRequestLimit ?? null,
      monthlyTokenLimit: body.monthlyTokenLimit ?? null,
      monthlyRequestLimit: body.monthlyRequestLimit ?? null,
    });
    res.json({ ok: true, quota });
  });

  // ── Usage aggregations ─────────────────────────────────────────────────────
  router.get('/usage/overview', adminGuard, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({
      ok: true,
      today: usageStore.getTodayTotals(),
      byDay: usageStore.getUsageByDay(days),
      byModel: usageStore.getUsageByModel(days),
      byUser: usageStore.getUsageByUser(days),
      byAccount: usageStore.getUsageByAccount(days),
      activeCounts: balancer.getActiveCounts(),
    });
  });

  router.get('/usage/records', adminGuard, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const userId = req.query.userId ? Number(req.query.userId) : null;
    res.json({ ok: true, records: usageStore.getRecentRecords(limit, userId) });
  });

  return router;
}

module.exports = { createAdminApi };
