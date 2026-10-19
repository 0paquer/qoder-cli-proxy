'use strict';

/**
 * User domain data access: user + api_key + user_account_grant + quota.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { encryptSecret, decryptSecret } = require('../crypto');

const USER_SELECT = `
  SELECT id, username, password_algo, password_hash, salt, role, enabled,
         created_at, updated_at
  FROM user
`;

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Users ─────────────────────────────────────────────────────────────────────

function listUsers() {
  return db.prepare(`${USER_SELECT} ORDER BY id`).all().map(toPublicUser);
}

function getUserById(id) {
  return toPublicUser(db.prepare(`${USER_SELECT} WHERE id = ?`).get(id));
}

/** Full row including password fields — for the auth path only. */
function getUserByUsername(username) {
  return db.prepare(`${USER_SELECT} WHERE username = ?`).get(username) || null;
}

/**
 * Create a user. Passwords hash with bcrypt by default; 'sha256-salt' is
 * only used when explicitly requested (legacy compat tests).
 */
function createUser({ username, password, role = 'user', passwordAlgo = 'bcrypt' }) {
  if (!username || !String(username).trim()) {
    return { ok: false, error: 'Username is required' };
  }
  if (!password || String(password).length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters' };
  }

  let passwordHash = null;
  let salt = null;
  if (passwordAlgo === 'bcrypt') {
    passwordHash = bcrypt.hashSync(String(password), 10);
  } else {
    passwordAlgo = 'sha256-salt';
    salt = crypto.randomBytes(16).toString('hex');
    passwordHash = crypto.createHash('sha256').update(String(password) + salt).digest('hex');
  }

  try {
    const info = db.prepare(`
      INSERT INTO user (username, password_algo, password_hash, salt, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(username).trim(), passwordAlgo, passwordHash, salt, role === 'admin' ? 'admin' : 'user');
    return { ok: true, user: getUserById(info.lastInsertRowid) };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { ok: false, error: 'Username already exists' };
    }
    return { ok: false, error: err.message };
  }
}

function updateUserPassword(id, password) {
  if (!password || String(password).length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters' };
  }
  const passwordHash = bcrypt.hashSync(String(password), 10);
  const result = db.prepare(`
    UPDATE user SET password_algo = 'bcrypt', password_hash = ?, salt = NULL,
                    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(passwordHash, id);
  return result.changes > 0 ? { ok: true } : { ok: false, error: 'User not found' };
}

/**
 * Verify a password against a full user row. Legacy sha256-salt hashes are
 * transparently upgraded to bcrypt after a successful verification.
 */
function verifyUserPassword(userRow, password) {
  if (!userRow) return false;
  let ok = false;
  if (userRow.password_algo === 'bcrypt') {
    ok = bcrypt.compareSync(String(password), userRow.password_hash);
  } else {
    const salt = userRow.salt || '';
    ok = crypto.createHash('sha256').update(String(password) + salt).digest('hex') === userRow.password_hash;
    if (ok) {
      // Transparent upgrade to bcrypt
      try {
        db.prepare(`
          UPDATE user SET password_algo = 'bcrypt', password_hash = ?, salt = NULL,
                          updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND password_algo = 'sha256-salt'
        `).run(bcrypt.hashSync(String(password), 10), userRow.id);
      } catch (_) {
        // Upgrade is best-effort; the login itself still succeeds.
      }
    }
  }
  return ok;
}

function updateUser(id, { role, enabled }) {
  const current = db.prepare('SELECT id, role, enabled FROM user WHERE id = ?').get(id);
  if (!current) return { ok: false, error: 'User not found' };

  db.prepare(`
    UPDATE user SET role = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(
    role !== undefined ? (role === 'admin' ? 'admin' : 'user') : current.role,
    enabled !== undefined ? (enabled ? 1 : 0) : current.enabled,
    id
  );
  return { ok: true, user: getUserById(id) };
}

function deleteUser(id) {
  // Cascade removes api_key, grants, quota. usage_record keeps facts (SET NULL).
  const result = db.prepare('DELETE FROM user WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── API Keys ──────────────────────────────────────────────────────────────────

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

const RUNTIME_COLUMNS = `
  r.base_url, r.reasoning_effort, r.context_window, r.max_output_tokens, r.timeout_ms
`;

/** Map a joined api_key + api_key_runtime row to the public key shape. */
function toPublicKey(row) {
  const hasRuntime = row.base_url !== undefined && row.base_url !== null
    || row.reasoning_effort !== null
    || row.context_window !== null
    || row.max_output_tokens !== null
    || row.timeout_ms !== null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    runtime: hasRuntime
      ? {
          baseUrl: row.base_url,
          reasoningEffort: row.reasoning_effort,
          contextWindow: row.context_window,
          maxOutputTokens: row.max_output_tokens,
          timeoutMs: row.timeout_ms,
        }
      : null,
  };
}

/**
 * Normalize a per-key runtime config from admin input: empty strings and
 * non-numeric values become NULL. Returns null when nothing is configured.
 */
function normalizeRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  const text = (v) => {
    const s = String(v ?? '').trim();
    return s || null;
  };
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  const effort = text(runtime.reasoningEffort);
  const value = {
    baseUrl: text(runtime.baseUrl),
    reasoningEffort: ['low', 'medium', 'high'].includes(effort) ? effort : null,
    contextWindow: num(runtime.contextWindow),
    maxOutputTokens: num(runtime.maxOutputTokens),
    timeoutMs: num(runtime.timeoutMs),
  };
  const hasAny = Object.values(value).some((v) => v !== null);
  return hasAny ? value : null;
}

/**
 * Generate a proxy API key for a user. The plaintext is returned exactly once;
 * an AES-256-GCM encrypted copy (key_enc) is stored so admins can reveal it
 * later from the console. Format: "qk-" + 32 base64url chars; key_prefix
 * stores the first 11 chars ("qk-XXXXXXXX") for list display.
 * `runtime` (optional) carries per-key Qoder invocation overrides.
 */
function createApiKey(userId, name = 'Unnamed key', expiresAt = null, runtime = null) {
  const user = db.prepare('SELECT id FROM user WHERE id = ?').get(userId);
  if (!user) return { ok: false, error: 'User not found' };

  const normalized = normalizeRuntime(runtime);
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `qk-${secret}`;
  const keyPrefix = plaintext.slice(0, 11);

  const apiKeyId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO api_key (user_id, name, key_prefix, key_hash, key_enc, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      String(name || 'Unnamed key'),
      keyPrefix,
      hashApiKey(plaintext),
      encryptSecret(plaintext),
      expiresAt
    );

    if (normalized) {
      db.prepare(`
        INSERT INTO api_key_runtime
          (api_key_id, base_url, reasoning_effort, context_window, max_output_tokens, timeout_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        info.lastInsertRowid,
        normalized.baseUrl,
        normalized.reasoningEffort,
        normalized.contextWindow,
        normalized.maxOutputTokens,
        normalized.timeoutMs
      );
    }
    return info.lastInsertRowid;
  })();

  return { ok: true, apiKey: { id: apiKeyId, key: plaintext, keyPrefix } };
}

