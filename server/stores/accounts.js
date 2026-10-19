'use strict';

/**
 * Account domain data access: qoder_account + credential + schedule.
 *
 * Secrets never leave this module in plaintext except through getPat(),
 * which is reserved for the CLI execution path.
 */

const { db } = require('../db');
const { encryptSecret, decryptSecret, fingerprintSecret } = require('../crypto');

const ACCOUNT_SELECT = `
  SELECT
    a.id, a.name, a.backend_type, a.base_url, a.enabled, a.remark,
    a.created_at, a.updated_at,
    c.pat_fingerprint, c.verify_status, c.verified_at,
    s.weight, s.max_concurrency, s.cooldown_until,
    s.consecutive_failures, s.last_used_at
  FROM qoder_account a
  LEFT JOIN qoder_account_credential c ON c.account_id = a.id
  LEFT JOIN qoder_account_schedule s ON s.account_id = a.id
`;

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    backendType: row.backend_type,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    patFingerprint: row.pat_fingerprint,
    verifyStatus: row.verify_status || 'unverified',
    verifiedAt: row.verified_at,
    weight: row.weight ?? 1,
    maxConcurrency: row.max_concurrency ?? 0,
    cooldownUntil: row.cooldown_until,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastUsedAt: row.last_used_at,
  };
}

function listAccounts() {
  return db.prepare(`${ACCOUNT_SELECT} ORDER BY a.id`).all().map(mapRow);
}

function getAccount(id) {
  return mapRow(db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id));
}

function findAccountByName(name) {
  return mapRow(db.prepare(`${ACCOUNT_SELECT} WHERE a.name = ?`).get(name));
}

/**
 * Create an account with its credential (encrypted) and schedule row.
 * @returns {{ ok: boolean, account?: object, error?: string }}
 */
function createAccount({ name, backendType = 'cn', baseUrl = null, pat, weight = 1, maxConcurrency = 0, remark = null }) {
  if (!name || !String(name).trim()) {
    return { ok: false, error: 'Account name is required' };
  }
  if (!pat || !String(pat).trim()) {
    return { ok: false, error: 'PAT is required' };
  }
  const backend = backendType === 'global' ? 'global' : 'cn';

  try {
    const result = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO qoder_account (name, backend_type, base_url, enabled, remark)
        VALUES (?, ?, ?, 1, ?)
      `).run(String(name).trim(), backend, baseUrl || null, remark);
      const accountId = info.lastInsertRowid;

      db.prepare(`
        INSERT INTO qoder_account_credential
          (account_id, pat_ciphertext, key_version, pat_fingerprint, verify_status)
        VALUES (?, ?, 1, ?, 'unverified')
      `).run(accountId, encryptSecret(String(pat).trim()), fingerprintSecret(String(pat).trim()));

      db.prepare(`
        INSERT INTO qoder_account_schedule (account_id, weight, max_concurrency)
        VALUES (?, ?, ?)
      `).run(accountId, weight, maxConcurrency);

      return accountId;
    })();

    return { ok: true, account: getAccount(result) };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { ok: false, error: 'Account name already exists' };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Update identity fields only. Credential changes go through setAccountPat().
 */
function updateAccount(id, { name, backendType, baseUrl, enabled, remark }) {
  const current = db.prepare('SELECT * FROM qoder_account WHERE id = ?').get(id);
  if (!current) return { ok: false, error: 'Account not found' };

  try {
    db.prepare(`
      UPDATE qoder_account SET
        name = ?, backend_type = ?, base_url = ?, enabled = ?, remark = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name !== undefined ? String(name).trim() : current.name,
      backendType !== undefined ? (backendType === 'global' ? 'global' : 'cn') : current.backend_type,
      baseUrl !== undefined ? (baseUrl || null) : current.base_url,
      enabled !== undefined ? (enabled ? 1 : 0) : current.enabled,
      remark !== undefined ? remark : current.remark,
      id
    );
    return { ok: true, account: getAccount(id) };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { ok: false, error: 'Account name already exists' };
    }
    return { ok: false, error: err.message };
  }
}

/** Replace the PAT: re-encrypt, refresh fingerprint, reset verification. */
function setAccountPat(accountId, pat) {
  const value = String(pat || '').trim();
  if (!value) return { ok: false, error: 'PAT is required' };

  const result = db.prepare(`
    UPDATE qoder_account_credential SET
      pat_ciphertext = ?, key_version = 1, pat_fingerprint = ?,
      verify_status = 'unverified', verified_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
  `).run(encryptSecret(value), fingerprintSecret(value), accountId);

  return result.changes > 0 ? { ok: true } : { ok: false, error: 'Account not found' };
}

