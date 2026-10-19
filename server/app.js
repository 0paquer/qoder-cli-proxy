require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { anthropicError, openAiError, AppError } = require('./errors');
const {
  adminGuard,
  apiKeyGuard,
  gatewayGuard,
  quotaGuard,
  accountsForPrincipal,
  isAllowedOrigin,
  localOnlyGuard,
} = require('./auth');
const { log } = require('./logger');
const qoderCli = require('./qoder-engine');
const envManager = require('./env-manager');
const db = require('./db');
const balancer = require('./balancer');
const accountsStore = require('./stores/accounts');
const usageStore = require('./stores/usage');
const { DEFAULT_MODEL_ID, MODELS, normalizeModelEntry, buildRateIndex, attachRate } = require('./models');
const {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  estimateAnthropicInputTokens,
  validateAnthropicMessagesRequest,
  writeAnthropicMessageStream,
  writeAnthropicSse,
} = require('./anthropic');
const {
  parseToolCallOutput,
  findStreamingSafePrefixLength,
  generateCallId,
  normalizeOpenAiTools,
  normalizeAnthropicTools,
  formatToolResultForPrompt,
} = require('./tool-parser');
const path = require('path');
const { trackRequest, getUsage, resetUsage, saveUsage, estimateTokens, extractTextFromMessages } = require('./usage');
const { executeToolCall } = require('./tools-executor');
const { createAdminApi } = require('./admin-api');

const MODEL_ID = DEFAULT_MODEL_ID;

// How many different accounts a single CLI invocation may try before giving
// up (rotation excludes the accounts that just failed). Streaming requests
// never rotate: once headers are sent and deltas forwarded, a retry would
// duplicate partial text.
const MAX_ACCOUNT_ATTEMPTS = 3;

// Server-side tool execution is opt-in. Agent clients (OpenCode, Trae, Cline…)
// declare tools they execute themselves in the user's workspace, so the proxy
// must return tool_calls to the client instead of running them locally.
function isServerToolExecutionEnabled() {
  return /^(1|true|yes)$/i.test(process.env.SERVER_TOOL_EXECUTION || '');
}

// ── Login rate limiting (in-memory, per source IP) ───────────────────────────
// Sliding window of failed attempts; too many failures locks the IP out for a
// cooldown period. State lives in memory only — a restart clears it, which is
// acceptable for a local-first gateway.
const LOGIN_WINDOW_MS = 60_000; // Failure count window
const LOGIN_MAX_FAILURES = 5; // Consecutive failures allowed within the window
const LOGIN_LOCK_MS = 15 * 60_000; // Lockout duration after exceeding the limit
const loginFailures = new Map(); // ip → { count, firstAt, lockedUntil }

function loginRateGuard(req, res, next) {
  const ip = req.socket.remoteAddress || 'unknown';
  const entry = loginFailures.get(ip);
  const now = Date.now();
  if (entry && entry.lockedUntil && entry.lockedUntil > now) {
    const seconds = Math.ceil((entry.lockedUntil - now) / 1000);
    return res.status(429).json({ ok: false, error: `Too many attempts, please try again in ${seconds} seconds` });
  }
  // Expired entries naturally reset via countReset below on the next failure.
  return next();
}

function recordLoginFailure(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginFailures.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) {
    entry.lockedUntil = now + LOGIN_LOCK_MS;
    log('login rate limit triggered', { ip, failures: entry.count });
  }
  loginFailures.set(ip, entry);
  // Lazy cleanup to prevent unbounded growth
  if (loginFailures.size > 1000) {
    for (const [key, value] of loginFailures) {
      if (now - value.firstAt > LOGIN_WINDOW_MS && (!value.lockedUntil || value.lockedUntil < now)) {
        loginFailures.delete(key);
      }
    }
  }
}

function clearLoginFailures(req) {
  loginFailures.delete(req.socket.remoteAddress || 'unknown');
}

/** 测试钩子：清空登录限速状态，使限速用例不再必须排在文件最后。 */
function resetLoginRateLimit() {
  loginFailures.clear();
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_messages', 'Each message must be an object.');
    }
    // Allow system, developer, user, assistant, and tool roles for multi-turn tool use
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new AppError(400, 'unsupported_role', `Unsupported message role: ${message.role}`);
    }
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function extractProviderOption(body, key) {
  return firstDefined(
    body.providerOptions?.['qoder-cn-local']?.[key],
    body.providerOptions?.qoder?.[key],
    body.providerOptions?.openai?.[key],
    body.provider_options?.['qoder-cn-local']?.[key],
    body.provider_options?.qoder?.[key],
    body.provider_options?.openai?.[key],
    body.options?.[key],
    body.modelOptions?.[key],
    body.model_options?.[key]
  );
}

function extractRequestOptions(body) {
  return {
    reasoningEffort: firstDefined(
      body.reasoningEffort,
      body.reasoning_effort,
      body.reasoning?.effort,
      body.reasoning?.reasoningEffort,
      body.reasoning?.reasoning_effort,
      extractProviderOption(body, 'reasoningEffort'),
      extractProviderOption(body, 'reasoning_effort')
    ),
    contextWindow: firstDefined(
      body.contextWindow,
      body.context_window,
      extractProviderOption(body, 'contextWindow'),
      extractProviderOption(body, 'context_window')
    ),
    maxOutputTokens: firstDefined(
      body.maxOutputTokens,
      body.max_output_tokens,
      body.max_tokens,
      extractProviderOption(body, 'maxOutputTokens'),
      extractProviderOption(body, 'max_output_tokens'),
      extractProviderOption(body, 'max_tokens')
    ),
  };
}

/**
 * Merge per-key invocation overrides (api_key_runtime) under the
 * request-explicit options. Precedence: request > api key > model route/env
 * (the latter two are applied inside the CLI layer). `timeoutMs` and
 * `baseUrlOverride` have no request-level source, so the key value is used
 * as-is; baseUrlOverride also wins over the checked-in account's baseUrl.
 */
function mergeApiKeyOptions(requestOptions, principal) {
  const cfg = principal?.apiKeyConfig || null;
  return {
    reasoningEffort: firstDefined(requestOptions.reasoningEffort, cfg?.reasoningEffort),
    contextWindow: firstDefined(requestOptions.contextWindow, cfg?.contextWindow),
    maxOutputTokens: firstDefined(requestOptions.maxOutputTokens, cfg?.maxOutputTokens),
    timeoutMs: cfg?.timeoutMs || undefined,
    baseUrlOverride: cfg?.baseUrl || undefined,
  };
}