function listApiKeys(userId) {
  return db.prepare(`
    SELECT k.id, k.user_id, k.name, k.key_prefix, k.expires_at, k.last_used_at,
           k.revoked_at, k.created_at, ${RUNTIME_COLUMNS}
    FROM api_key k
    LEFT JOIN api_key_runtime r ON r.api_key_id = k.id
    WHERE k.user_id = ? ORDER BY k.id
  `).all(userId).map(toPublicKey);
}

/**
 * 解密查看完整密钥。旧版密钥（仅哈希存储，key_enc 为空）明文不可恢复。
 */
function revealApiKey(keyId) {
  const row = db.prepare('SELECT key_enc FROM api_key WHERE id = ?').get(keyId);
  if (!row) return { ok: false, error: 'API key not found' };
  if (!row.key_enc) return { ok: false, error: 'legacy' };
  try {
    return { ok: true, key: decryptSecret(row.key_enc) };
  } catch (_) {
    return { ok: false, error: 'decrypt' };
  }
}

/** Whether any usable key exists — drives "auth is now enforced" behavior. */
function hasAnyApiKeys() {
  return Boolean(
    db.prepare('SELECT 1 FROM api_key WHERE revoked_at IS NULL LIMIT 1').get()
  );
}

/**
 * Resolve a presented key to a usable api_key row (hash lookup).
 * Returns null when unknown, revoked, or expired.
 * The joined api_key_runtime columns (when present) ride along so the auth
 * path can expose per-key invocation overrides without a second query.
 */
function findUsableApiKey(presentedKey) {
  const value = String(presentedKey || '').trim();
  if (!value) return null;

  const row = db.prepare(`
    SELECT k.*, ${RUNTIME_COLUMNS}
    FROM api_key k
    LEFT JOIN api_key_runtime r ON r.api_key_id = k.id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
  `).get(hashApiKey(value));

  return row || null;
}