function setVerifyStatus(accountId, status) {
  const allowed = ['unverified', 'verified', 'failed'];
  if (!allowed.includes(status)) return { ok: false, error: 'Invalid verify status' };

  const result = db.prepare(`
    UPDATE qoder_account_credential SET
      verify_status = ?, verified_at = CASE WHEN ? = 'unverified' THEN NULL ELSE CURRENT_TIMESTAMP END,
      updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
  `).run(status, status, accountId);

  return result.changes > 0 ? { ok: true } : { ok: false, error: 'Account not found' };
}

function updateSchedule(accountId, { weight, maxConcurrency }) {
  const current = db.prepare('SELECT * FROM qoder_account_schedule WHERE account_id = ?').get(accountId);
  if (!current) return { ok: false, error: 'Account not found' };

  db.prepare(`
    UPDATE qoder_account_schedule SET weight = ?, max_concurrency = ? WHERE account_id = ?
  `).run(
    weight !== undefined ? Math.max(0, Number(weight) || 0) : current.weight,
    maxConcurrency !== undefined ? Math.max(0, Number(maxConcurrency) || 0) : current.max_concurrency,
    accountId
  );
  return { ok: true };
}

function deleteAccount(id) {
  // ON DELETE CASCADE removes credential, schedule, and grants.
  const result = db.prepare('DELETE FROM qoder_account WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── Secret access (CLI execution path only) ──────────────────────────────────

/** Decrypt and return the PAT for an account, or null. */
function getPat(accountId) {
  const row = db
    .prepare('SELECT pat_ciphertext FROM qoder_account_credential WHERE account_id = ?')
    .get(accountId);
  if (!row) return null;
  try {
    return decryptSecret(row.pat_ciphertext);
  } catch (err) {
    console.error(`[stores/accounts] Failed to decrypt PAT for account ${accountId}:`, err.message);
    return null;
  }
}

// ── Scheduling queries (load balancer consumes these; algorithm lives there) ──

/**
 * Enabled accounts of a backend type that are not cooling down,
 * ordered for weighted selection by the balancer.
 */
function getAvailableAccounts(backendType = 'cn', excludeIds = []) {
  const rows = db.prepare(`
    SELECT
      a.id, a.name, a.backend_type, a.enabled,
      s.weight, s.max_concurrency, s.cooldown_until, s.consecutive_failures, s.last_used_at
    FROM qoder_account a
    JOIN qoder_account_schedule s ON s.account_id = a.id
    WHERE a.enabled = 1
      AND a.backend_type = ?
      AND (s.cooldown_until IS NULL OR s.cooldown_until <= CURRENT_TIMESTAMP)
    ORDER BY s.last_used_at IS NULL DESC, s.last_used_at ASC
  `).all(backendType);

  const excluded = new Set(excludeIds);
  return rows.filter((row) => !excluded.has(row.id)).map(mapRow);
}

function markAccountUsed(accountId) {
  db.prepare(`
    UPDATE qoder_account_schedule SET last_used_at = CURRENT_TIMESTAMP WHERE account_id = ?
  `).run(accountId);
}

/**
 * Convert a Date/ISO string to SQLite's datetime format
 * ("YYYY-MM-DD HH:MM:SS", UTC) — required for comparisons against
 * CURRENT_TIMESTAMP, which does NOT compare correctly against ISO strings.
 */
function toSqliteDatetime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function setAccountCooldown(accountId, cooldownUntil) {
  db.prepare(`
    UPDATE qoder_account_schedule SET cooldown_until = ? WHERE account_id = ?
  `).run(toSqliteDatetime(cooldownUntil), accountId);
}

function recordAccountFailure(accountId) {
  db.prepare(`
    UPDATE qoder_account_schedule SET
      consecutive_failures = consecutive_failures + 1
    WHERE account_id = ?
  `).run(accountId);
}

function recordAccountSuccess(accountId) {
  db.prepare(`
    UPDATE qoder_account_schedule SET
      consecutive_failures = 0, cooldown_until = NULL
    WHERE account_id = ?
  `).run(accountId);
}

/** Accounts granted to a user (join through user_account_grant). */
function getAccountsForUser(userId) {
  return db.prepare(`
    ${ACCOUNT_SELECT}
    JOIN user_account_grant g ON g.account_id = a.id
    WHERE g.user_id = ?
    ORDER BY a.id
  `).all(userId).map(mapRow);
}

module.exports = {
  listAccounts,
  getAccount,
  findAccountByName,
  createAccount,
  updateAccount,
  setAccountPat,
  setVerifyStatus,
  updateSchedule,
  deleteAccount,
  getPat,
  getAvailableAccounts,
  markAccountUsed,
  setAccountCooldown,
  recordAccountFailure,
  recordAccountSuccess,
  getAccountsForUser,
};