function createChatCompletion({ model, content, parsedOutput, usage, thinking }) {
  const usageTokens = {
    prompt_tokens: Math.max(0, Math.trunc(Number(usage?.inputTokens) || 0)),
    completion_tokens: Math.max(0, Math.trunc(Number(usage?.outputTokens) || 0)),
  };
  usageTokens.total_tokens = usageTokens.prompt_tokens + usageTokens.completion_tokens;
  // OpenAI 生态约定（DeepSeek 风格）：思考内容放 message.reasoning_content。
  const reasoningContent = thinking || undefined;
  // If the CLI output was parsed as tool calls, return OpenAI tool_calls format
  if (parsedOutput && parsedOutput.type === 'tool_calls') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: parsedOutput.prefixText || null,
            reasoning_content: reasoningContent,
            tool_calls: parsedOutput.toolCalls.map((call) => ({
              id: generateCallId('call_'),
              type: 'function',
              function: {
                name: call.name,
                // OpenAI spec: arguments is a JSON string, not a parsed object
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: usageTokens,
    };
  }

  // Regular text response
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          reasoning_content: reasoningContent,
        },
        finish_reason: 'stop',
      },
    ],
    usage: usageTokens,
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeChatCompletionStream(res, { model, content, parsedOutput, thinking }) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const isToolCalls = parsedOutput && parsedOutput.type === 'tool_calls';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      },
    ],
  });

  if (thinking) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: thinking },
          finish_reason: null,
        },
      ],
    });
  }

  if (isToolCalls) {
    if (parsedOutput.prefixText) {
      writeSse(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: parsedOutput.prefixText },
            finish_reason: null,
          },
        ],
      });
    }
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: parsedOutput.toolCalls.map((call, index) => ({
              index,
              id: generateCallId('call_'),
              type: 'function',
              function: {
                name: call.name,
                // OpenAI spec: arguments is a JSON string, not a parsed object
                arguments: JSON.stringify(call.arguments || {}),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    });
  } else if (content) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    });
  }

  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: isToolCalls ? 'tool_calls' : 'stop',
      },
    ],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── Multi-account gateway plumbing ────────────────────────────────────────────

/**
 * One usage_record per HTTP request. Real token counts accumulate from the
 * CLI's `type: "result"` usage reports across all rounds; when the CLI
 * reported nothing the record falls back to a chars/3 estimate.
 */
function createUsageTracker({ userId, apiKeyId, model, stream, inputText }) {
  const state = {
    accountId: null,
    inputTokens: 0,
    outputTokens: 0,
    sawActual: false,
    done: false,
  };

  return {
    onUsage(usage) {
      if (!usage || typeof usage !== 'object') return;
      state.inputTokens += Number(usage.inputTokens) || 0;
      state.outputTokens += Number(usage.outputTokens) || 0;
      state.sawActual = true;
    },
    setAccount(accountId) {
      if (accountId != null) state.accountId = accountId;
    },
    /** 当前累计用量（非流式响应回填 usage 用）：优先真实值，缺失时与 finish 同口径估算。 */
    snapshot(outputText = '') {
      return {
        inputTokens: state.sawActual ? state.inputTokens : estimateTokens(inputText),
        outputTokens: state.sawActual ? state.outputTokens : estimateTokens(outputText),
        source: state.sawActual ? 'actual' : 'estimated',
      };
    },
    finish({ status = 'success', errorCode = null, outputText = '', durationMs = null } = {}) {
      if (state.done) return;
      state.done = true;
      const inputTokens = state.sawActual
        ? state.inputTokens
        : estimateTokens(inputText);
      const outputTokens = state.sawActual
        ? state.outputTokens
        : estimateTokens(outputText);
      try {
        usageStore.recordUsage({
          userId,
          apiKeyId,
          accountId: state.accountId,
          model,
          inputTokens,
          outputTokens,
          tokenSource: state.sawActual ? 'actual' : 'estimated',
          status,
          errorCode,
          durationMs,
          stream,
        });
      } catch (error) {
        // Usage accounting must never break the response path.
        log('usage record failed', { message: error.message });
      }
    },
  };
}

/**
 * Run one CLI invocation with multi-account support:
 *   - Accounts are restricted to the principal's ACL (admins: all accounts).
 *   - A failure rotates to the next candidate (exclusion list, capped at
 *     MAX_ACCOUNT_ATTEMPTS) and feeds the balancer's failure backoff.
 *   - Success clears the account's failure streak.
 *   - With an empty registry the CLI runs in legacy env-token mode.
 * `runFn` receives {token, baseUrl, backendType, onUsage} and must be a
 * call through qoderCli.* so test stubs keep working.
 */