function touchApiKey(id) {
  db.prepare('UPDATE api_key SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

/**
 * Replace a key's runtime config. All-empty input deletes the row
 * (back to defaults). Returns false when the key does not exist.
 */
function updateApiKeyRuntime(keyId, runtime) {
  const key = db.prepare('SELECT id FROM api_key WHERE id = ?').get(keyId);
  if (!key) return { ok: false, error: 'API key not found' };

  const normalized = normalizeRuntime(runtime);
  db.transaction(() => {
    if (!normalized) {
      db.prepare('DELETE FROM api_key_runtime WHERE api_key_id = ?').run(keyId);
      return;
    }
    db.prepare(`
      INSERT INTO api_key_runtime
        (api_key_id, base_url, reasoning_effort, context_window, max_output_tokens, timeout_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(api_key_id) DO UPDATE SET
        base_url = excluded.base_url,
        reasoning_effort = excluded.reasoning_effort,
        context_window = excluded.context_window,
        max_output_tokens = excluded.max_output_tokens,
        timeout_ms = excluded.timeout_ms,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      keyId,
      normalized.baseUrl,
      normalized.reasoningEffort,
      normalized.contextWindow,
      normalized.maxOutputTokens,
      normalized.timeoutMs
    );
  })();
  return { ok: true };
}

function revokeApiKey(id) {
  const result = db.prepare(`
    UPDATE api_key SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revoked_at IS NULL
  `).run(id);
  return result.changes > 0;
}

function deleteApiKey(id) {
  const result = db.prepare('DELETE FROM api_key WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── Account Grants (N:M) ──────────────────────────────────────────────────────

function grantAccount(userId, accountId) {
  try {
    db.prepare(`
      INSERT INTO user_account_grant (user_id, account_id) VALUES (?, ?)
    `).run(userId, accountId);
    return { ok: true };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { ok: true }; // idempotent
    }
    // FK violation: user or account missing
    return { ok: false, error: 'User or account not found' };
  }
}

function revokeGrant(userId, accountId) {
  const result = db.prepare(`
    DELETE FROM user_account_grant WHERE user_id = ? AND account_id = ?
  `).run(userId, accountId);
  return result.changes > 0;
}

function listGrants(userId) {
  return db.prepare(`
    SELECT account_id FROM user_account_grant WHERE user_id = ?
  `).all(userId).map((row) => row.account_id);
}

function userHasGrant(userId, accountId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM user_account_grant WHERE user_id = ? AND account_id = ?
  `).get(userId, accountId));
}

// ── Quota ─────────────────────────────────────────────────────────────────────

function getQuota(userId) {
  const row = db.prepare('SELECT * FROM quota WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    userId: row.user_id,
    dailyTokenLimit: row.daily_token_limit,
    dailyRequestLimit: row.daily_request_limit,
    monthlyTokenLimit: row.monthly_token_limit,
    monthlyRequestLimit: row.monthly_request_limit,
    updatedAt: row.updated_at,
  };
}

function setQuota(userId, { dailyTokenLimit, dailyRequestLimit, monthlyTokenLimit, monthlyRequestLimit }) {
  const toLimit = (value) => (value === null || value === undefined || value === ''
    ? null
    : Math.max(0, Number(value) || 0));

  db.prepare(`
    INSERT INTO quota (user_id, daily_token_limit, daily_request_limit, monthly_token_limit, monthly_request_limit, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      daily_token_limit = excluded.daily_token_limit,
      daily_request_limit = excluded.daily_request_limit,
      monthly_token_limit = excluded.monthly_token_limit,
      monthly_request_limit = excluded.monthly_request_limit,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    toLimit(dailyTokenLimit),
    toLimit(dailyRequestLimit),
    toLimit(monthlyTokenLimit),
    toLimit(monthlyRequestLimit)
  );
  return getQuota(userId);
}

module.exports = {
  listUsers,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  updateUserPassword,
  verifyUserPassword,
  deleteUser,
  createApiKey,
  listApiKeys,
  revealApiKey,
  hasAnyApiKeys,
  findUsableApiKey,
  touchApiKey,
  updateApiKeyRuntime,
  revokeApiKey,
  deleteApiKey,
  grantAccount,
  revokeGrant,
  listGrants,
  userHasGrant,
  getQuota,
  setQuota,
};
