'use strict';

const crypto = require('crypto');
const { AppError, anthropicError, openAiError } = require('./errors');

// The proxy binds to 127.0.0.1, but that alone does not make it private:
//
//   * Any web page the user visits can POST to http://127.0.0.1:3000 from the
//     browser. Loopback binding does not stop that — only an Origin check does.
//   * A DNS-rebinding domain can resolve to 127.0.0.1 and reach the same
//     socket, carrying its own name in the Host header.
//
// Native API clients (curl, OpenCode, Trae, Cline, editor plugins) send no
// Origin header at all, so requiring a loopback Origin costs them nothing while
// closing both holes.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  return String(value || '').trim().toLowerCase().replace(/\/+$/, '');
}

/** Extract the hostname from a Host header value ("host", "host:port", "[::1]:port"). */
function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.split(':')[0];
}

function isLoopbackHostname(hostname) {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Guard against DNS rebinding: a request that arrives on the loopback socket
 * but names some other host was sent by a page that resolved that name to
 * 127.0.0.1. ALLOWED_HOSTS is the explicit opt-out for anyone who deliberately
 * fronts the proxy with a different hostname.
 * 
 * When BIND_HOST is 0.0.0.0 and ALLOWED_HOSTS is empty, allow any host.
 * The user explicitly chose to expose the proxy to the network.
 */
function isAllowedHost(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  // HTTP/1.0 clients may omit Host. Browsers never do, so this is not an
  // attack vector — accept it rather than breaking simple scripts.
  if (!value) return true;

  const allowed = splitList(process.env.ALLOWED_HOSTS).map((host) => host.toLowerCase());
  
  // When BIND_HOST is 0.0.0.0 and ALLOWED_HOSTS is empty, allow any host
  if (allowed.length === 0 && (process.env.BIND_HOST || '127.0.0.1') === '0.0.0.0') {
    return true;
  }
  
  if (allowed.includes(value)) return true;

  const hostname = hostnameOf(value);
  if (allowed.includes(hostname)) return true;

  return isLoopbackHostname(hostname);
}

/**
 * Only same-machine browser origins may talk to the proxy. Anything else is a
 * third-party page spending the user's Qoder quota, so it is refused outright
 * rather than merely having its CORS headers withheld.
 * 
 * When BIND_HOST is 0.0.0.0 and ALLOWED_ORIGINS is empty, allow any origin.
 * The user explicitly chose to expose the proxy to the network.
 */
function isAllowedOrigin(originHeader) {
  const origin = String(originHeader || '').trim();
  if (!origin) return true; // Not a browser — native API client.
  // "null" is what a sandboxed iframe or a file:// page sends.
  if (origin.toLowerCase() === 'null') return false;

  const allowed = splitList(process.env.ALLOWED_ORIGINS).map(normalizeOrigin);
  
  // When BIND_HOST is 0.0.0.0 and ALLOWED_ORIGINS is empty, allow any origin
  if (allowed.length === 0 && (process.env.BIND_HOST || '127.0.0.1') === '0.0.0.0') {
    return true;
  }
  
  if (allowed.includes(normalizeOrigin(origin))) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHostname(parsed.hostname.toLowerCase());
}

function isProxyAuthEnabled() {
  return Boolean((process.env.PROXY_API_KEY || '').trim());
}

function timingSafeEquals(presented, expected) {
  // Hash first so the comparison operates on equal-length buffers without
  // leaking the expected key's length.
  const left = crypto.createHash('sha256').update(String(presented), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function extractPresentedKey(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return '';
}

/**
 * Anthropic clients expect Anthropic-shaped errors; everyone else gets OpenAI's.
 *
 * Uses originalUrl rather than req.path: these guards are mounted with
 * app.use('/v1', …), and Express strips the mount prefix from req.path, so
 * req.path would read "/messages" here.
 */
function respondWithError(req, res, error) {
  const url = String(req.originalUrl || req.url || '').split('?')[0];
  if (url.startsWith('/v1/messages')) {
    return anthropicError(res, error);
  }
  return openAiError(res, error);
}

function localOnlyGuard(req, res, next) {
  if (!isAllowedHost(req.headers.host)) {
    return respondWithError(
      req,
      res,
      new AppError(
        403,
        'host_not_allowed',
        'Rejected: unexpected Host header. This proxy serves loopback hosts only. ' +
          'Set ALLOWED_HOSTS if you deliberately front it with another hostname.',
        'invalid_request_error'
      )
    );
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    return respondWithError(
      req,
      res,
      new AppError(
        403,
        'origin_not_allowed',
        'Rejected: cross-origin browser requests are not allowed, because any web page ' +
          'you visit could otherwise spend your Qoder quota. Set ALLOWED_ORIGINS if a ' +
          'local web app legitimately needs access.',
        'invalid_request_error'
      )
    );
  }

  return next();
}

function apiKeyGuard(req, res, next) {
  const expected = (process.env.PROXY_API_KEY || '').trim();
  if (!expected) return next(); // Opt-in; unset means no key required.

  const presented = extractPresentedKey(req);
  if (!presented) {
    return respondWithError(
      req,
      res,
      new AppError(
        401,
        'invalid_api_key',
        'Invalid or missing API key. Send PROXY_API_KEY as "Authorization: Bearer <key>" ' +
          'or "x-api-key: <key>".',
        'authentication_error'
      )
    );
  }
  
  // Check if it's the PROXY_API_KEY
  if (timingSafeEquals(presented, expected)) {
    return next();
  }
  
  // Check if it's a valid admin session token
  const db = require('./db');
  const session = db.verifySession(presented);
  if (session) {
    return next();
  }
  
  return respondWithError(
    req,
    res,
    new AppError(
      401,
      'invalid_api_key',
      'Invalid or missing API key. Send PROXY_API_KEY as "Authorization: Bearer <key>" ' +
        'or "x-api-key: <key>".',
      'authentication_error'
    )
  );
}

// ── Multi-user gateway authentication ─────────────────────────────────────────
// Resolves the presented credential to a principal:
//   qk-* keys  → api_key row → owning user
//   session    → user row by username
//   PROXY_API_KEY → legacy admin bootstrap (userId null)
// Enforcement policy: as soon as PROXY_API_KEY is set OR any api_key exists,
// /v1 traffic must present a valid credential. When neither is configured the
// proxy stays open (single-user local mode) so existing setups keep working.

function resolvePrincipal(presentedKey) {
  const usersStore = require('./stores/users');
  const value = String(presentedKey || '').trim();
  if (!value) return null;

  if (value.startsWith('qk-')) {
    const row = usersStore.findUsableApiKey(value);
    if (!row) return null;
    const user = usersStore.getUserById(row.user_id);
    if (!user || !user.enabled) return null;
    usersStore.touchApiKey(row.id);
    // Per-key Qoder invocation overrides (api_key_runtime, may be all NULL).
    const apiKeyConfig = row.base_url != null
      || row.reasoning_effort != null
      || row.context_window != null
      || row.max_output_tokens != null
      || row.timeout_ms != null
      ? {
          baseUrl: row.base_url,
          reasoningEffort: row.reasoning_effort,
          contextWindow: row.context_window,
          maxOutputTokens: row.max_output_tokens,
          timeoutMs: row.timeout_ms,
        }
      : null;
    return {
      type: 'api_key',
      userId: user.id,
      apiKeyId: row.id,
      apiKeyConfig,
      username: user.username,
      role: user.role,
    };
  }

  const db = require('./db');
  const session = db.verifySession(value);
  if (session) {
    const user = usersStore.getUserByUsername(session.username);
    if (!user || !user.enabled) return null;
    return {
      type: 'session',
      userId: user.id,
      apiKeyId: null,
      username: user.username,
      role: user.role,
    };
  }

  const proxyKey = (process.env.PROXY_API_KEY || '').trim();
  if (proxyKey && timingSafeEquals(value, proxyKey)) {
    return { type: 'legacy', userId: null, apiKeyId: null, username: null, role: 'admin' };
  }

  return null;
}

const ANONYMOUS_PRINCIPAL = Object.freeze({
  type: 'anonymous',
  userId: null,
  apiKeyId: null,
  username: null,
  role: 'admin',
});

function gatewayGuard(req, res, next) {
  const usersStore = require('./stores/users');
  const proxyKey = (process.env.PROXY_API_KEY || '').trim();
  const presented = extractPresentedKey(req);

  // Open mode: no credential infrastructure at all. Native clients sometimes
  // send placeholder keys (Anthropic SDKs always populate x-api-key), so any
  // presented value is accepted as the anonymous local principal.
  if (!proxyKey && !usersStore.hasAnyApiKeys()) {
    req.principal = ANONYMOUS_PRINCIPAL;
    return next();
  }

  if (!presented) {
    return respondWithError(
      req,
      res,
      new AppError(
        401,
        'invalid_api_key',
        'Invalid or missing API key. Send your key as "Authorization: Bearer <key>" ' +
          'or "x-api-key: <key>".',
        'authentication_error'
      )
    );
  }

  const principal = resolvePrincipal(presented);
  if (!principal) {
    return respondWithError(
      req,
      res,
      new AppError(401, 'invalid_api_key', 'Invalid or expired API key.', 'authentication_error')
    );
  }

  req.principal = principal;
  return next();
}

/** Enforce per-user quota before the request runs (admin/anonymous exempt). */
function quotaGuard(req, res, next) {
  const principal = req.principal;
  if (!principal || principal.userId == null) return next();

  const usersStore = require('./stores/users');
  const usageStore = require('./stores/usage');

  const quota = usersStore.getQuota(principal.userId);
  if (!quota) return next();

  const usage = usageStore.getQuotaUsage(principal.userId);
  const exceeded = [];
  if (quota.dailyTokenLimit != null && usage.daily.tokens >= quota.dailyTokenLimit) {
    exceeded.push(`daily token limit (${usage.daily.tokens}/${quota.dailyTokenLimit})`);
  }
  if (quota.dailyRequestLimit != null && usage.daily.requests >= quota.dailyRequestLimit) {
    exceeded.push(`daily request limit (${usage.daily.requests}/${quota.dailyRequestLimit})`);
  }
  if (quota.monthlyTokenLimit != null && usage.monthly.tokens >= quota.monthlyTokenLimit) {
    exceeded.push(`monthly token limit (${usage.monthly.tokens}/${quota.monthlyTokenLimit})`);
  }
  if (quota.monthlyRequestLimit != null && usage.monthly.requests >= quota.monthlyRequestLimit) {
    exceeded.push(`monthly request limit (${usage.monthly.requests}/${quota.monthlyRequestLimit})`);
  }

  if (exceeded.length) {
    return respondWithError(
      req,
      res,
      new AppError(429, 'quota_exceeded', `Quota exceeded: ${exceeded.join('; ')}.`)
    );
  }
  return next();
}

// ── Account ACL helpers ───────────────────────────────────────────────────────

/** Accounts a principal may use: admins see all, users only their grants. */
function accountsForPrincipal(principal) {
  const accountsStore = require('./stores/accounts');
  if (!principal || principal.userId == null || principal.role === 'admin') {
    return accountsStore.listAccounts();
  }
  return accountsStore.getAccountsForUser(principal.userId);
}

function canUseAccount(principal, accountId) {
  if (!principal || principal.userId == null || principal.role === 'admin') return true;
  return require('./stores/users').userHasGrant(principal.userId, accountId);
}

// Admin guard: accepts admin token (from login) OR PROXY_API_KEY
function adminGuard(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return respondWithError(
      req,
      res,
      new AppError(401, 'unauthorized', 'Please login first.', 'authentication_error')
    );
  }
  
  const token = auth.slice(7).trim();
  
  // Check if it's the PROXY_API_KEY
  const proxyKey = (process.env.PROXY_API_KEY || '').trim();
  if (proxyKey && timingSafeEquals(token, proxyKey)) {
    return next();
  }
  
  // Check if it's a valid admin session token
  const db = require('./db');
  const session = db.verifySession(token);
  if (session) {
    // Role-aware: only admins pass the admin guard.
    const user = require('./stores/users').getUserByUsername(session.username);
    if (user && user.enabled && user.role === 'admin') {
      // 首登改密强制：admin 仍在使用初始默认密码时，除白名单端点外一律 403，
      // 迫使首次部署先改掉默认密码再执行任何管理操作。PROXY_API_KEY 分支
      // 不受影响（脚本自动化场景没有初始密码的概念）。
      if (db.isDefaultAdminPassword(user.username)) {
        // adminGuard 同时挂在 app 级路由（req.path = /admin/xxx）与
        // /admin 挂载的 router 内（req.path = /xxx），归一化后再比对。
        const p = String(req.path || '');
        const bare = p === '/admin' || p.startsWith('/admin/') ? p.slice('/admin'.length) : p;
        const allowed = new Set(['/change-password', '/logout', '/me']);
        if (!allowed.has(bare)) {
          return respondWithError(
            req,
            res,
            new AppError(
              403,
              'default_password',
              'Admin is still using the initial default password. ' +
                'Change it first via POST /admin/change-password before calling other admin APIs.',
              'permission_error'
            )
          );
        }
      }
      req.principal = {
        type: 'session',
        userId: user.id,
        apiKeyId: null,
        username: user.username,
        role: user.role,
      };
      return next();
    }
  }
  
  return respondWithError(
    req,
    res,
    new AppError(401, 'unauthorized', 'Invalid or expired token.', 'authentication_error')
  );
}

module.exports = {
  adminGuard,
  accountsForPrincipal,
  apiKeyGuard,
  canUseAccount,
  gatewayGuard,
  isAllowedHost,
  isAllowedOrigin,
  isProxyAuthEnabled,
  localOnlyGuard,
  quotaGuard,
  resolvePrincipal,
};