async function invokeCliWithAccounts(principal, tracker, opts, runFn) {
  // Legacy fallback only when the registry itself is empty — a user with no
  // grants must never fall through to the env token.
  const registryHasAccounts = accountsStore.listAccounts().some((account) => account.enabled);
  const allowedIds = accountsForPrincipal(principal)
    .filter((account) => account.enabled)
    .map((account) => account.id);

  if (!registryHasAccounts) {
    return runFn({}); // legacy single-account mode via env token
  }
  if (!allowedIds.length) {
    throw new AppError(
      403,
      'no_account_granted',
      'No Qoder account is granted to this user. Ask an administrator for access.'
    );
  }

  const backendType = opts.backendType || 'cn';
  const maxAttempts = opts.rotate
    ? Math.min(MAX_ACCOUNT_ATTEMPTS, allowedIds.length)
    : 1;
  const excludeIds = [];
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = balancer.checkoutAccount({ backendType, excludeIds, allowedIds });
    if (!account) break; // everything busy or cooling down
    excludeIds.push(account.id);
    tracker.setAccount(account.id);

    try {
      const pat = accountsStore.getPat(account.id);
      if (!pat) {
        // 凭据缺失/解密失败：绝不能回落到 env 全局 token（会把成功与用量记到该账号，掩盖配置错误）
        const patError = new AppError(
          503,
          'account_pat_missing',
          `Account "${account.name || account.id}" has no readable PAT. Update it in account management.`
        );
        balancer.reportFailure(account.id, patError);
        lastError = patError;
        log('account attempt failed', {
          account_id: account.id,
          attempt: attempt + 1,
          code: 'account_pat_missing',
          message: patError.message,
        });
        continue; // finally 负责 release，交给下一个候选账号
      }
      const result = await runFn({
        token: pat,
        baseUrl: account.baseUrl || undefined,
        backendType: account.backendType || backendType,
        onUsage: (usage) => tracker.onUsage(usage),
      });
      balancer.reportSuccess(account.id);
      return result;
    } catch (error) {
      if (error && error.code === 'request_cancelled') throw error;
      lastError = error;
      balancer.reportFailure(account.id, error);
      log('account attempt failed', {
        account_id: account.id,
        attempt: attempt + 1,
        code: error.code || 'internal_error',
        message: error.message,
      });
    } finally {
      balancer.releaseAccount(account.id);
    }
  }

  throw (
    lastError ||
    new AppError(
      503,
      'no_available_account',
      'No Qoder account is currently available (all busy or cooling down).'
    )
  );
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Reject foreign Hosts and cross-origin browser requests before anything
  // else, so a disallowed origin cannot even complete a CORS preflight.
  app.use(localOnlyGuard);
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: false,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // HTTP 访问日志：/admin 与 /v1 请求记入日志缓冲（finish 时计时，含 SSE 真实耗时）。
  // 4xx warn / 5xx error 便于在系统日志页过滤排障；静态 UI（/ui）请求量大且
  // 排障价值低，跳过以免刷爆环形缓冲。
  app.use((req, res, next) => {
    if (!req.path.startsWith('/admin') && !req.path.startsWith('/v1')) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const entry = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      };
      if (res.statusCode >= 500) console.error('http request', entry);
      else if (res.statusCode >= 400) console.warn('http request', entry);
      else log('http request', entry);
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // 登录接口
  app.post('/admin/login', localOnlyGuard, loginRateGuard, (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.json({ ok: false, error: '用户名和密码不能为空' });
    }

    if (db.verifyAdminUser(username, password)) {
      clearLoginFailures(req);
      const token = db.createSession(username, 24); // 24小时有效期
      // 仍在使用初始默认密码时告知前端弹「首登改密」弹窗；
      // 未改密前 adminGuard 会在 API 层强制拦截（403 default_password）
      res.json({ ok: true, token, mustChangePassword: db.isDefaultAdminPassword(username) });
    } else {
      recordLoginFailure(req);
      res.json({ ok: false, error: '用户名或密码错误' });
    }
  });

  // 验证 token
  app.get('/admin/verify-token', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.json({ ok: false });
    }
    
    const token = auth.slice(7).trim();
    const session = db.verifySession(token);
    
    if (session) {
      res.json({ ok: true, username: session.username });
    } else {
      res.json({ ok: false });
    }
  });

  // 退出登录
  app.post('/admin/logout', (req, res) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      db.deleteSession(token);
    }
    res.json({ ok: true });
  });

  // 修改密码
  app.post('/admin/change-password', adminGuard, (req, res) => {
    const { username, newPassword } = req.body || {};
    
    if (!username || !newPassword) {
      return openAiError(res, new AppError(400, 'invalid_request', '用户名和新密码不能为空'));
    }

    // 不允许改回初始默认密码，否则「首登改密」强制会被无限绕过
    if (newPassword === db.DEFAULT_ADMIN_PASSWORD) {
      return openAiError(
        res,
        new AppError(400, 'invalid_request', '新密码不能与初始默认密码相同，请设置其他密码')
      );
    }

    // 吊销该用户其他会话；保留当前 token，操作者改密后无需重新登录
    const auth = req.headers.authorization;
    const currentToken = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (db.changeAdminPassword(username, newPassword, currentToken)) {
      res.json({ ok: true, message: '密码修改成功' });
    } else {
      openAiError(res, new AppError(404, 'not_found', '用户不存在'));
    }
  });

  // 管理员/用户列表已迁移至 admin-api.js（GET /admin/users，含角色与密钥计数）。

  // 未认证的健康信息端点：只暴露服务身份，不返回 vpc_endpoint / 端口 /
  // bind_host / PAT 配置等部署细节（原实现还会为此跑一次 CLI 查询拖慢响应）。
  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      name: 'qoder-proxy',
      mode: 'clean',
      cli_backend: qoderCli.getCliBackend().name,
    });
  });

  // /v1 is the multi-user gateway: resolve the presented credential (qk-* key,
  // admin session, or legacy PROXY_API_KEY) and enforce per-user quotas. When
  // no credential infrastructure exists at all the gateway stays open so
  // existing single-user setups keep working.
  app.use(['/v1', '/v1/v1'], gatewayGuard, quotaGuard);
  // /usage 与 /v1 同策略：一旦存在凭据设施（PROXY_API_KEY 或任何 API Key）即要求认证，
  // 同时校验 session 对应用户 enabled 状态（apiKeyGuard 未设 PROXY_API_KEY 时会裸放行）
  app.use('/usage', gatewayGuard);

  // Multi-account admin API (accounts / users / keys / grants / usage).
  app.use('/admin', createAdminApi());

  // 按账号缓存模型目录（SDK daemon getModels，自带 credit 倍率）：
  // 成功 60s / 失败 15s，避免每个请求都起 daemon 查询。
  const accountModelsCache = new Map();
  const loadAccountModelsCached = async (account) => {
    const hit = accountModelsCache.get(account.id);
    if (hit && Date.now() - hit.at < (hit.ok ? 60000 : 15000)) return hit.ok ? hit.models : null;
    try {
      const pat = accountsStore.getPat(account.id);
      if (!pat) return null;
      const result = await qoderCli.loadModelCatalog({
        token: pat,
        baseUrl: account.baseUrl || undefined,
        backendType: account.backendType || 'cn',
      });
      const ok = result.ok && Array.isArray(result.models) && result.models.length > 0;
      accountModelsCache.set(account.id, { at: Date.now(), ok, models: ok ? result.models : [] });
      return ok ? result.models : null;
    } catch (_) {
      return null;
    }
  };

  app.get(['/v1/models', '/models', '/v1/v1/models'], async (req, res) => {
    // 带有效密钥/会话时：返回该 principal 可用账号的真实模型列表（并集去重）。
    const principal = req.principal;
    if (principal && principal.type !== 'anonymous' && principal.userId != null) {
      const accounts = accountsForPrincipal(principal).filter((a) => Boolean(a.enabled));
      if (accounts.length > 0) {
        const settled = await Promise.allSettled(accounts.map(loadAccountModelsCached));
        // 倍率索引：模型目录自带 rate，先并入索引再构建条目（目录并集，尽力而为）。
        const rateIndex = new Map();
        for (const item of settled) {
          if (item.status !== 'fulfilled' || !Array.isArray(item.value)) continue;
          for (const [k, v] of buildRateIndex(item.value)) if (!rateIndex.has(k)) rateIndex.set(k, v);
        }
        const seen = new Set();
        const data = [];
        for (const item of settled) {
          if (item.status !== 'fulfilled' || !Array.isArray(item.value)) continue;
          for (const m of item.value) {
            const norm = normalizeModelEntry(m);
            if (!norm || seen.has(norm.id)) continue;
            seen.add(norm.id);
            const raw = norm.raw || {};
            const entry = attachRate({ id: norm.id, name: raw.name || raw.displayName || norm.id }, rateIndex);
            data.push({
              id: entry.id,
              object: 'model',
              created: 0,
              owned_by: 'qodercn',
              name: entry.name,
              capabilities: { reasoning: Boolean(raw.reasoning || raw.isReasoning) },
              ...(entry.rate != null ? { rate: entry.rate } : {}),
              ...(entry.isFree ? { is_free: true } : {}),
              ...(raw.effortAlias ? { effort_alias: true } : {}),
            });
          }
        }
        if (data.length > 0) {
          return res.json({ object: 'list', data, source: 'account' });
        }
      }
    }
    // 未认证、匿名或账号模型查询失败：静态兜底，保持旧行为。
    return res.json({
      object: 'list',
      data: MODELS.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'qodercn',
        name: model.name,
        capabilities: {
          reasoning: model.reasoning || false,
        },
        ...(model.effortAlias ? { effort_alias: true } : {}),
      })),
    });
  });

  app.post(['/v1/chat/completions', '/chat/completions', '/v1/v1/chat/completions'], async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    // 与 admin-api 的 test-chat/stream 同口径：'aborted' 已废弃且部分断连场景不触发，
    // req 'close' 在请求体读完即会触发（非断连）——必须用 res + writableEnded 判真断连。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    // Created before the try so the catch block can always record the outcome.
    const tracker = createUsageTracker({
      userId: req.principal?.userId ?? null,
      apiKeyId: req.principal?.apiKeyId ?? null,
      model: req.body?.model || MODEL_ID,
      stream: Boolean(req.body?.stream),
      inputText: extractTextFromMessages(req.body?.messages),
    });

    try {
      validateChatRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = mergeApiKeyOptions(extractRequestOptions(req.body), req.principal);
      const tools = Array.isArray(req.body.tools) ? req.body.tools : null;
      const normalizedTools = tools ? normalizeOpenAiTools(tools) : null;
      log('chat request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: normalizedTools ? normalizedTools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      // True streaming: stream-json mode, real-time SSE forwarding.
      // Only when no tools are declared — with tools the model may emit a
      // tool-call JSON block that must be parsed and returned as structured
      // tool_calls, so those requests go through the buffered path below.
      if (req.body.stream && !normalizedTools) {
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        // Send role chunk first
        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        let streamedText = '';
        try {
          await invokeCliWithAccounts(req.principal, tracker, { backendType: 'cn' }, (cliOpts) =>
            qoderCli.runQoderCnCliStream({
              messages: req.body.messages,
              model,
              tools: normalizedTools,
              reasoningEffort: requestOptions.reasoningEffort,
              contextWindow: requestOptions.contextWindow,
              maxOutputTokens: requestOptions.maxOutputTokens,
              signal: controller.signal,
              ...cliOpts,
              // Per-key overrides win over the checked-in account's baseUrl.
              baseUrl: requestOptions.baseUrlOverride || cliOpts.baseUrl,
              timeoutMs: requestOptions.timeoutMs,
              onDelta: (delta) => {
                streamedText += delta;
                writeSse(res, {
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                });
              },
              // 思考增量直通 SSE（DeepSeek 风格 reasoning_content）
              onThinking: (thinking) => {
                writeSse(res, {
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { reasoning_content: thinking }, finish_reason: null }],
                });
              },
            })
          );
        } catch (streamError) {
          log('chat stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          tracker.finish({
            status: 'error',
            errorCode: streamError.code || 'internal_error',
            durationMs: Date.now() - started,
          });
          // Headers are already sent — surface the error as an SSE event so
          // clients render a failure instead of a silent empty message.
          if (!res.writableEnded) {
            try {
              writeSse(res, {
                error: {
                  message: streamError.message || 'Upstream request failed.',
                  type: 'server_error',
                  code: streamError.code || 'internal_error',
                },
              });
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (_) { /* ignore */ }
          }
          return;
        }

        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
        log('chat stream completed', { duration_ms: Date.now() - started });
        tracker.finish({ outputText: streamedText, durationMs: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: '',
          isError: false,
        });
        return;
      }

      // True streaming with tools declared: the text part is forwarded live
      // through a safety gate that withholds any tail which could still grow
      // into the tool-call JSON block; once the stream completes, the full
      // text is parsed and tool calls are appended as structured blocks.
      // (Skipped when server-side tool execution is enabled — the multi-round
      // tool loop below stays buffered.)
      if (
        req.body.stream &&
        normalizedTools &&
        normalizedTools.length &&
        !isServerToolExecutionEnabled()
      ) {
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        let fullText = '';
        let forwardedLength = 0;
        const writeContentChunk = (content) => {
          if (!content) return;
          writeSse(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          });
        };

        try {
          await invokeCliWithAccounts(req.principal, tracker, { backendType: 'cn' }, (cliOpts) =>
            qoderCli.runQoderCnCliStream({
              messages: req.body.messages,
              model,
              tools: normalizedTools,
              reasoningEffort: requestOptions.reasoningEffort,
              contextWindow: requestOptions.contextWindow,
              maxOutputTokens: requestOptions.maxOutputTokens,
              signal: controller.signal,
              ...cliOpts,
              // Per-key overrides win over the checked-in account's baseUrl.
              baseUrl: requestOptions.baseUrlOverride || cliOpts.baseUrl,
              timeoutMs: requestOptions.timeoutMs,
              onDelta: (delta) => {
                fullText += delta;
                const safeLength = findStreamingSafePrefixLength(fullText);
                if (safeLength > forwardedLength) {
                  writeContentChunk(fullText.slice(forwardedLength, safeLength));
                  forwardedLength = safeLength;
                }
              },
              // 思考增量不参与 tool-call 安全门（思考不会长成工具调用 JSON），
              // 直接以 reasoning_content 转发。
              onThinking: (thinking) => {
                writeSse(res, {
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { reasoning_content: thinking }, finish_reason: null }],
                });
              },
            })
          );
        } catch (streamError) {
          log('chat stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          tracker.finish({
            status: 'error',
            errorCode: streamError.code || 'internal_error',
            durationMs: Date.now() - started,
          });
          // Headers are already sent — surface the error as an SSE event so
          // clients render a failure instead of a silent empty message.
          if (!res.writableEnded) {
            try {
              writeSse(res, {
                error: {
                  message: streamError.message || 'Upstream request failed.',
                  type: 'server_error',
                  code: streamError.code || 'internal_error',
                },
              });
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (_) { /* ignore */ }
          }
          return;
        }

        const parsedOutput = parseToolCallOutput(fullText);
        const isToolCalls = parsedOutput.type === 'tool_calls';
        if (isToolCalls) {
          log('chat tool calls detected', {
            tool_count: parsedOutput.toolCalls.length,
            tools: parsedOutput.toolCalls.map((t) => t.name),
            streamed: true,
          });
        }

        // Flush whichever text belongs to the final answer but was still held
        // back by the gate: the prefix before the tool-call block, or the
        // remaining tail of a plain-text reply. The gate guarantees forwarded
        // text is always a prefix of the final text — never the tool payload.
        const expectedText =
          isToolCalls && parsedOutput.matchStart >= 0
            ? fullText.slice(0, parsedOutput.matchStart)
            : fullText;
        if (
          expectedText.length > forwardedLength &&
          expectedText.startsWith(fullText.slice(0, forwardedLength))
        ) {
          writeContentChunk(expectedText.slice(forwardedLength));
        } else if (expectedText.length > forwardedLength) {
          log('warning: streamed prefix diverged from final text', { model });
        }

        if (isToolCalls) {
          writeSse(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: parsedOutput.toolCalls.map((call, index) => ({
                    index,
                    id: generateCallId('call_'),
                    type: 'function',
                    function: {
                      name: call.name,
                      // OpenAI spec: arguments is a JSON string, not a parsed object
                      arguments: JSON.stringify(call.arguments || {}),
                    },
                  })),
                },
                finish_reason: null,
              },
            ],
          });
        }

        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: isToolCalls ? 'tool_calls' : 'stop',
            },
          ],
        });
        res.write('data: [DONE]\n\n');
        res.end();
        log('chat stream completed', {
          duration_ms: Date.now() - started,
          with_tools: true,
          tool_calls: isToolCalls ? parsedOutput.toolCalls.length : 0,
        });
        tracker.finish({ outputText: fullText, durationMs: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: fullText,
          isError: false,
        });
        return;
      }

      // Non-streaming path (or tool calls with stream=true → downgraded)
      // Build working messages for potential tool-call loops
      let workingMessages = [...req.body.messages];
      let finalContent = '';
      let finalThinking = '';
      let finalParsedOutput = null;
      let toolCallDepth = 0;
      const MAX_TOOL_CALL_DEPTH = 10;

      while (toolCallDepth < MAX_TOOL_CALL_DEPTH) {
        const content = await invokeCliWithAccounts(
          req.principal,
          tracker,
          { backendType: 'cn', rotate: true },
          (cliOpts) =>
            qoderCli.runQoderCnCli({
              messages: workingMessages,
              model,
              tools: normalizedTools,
              reasoningEffort: requestOptions.reasoningEffort,
              contextWindow: requestOptions.contextWindow,
              maxOutputTokens: requestOptions.maxOutputTokens,
              signal: controller.signal,
              ...cliOpts,
              // Per-key overrides win over the checked-in account's baseUrl.
              baseUrl: requestOptions.baseUrlOverride || cliOpts.baseUrl,
              timeoutMs: requestOptions.timeoutMs,
              // 非流式：思考全文在会话结束时一次性回调（多轮取最后一轮）
              onThinking: (thinking) => {
                finalThinking = thinking;
              },
            })
        );

        finalContent = content;

        // Parse the output for tool calls if tools were provided
        let parsedOutput = null;
        if (normalizedTools) {
          parsedOutput = parseToolCallOutput(content);
          if (parsedOutput && parsedOutput.type === 'tool_calls') {
            log('chat tool calls detected', {
              tool_count: parsedOutput.toolCalls.length,
              tools: parsedOutput.toolCalls.map((t) => t.name),
            });
          } else {
            log('chat no tool calls detected', { response_type: parsedOutput?.type || 'text' });
          }
        }

        finalParsedOutput = parsedOutput;

        // If no tool calls, we're done
        if (!parsedOutput || parsedOutput.type !== 'tool_calls') {
          break;
        }

        // Default: hand tool_calls back to the client, which executes tools
        // in its own workspace. Server-side execution only when opted in.
        if (!isServerToolExecutionEnabled()) {
          break;
        }

        // Execute tool calls and build tool result messages
        const toolResults = [];
        const assistantToolCalls = [];

        for (const toolCall of parsedOutput.toolCalls) {
          const callId = generateCallId('call_');
          assistantToolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments || {}),
            },
          });

          log('executing tool', { name: toolCall.name, arguments: toolCall.arguments });
          const result = await executeToolCall(toolCall);
          log('tool result', { name: toolCall.name, result });

          toolResults.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
        }

        // Add assistant message with tool_calls
        workingMessages.push({
          role: 'assistant',
          content: parsedOutput.prefixText || null,
          tool_calls: assistantToolCalls,
        });

        // Add tool result messages
        workingMessages.push(...toolResults);

        toolCallDepth++;
      }

      if (toolCallDepth >= MAX_TOOL_CALL_DEPTH) {
        log('warning: max tool call depth reached', { depth: MAX_TOOL_CALL_DEPTH });
      }

      if (req.body.stream) {
        // Buffered request (tools declared) — emit the parsed result as a
        // proper SSE stream, including delta.tool_calls when applicable.
        writeChatCompletionStream(res, { model, content: finalContent, parsedOutput: finalParsedOutput, thinking: finalThinking });
      } else {
        res.json(
          createChatCompletion({
            model,
            content: finalContent,
            parsedOutput: finalParsedOutput,
            usage: tracker.snapshot(finalContent || ''),
            thinking: finalThinking,
          }),
        );
      }
      log('chat request completed', { duration_ms: Date.now() - started, tool_call_depth: toolCallDepth });
      tracker.finish({ outputText: finalContent || '', durationMs: Date.now() - started });
      trackRequest({
        model,
        inputText: extractTextFromMessages(req.body.messages),
        outputText: finalContent || '',
        isError: false,
      });
    } catch (error) {
      log('chat request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      tracker.finish({
        status: 'error',
        errorCode: error.code || 'internal_error',
        durationMs: Date.now() - started,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
      });
      if (!res.headersSent && !res.writableEnded) openAiError(res, error);
    }
  });

  app.post(['/v1/messages', '/messages', '/v1/v1/messages'], async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    // 同 /v1/chat/completions：res close + writableEnded 判真断连（req 'aborted' 已废弃）
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    // Created before the try so the catch block can always record the outcome.
    const tracker = createUsageTracker({
      userId: req.principal?.userId ?? null,
      apiKeyId: req.principal?.apiKeyId ?? null,
      model: req.body?.model || MODEL_ID,
      stream: Boolean(req.body?.stream),
      inputText: extractTextFromMessages(req.body?.messages),
    });

    try {
      validateAnthropicMessagesRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = mergeApiKeyOptions(extractRequestOptions(req.body), req.principal);
      const { messages, tools } = anthropicToOpenAiMessages(req.body);
      log('anthropic message request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: Array.isArray(req.body.tools) ? req.body.tools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      // True streaming: stream-json mode, real-time SSE forwarding.
      // Only when no tools are declared — with tools the model may emit a
      // tool-call JSON block that must be parsed and returned as structured
      // tool_use blocks, so those requests go through the buffered path below.
      if (req.body.stream && !(tools && tools.length)) {
        const msgId = `msg_${Date.now()}`;

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        writeAnthropicSse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        // Anthropic 流式规范：thinking 块必须在 text 块之前，text 的 index
        // 取决于是否出现过 thinking —— 因此块全部惰性开启、index 动态分配。
        let nextBlockIndex = 0;
        let thinkingOpen = false;
        let thinkingIndex = -1;
        let textOpen = false;
        let textIndex = -1;
        const openThinkingBlock = () => {
          if (thinkingOpen) return;
          thinkingOpen = true;
          thinkingIndex = nextBlockIndex++;
          writeAnthropicSse(res, 'content_block_start', {
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: { type: 'thinking', thinking: '' },
          });
        };
        const openTextBlock = () => {
          if (textOpen) return;
          // 思考先于正文：首个正文增量到达时关闭 thinking 块。
          if (thinkingOpen) {
            thinkingOpen = false;
            writeAnthropicSse(res, 'content_block_stop', {
              type: 'content_block_stop',
              index: thinkingIndex,
            });
          }
          textOpen = true;
          textIndex = nextBlockIndex++;
          writeAnthropicSse(res, 'content_block_start', {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          });
        };

        let streamedText = '';
        try {
          await invokeCliWithAccounts(req.principal, tracker, { backendType: 'cn' }, (cliOpts) =>
            qoderCli.runQoderCnCliStream({
              messages,
              model,
              tools,
              reasoningEffort: requestOptions.reasoningEffort,
              contextWindow: requestOptions.contextWindow,
              maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
              signal: controller.signal,
              ...cliOpts,
              // Per-key overrides win over the checked-in account's baseUrl.
              baseUrl: requestOptions.baseUrlOverride || cliOpts.baseUrl,
              timeoutMs: requestOptions.timeoutMs,
              onDelta: (delta) => {
                streamedText += delta;
                openTextBlock();
                writeAnthropicSse(res, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: textIndex,
                  delta: { type: 'text_delta', text: delta },
                });
              },
              onThinking: (thinking) => {
                openThinkingBlock();
                writeAnthropicSse(res, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: thinkingIndex,
                  delta: { type: 'thinking_delta', thinking },
                });
              },
            })
          );
        } catch (streamError) {
          log('anthropic stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          tracker.finish({
            status: 'error',
            errorCode: streamError.code || 'internal_error',
            durationMs: Date.now() - started,
          });
          // Headers are already sent — surface the error as an SSE error
          // event so clients render a failure instead of an empty message.
          if (!res.writableEnded) {
            try {
              writeAnthropicSse(res, 'error', {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: streamError.message || 'Upstream request failed.',
                },
              });
              res.end();
            } catch (_) { /* ignore */ }
          }
          return;
        }

        // 收尾：仍开启的块补 stop；全程无任何内容时发一个空 text 块，
        // 保持「流里始终有 content block」的既有行为。
        if (!nextBlockIndex) {
          openTextBlock();
        }
        if (thinkingOpen) {
          writeAnthropicSse(res, 'content_block_stop', {
            type: 'content_block_stop',
            index: thinkingIndex,
          });
        }
        if (textOpen) {
          writeAnthropicSse(res, 'content_block_stop', {
            type: 'content_block_stop',
            index: textIndex,
          });
        }
        writeAnthropicSse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        log('anthropic stream completed', { duration_ms: Date.now() - started });
        tracker.finish({ outputText: streamedText, durationMs: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: '',
          isError: false,
        });
        return;
      }

      // True streaming with tools declared: same gated approach as the
      // OpenAI branch — text streams live, the tool-call JSON tail is held
      // back and appended as structured tool_use blocks after the stream
      // completes. The text block only opens when text actually arrives, so
      // a pure tool-call reply carries no empty text block.
      if (
        req.body.stream &&
        tools &&
        tools.length &&
        !isServerToolExecutionEnabled()
      ) {
        const msgId = `msg_${Date.now()}`;

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        writeAnthropicSse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        let fullText = '';
        let forwardedLength = 0;
        let textBlockStarted = false;
        // thinking 块在 text 之前（Anthropic 规范），text index 动态顺延。
        let nextBlockIndex = 0;
        let thinkingOpen = false;
        let thinkingIndex = -1;
        const writeTextDelta = (text) => {
          if (!text) return;
          if (!textBlockStarted) {
            textBlockStarted = true;
            if (thinkingOpen) {
              thinkingOpen = false;
              writeAnthropicSse(res, 'content_block_stop', {
                type: 'content_block_stop',
                index: thinkingIndex,
              });
            }
            writeAnthropicSse(res, 'content_block_start', {
              type: 'content_block_start',
              index: nextBlockIndex++,
              content_block: { type: 'text', text: '' },
            });
          }
          writeAnthropicSse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: nextBlockIndex - 1,
            delta: { type: 'text_delta', text },
          });
        };
        const writeThinkingDelta = (thinking) => {
          if (!thinking) return;
          if (!thinkingOpen) {
            thinkingOpen = true;
            thinkingIndex = nextBlockIndex++;
            writeAnthropicSse(res, 'content_block_start', {
              type: 'content_block_start',
              index: thinkingIndex,
              content_block: { type: 'thinking', thinking: '' },
            });
          }
          writeAnthropicSse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: thinkingIndex,
            delta: { type: 'thinking_delta', thinking },
          });
        };

        try {
          await invokeCliWithAccounts(req.principal, tracker, { backendType: 'cn' }, (cliOpts) =>
            qoderCli.runQoderCnCliStream({
              messages,
              model,
              tools,
              reasoningEffort: requestOptions.reasoningEffort,
              contextWindow: requestOptions.contextWindow,
              maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
              signal: controller.signal,
              ...cliOpts,
              // Per-key overrides win over the checked-in account's baseUrl.
              baseUrl: requestOptions.baseUrlOverride || cliOpts.baseUrl,
              timeoutMs: requestOptions.timeoutMs,
              onDelta: (delta) => {
                fullText += delta;
                const safeLength = findStreamingSafePrefixLength(fullText);
                if (safeLength > forwardedLength) {
                  writeTextDelta(fullText.slice(forwardedLength, safeLength));
                  forwardedLength = safeLength;
                }
              },
              onThinking: writeThinkingDelta,
            })
          );
        } catch (streamError) {
          log('anthropic stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          tracker.finish({
            status: 'error',
            errorCode: streamError.code || 'internal_error',
            durationMs: Date.now() - started,
          });
          // Headers are already sent — surface the error as an SSE error
          // event so clients render a failure instead of an empty message.
          if (!res.writableEnded) {
            try {
              writeAnthropicSse(res, 'error', {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: streamError.message || 'Upstream request failed.',
                },
              });
              res.end();
            } catch (_) { /* ignore */ }
          }
          return;
        }

        const parsedOutput = parseToolCallOutput(fullText);
        const isToolCalls = parsedOutput.type === 'tool_calls';
        if (isToolCalls) {
          log('anthropic tool calls detected', {
            tool_count: parsedOutput.toolCalls.length,
            tools: parsedOutput.toolCalls.map((t) => t.name),
            streamed: true,
          });
        }

        // Flush the text part of the final answer still held by the gate (see
        // the OpenAI branch for the prefix invariant).
        const expectedText =
          isToolCalls && parsedOutput.matchStart >= 0
            ? fullText.slice(0, parsedOutput.matchStart)
            : fullText;
        if (
          expectedText.length > forwardedLength &&
          expectedText.startsWith(fullText.slice(0, forwardedLength))
        ) {
          writeTextDelta(expectedText.slice(forwardedLength));
        } else if (expectedText.length > forwardedLength) {
          log('warning: streamed prefix diverged from final text', { model });
        }

        let blockIndex = nextBlockIndex;
        if (textBlockStarted) {
          writeAnthropicSse(res, 'content_block_stop', {
            type: 'content_block_stop',
            index: nextBlockIndex - 1,
          });
        }
        if (thinkingOpen) {
          writeAnthropicSse(res, 'content_block_stop', {
            type: 'content_block_stop',
            index: thinkingIndex,
          });
        }

        if (isToolCalls) {
          for (const call of parsedOutput.toolCalls) {
            writeAnthropicSse(res, 'content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: generateCallId('toolu_'),
                name: call.name,
                input: {},
              },
            });
            writeAnthropicSse(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                // Anthropic streams tool input as partial JSON text
                partial_json: JSON.stringify(call.arguments || {}),
              },
            });
            writeAnthropicSse(res, 'content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            });
            blockIndex += 1;
          }
        }

        writeAnthropicSse(res, 'message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: isToolCalls ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: { output_tokens: 0 },
        });
        writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        log('anthropic stream completed', {
          duration_ms: Date.now() - started,
          with_tools: true,
          tool_calls: isToolCalls ? parsedOutput.toolCalls.length : 0,
        });
        tracker.finish({ outputText: fullText, durationMs: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: fullText,
          isError: false,
        });
        return;
      }

      // Non-streaming path (or tool calls with stream=true → downgraded)
      // Build working messages for potential tool-call loops
      let workingMessagesAnthropic = [...messages];
      let anthropicContent = '';
      let anthropicThinking = '';
      let anthropicParsedOutput = null;
      let anthropicToolDepth = 0;
      const MAX_ANTHROPIC_TOOL_DEPTH = 10;

      while (anthropicToolDepth < MAX_ANTHROPIC_TOOL_DEPTH) {
        const content = await invokeCliWithAccounts(
          req.principal,
          tracker,
          { backendType: 'cn', rotate: true },
          (cliOpts) =>
            qoderCli.runQoderCnCli({
              messages: workingMessagesAnthropic,
              model,
              tools,
              reasoningEffort: requestOptions.reasoningEffort,
              contextWindow: requestOptions.contextWindow,
              maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
              signal: controller.signal,
              ...cliOpts,
              // Per-key overrides win over the checked-in account's baseUrl.
              baseUrl: requestOptions.baseUrlOverride || cliOpts.baseUrl,
              timeoutMs: requestOptions.timeoutMs,
              // 非流式：思考全文在会话结束时一次性回调（多轮取最后一轮）
              onThinking: (thinking) => {
                anthropicThinking = thinking;
              },
            })
        );

        anthropicContent = content;

        // Parse the output for tool calls if tools were provided
        let parsedOutput = null;
        if (tools) {
          parsedOutput = parseToolCallOutput(content);
          if (parsedOutput && parsedOutput.type === 'tool_calls') {
            log('anthropic tool calls detected', {
              tool_count: parsedOutput.toolCalls.length,
              tools: parsedOutput.toolCalls.map((t) => t.name),
            });
          } else {
            log('anthropic no tool calls detected', { response_type: parsedOutput?.type || 'text' });
          }
        }

        anthropicParsedOutput = parsedOutput;

        // If no tool calls, we're done
        if (!parsedOutput || parsedOutput.type !== 'tool_calls') {
          break;
        }

        // Default: hand tool_use blocks back to the client, which executes
        // tools in its own workspace. Server-side execution only when opted in.
        if (!isServerToolExecutionEnabled()) {
          break;
        }

        // Execute tool calls and build tool result messages
        const toolResults = [];
        const assistantToolCalls = [];

        for (const toolCall of parsedOutput.toolCalls) {
          const callId = generateCallId('call_');
          assistantToolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments || {}),
            },
          });

          log('executing anthropic tool', { name: toolCall.name, arguments: toolCall.arguments });
          const result = await executeToolCall(toolCall);
          log('anthropic tool result', { name: toolCall.name, result });

          toolResults.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
        }

        // Add assistant message with tool_calls
        workingMessagesAnthropic.push({
          role: 'assistant',
          content: parsedOutput.prefixText || null,
          tool_calls: assistantToolCalls,
        });

        // Add tool result messages
        workingMessagesAnthropic.push(...toolResults);

        anthropicToolDepth++;
      }

      if (anthropicToolDepth >= MAX_ANTHROPIC_TOOL_DEPTH) {
        log('warning: max anthropic tool call depth reached', { depth: MAX_ANTHROPIC_TOOL_DEPTH });
      }

      if (req.body.stream) {
        // Buffered request (tools declared) — emit the parsed result as a
        // proper SSE stream, including tool_use blocks when applicable.
        writeAnthropicMessageStream(res, { model, content: anthropicContent, parsedOutput: anthropicParsedOutput, thinking: anthropicThinking });
      } else {
        res.json(
          createAnthropicMessage({
            model,
            content: anthropicContent,
            parsedOutput: anthropicParsedOutput,
            usage: tracker.snapshot(anthropicContent || ''),
            thinking: anthropicThinking,
          }),
        );
      }
      log('anthropic message request completed', { duration_ms: Date.now() - started, tool_call_depth: anthropicToolDepth });
      tracker.finish({ outputText: anthropicContent || '', durationMs: Date.now() - started });
      trackRequest({
        model,
        inputText: extractTextFromMessages(req.body.messages),
        outputText: anthropicContent || '',
        isError: false,
      });
    } catch (error) {
      log('anthropic message request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      tracker.finish({
        status: 'error',
        errorCode: error.code || 'internal_error',
        durationMs: Date.now() - started,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
      });
      if (!res.headersSent && !res.writableEnded) anthropicError(res, error);
    }
  });

  app.post(['/v1/messages/count_tokens', '/messages/count_tokens', '/v1/v1/messages/count_tokens'], (req, res) => {
    try {
      res.json({ input_tokens: estimateAnthropicInputTokens(req.body) });
    } catch (error) {
      anthropicError(res, error);
    }
  });

  // --- Usage / Credits API ---
  app.get('/usage/local', (_req, res) => {
    res.json(getUsage());
  });

  app.post('/usage/reset-local', (_req, res) => {
    resetUsage();
    res.json({ ok: true });
  });

  // --- Static Web Console at /ui ---
  const publicDir = path.join(__dirname, '..', 'public');

  // Redirect /ui → /ui/ so relative asset paths resolve correctly in the browser
  app.use('/ui', (req, res, next) => {
    if (req.originalUrl === '/ui' || req.originalUrl === '/ui?') {
      return res.redirect(301, '/ui/');
    }
    next();
  });

  // index.html 必须禁缓存：构建产物文件名带 hash，浏览器若启发式缓存了旧
  // index.html，会引用已不存在的旧 chunk，表现为「改了但页面时好时坏」。
  // 带 hash 的静态资源仍走默认 ETag 协商缓存。
  const sendIndex = (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  };

  // Serve /ui/ → index.html, and static assets under /ui/*
  app.get('/ui/', (_req, res) => {
    sendIndex(res);
  });

  app.use(
    '/ui',
    express.static(publicDir, {
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  // SPA fallback: client-side routes like /ui/accounts serve the app shell
  app.get('/ui/*', (_req, res) => {
    sendIndex(res);
  });

  // --- Admin: Set Proxy API Key (no apiKeyGuard, bootstrap operation) ---
  app.post('/admin/set-proxy-api-key', adminGuard, (req, res) => {
    const newKey = String(req.body?.key || '').trim();
    db.setConfig('PROXY_API_KEY', newKey);
    
    res.json({ ok: true, message: 'Proxy API Key updated. Restarting...' });
    setTimeout(() => {
      // 测试门控：与 update-env / restart 一致，禁止 spawn 替换进程并 exit
      if (process.env.QODER_PROXY_NO_RESTART === '1') {
        log('restart suppressed (QODER_PROXY_NO_RESTART=1)');
        return;
      }
      const { spawn } = require('child_process');
      const serverPath = path.join(__dirname, 'server.js');
      const child = spawn(process.execPath, [serverPath], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env } });
      child.unref();
      log('restarting after proxy API key update', { pid: child.pid });
      process.exit(0);
    }, 500);
  });

  // --- Admin: Get All Env Config ---
  app.get('/admin/env-config', adminGuard, (_req, res) => {
    const configRows = db.getAllConfig();
    const config = {};
    for (const row of configRows) {
      config[row.key] = row.value;
    }
    res.json({ ok: true, config });
  });

  // --- Admin: Update Env Config & Restart ---
  // Body: { updates?: {KEY: value}, deletes?: [KEY...] } — 至少一项。
  // PROXY_API_KEY 有专门管理端点，不允许从这里删除。
  const ENV_DELETE_PROTECTED = new Set(['PROXY_API_KEY']);
  const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  app.post('/admin/update-env', adminGuard, (req, res) => {
    const updates = req.body?.updates;
    const deletes = req.body?.deletes;
    const hasUpdates = updates && typeof updates === 'object' && !Array.isArray(updates);
    const hasDeletes = Array.isArray(deletes);
    if (!hasUpdates && !hasDeletes) {
      return openAiError(
        res,
        new AppError(400, 'invalid_request', 'updates (object) or deletes (array) is required'),
      );
    }
    if (hasUpdates) {
      for (const key of Object.keys(updates)) {
        if (!ENV_KEY_RE.test(key)) {
          return openAiError(
            res,
            new AppError(400, 'invalid_request', `Invalid config key: ${key}`),
          );
        }
      }
    }
    const deleteKeys = hasDeletes ? deletes.filter((k) => typeof k === 'string') : [];
    const blocked = deleteKeys.filter((k) => ENV_DELETE_PROTECTED.has(k));
    if (blocked.length > 0) {
      return openAiError(
        res,
        new AppError(400, 'invalid_request', `Protected keys cannot be deleted: ${blocked.join(', ')}`),
      );
    }

    if (hasUpdates) {
      for (const [key, value] of Object.entries(updates)) {
        db.setConfig(key, String(value));
      }
    }
    for (const key of deleteKeys) {
      db.deleteConfig(key);
    }

    // Send response first
    res.json({ ok: true, message: 'Config updated. Restarting...' });

    // Restart after response
    setTimeout(() => {
      // Tests set this to exercise the endpoints without spawning a real
      // replacement process (which would exit the test runner).
      if (process.env.QODER_PROXY_NO_RESTART === '1') {
        log('restart suppressed (QODER_PROXY_NO_RESTART=1)');
        return;
      }
      const { spawn } = require('child_process');
      const serverPath = path.join(__dirname, 'server.js');
      const child = spawn(process.execPath, [serverPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      log('restarting after env update', {
        keys: hasUpdates ? Object.keys(updates) : [],
        deleted: deleteKeys,
        pid: child.pid,
      });
      process.exit(0);
    }, 500);
  });

  // --- Admin: Restart with new settings ---
  app.post('/admin/restart', adminGuard, (req, res) => {
    // port 可选：设置页「重启服务」按钮不传参（按当前配置原样重启）；
    // 显式传入时才校验 1-65535
    const rawPort = req.body?.port;
    const newPort =
      rawPort === undefined || rawPort === null || rawPort === ''
        ? Number(db.getConfig('PORT') || process.env.PORT || 3000)
        : Number(rawPort);
    const newBindHost = req.body?.bindHost || db.getConfig('BIND_HOST') || '127.0.0.1';
    const newQoderBaseUrl = req.body?.qoderBaseUrl || db.getConfig('QODERCN_BASE_URL') || '';
    const newAllowedHosts = req.body?.allowedHosts || db.getConfig('ALLOWED_HOSTS') || '';
    const newAllowedOrigins = req.body?.allowedOrigins || db.getConfig('ALLOWED_ORIGINS') || '';

    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return openAiError(res, new AppError(400, 'invalid_request', 'port must be 1-65535'));
    }

    // Update database config
    db.setConfig('PORT', String(newPort));
    db.setConfig('BIND_HOST', newBindHost);
    if (newQoderBaseUrl) db.setConfig('QODERCN_BASE_URL', newQoderBaseUrl);
    if (newAllowedHosts) db.setConfig('ALLOWED_HOSTS', newAllowedHosts);
    if (newAllowedOrigins) db.setConfig('ALLOWED_ORIGINS', newAllowedOrigins);

    // Send response first, then restart
    res.json({ ok: true, message: 'Restarting with new settings...' });

    // Spawn new process and exit
    setTimeout(() => {
      if (process.env.QODER_PROXY_NO_RESTART === '1') {
        log('restart suppressed (QODER_PROXY_NO_RESTART=1)');
        return;
      }
      const { spawn } = require('child_process');
      const serverPath = path.join(__dirname, 'server.js');
      const child = spawn(process.execPath, [serverPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PORT: String(newPort),
          BIND_HOST: newBindHost,
          QODERCN_BASE_URL: newQoderBaseUrl,
          ALLOWED_HOSTS: newAllowedHosts,
          ALLOWED_ORIGINS: newAllowedOrigins,
        },
      });
      child.unref();
      log('restarting with new settings', { newPort, newBindHost, newQoderBaseUrl, pid: child.pid });
      process.exit(0);
    }, 500);
  });

  app.use((_req, res) => {
    openAiError(res, new AppError(404, 'not_found', 'Route not found.'));
  });

  app.use((error, req, res, _next) => {
    // Opt-in request-level error log (LOG_REQUESTS=1) so users can attach
    // diagnostics to bug reports; output stays redacted via log().
    if (/^(1|true|yes)$/i.test(process.env.LOG_REQUESTS || '')) {
      const url = String(req.originalUrl || req.url || '').split('?')[0];
      log('request error', {
        method: req.method,
        url,
        status: error && error.status ? error.status : 500,
        code: error && error.code,
        message: error && error.message,
      });
    }
    openAiError(res, error);
  });

  return app;
}

module.exports = {
  MODEL_ID,
  createApp,
  createChatCompletion,
  extractRequestOptions,
  writeChatCompletionStream,
  validateChatRequest,
  resetLoginRateLimit,
};
