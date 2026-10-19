'use strict';

/**
 * Versioned schema migrations.
 *
 * Each migration runs once, inside a transaction, and is recorded in
 * schema_migration. Data migration happens in JS (not plain SQL) where
 * secrets must be encrypted or old rows transformed.
 *
 * Domain layout (no cross-domain blob tables):
 *   qoder_account            — identity of a Qoder account
 *   qoder_account_credential — 1:1 secret (PAT) storage
 *   qoder_account_schedule   — 1:1 load-balancing / scheduling state
 *   user                     — proxy users (admin | user)
 *   api_key                  — per-user API keys for proxy access
 *   user_account_grant       — N:M which user may use which account
 *   quota                    — 1:1 per-user limits (NULL = unlimited)
 *   usage_record             — append-only usage facts; stats are aggregates
 */

const { encryptSecret, fingerprintSecret } = require('./crypto');

const MIGRATIONS = [
  {
    version: 1,
    name: 'multi-account-gateway',
    up(db) {
      db.exec(`
        CREATE TABLE qoder_account (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          backend_type TEXT NOT NULL DEFAULT 'cn' CHECK (backend_type IN ('cn', 'global')),
          base_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          remark TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE qoder_account_credential (
          account_id INTEGER PRIMARY KEY REFERENCES qoder_account(id) ON DELETE CASCADE,
          pat_ciphertext TEXT NOT NULL,
          key_version INTEGER NOT NULL DEFAULT 1,
          pat_fingerprint TEXT,
          verify_status TEXT NOT NULL DEFAULT 'unverified'
            CHECK (verify_status IN ('unverified', 'verified', 'failed')),
          verified_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE qoder_account_schedule (
          account_id INTEGER PRIMARY KEY REFERENCES qoder_account(id) ON DELETE CASCADE,
          weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
          max_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_concurrency >= 0),
          cooldown_until DATETIME,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          last_used_at DATETIME
        );

        CREATE TABLE user (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_algo TEXT NOT NULL DEFAULT 'sha256-salt'
            CHECK (password_algo IN ('bcrypt', 'sha256-salt')),
          password_hash TEXT NOT NULL,
          salt TEXT,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE api_key (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          expires_at DATETIME,
          last_used_at DATETIME,
          revoked_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE user_account_grant (
          user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES qoder_account(id) ON DELETE CASCADE,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, account_id)
        );

        CREATE TABLE quota (
          user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
          daily_token_limit INTEGER,
          daily_request_limit INTEGER,
          monthly_token_limit INTEGER,
          monthly_request_limit INTEGER,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE usage_record (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES user(id) ON DELETE SET NULL,
          api_key_id INTEGER REFERENCES api_key(id) ON DELETE SET NULL,
          account_id INTEGER REFERENCES qoder_account(id) ON DELETE SET NULL,
          model TEXT NOT NULL DEFAULT '',
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          token_source TEXT NOT NULL DEFAULT 'estimated'
            CHECK (token_source IN ('actual', 'estimated')),
          status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error')),
          error_code TEXT,
          duration_ms INTEGER,
          stream INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX idx_usage_record_ts ON usage_record(ts);
        CREATE INDEX idx_usage_record_user_ts ON usage_record(user_id, ts);
        CREATE INDEX idx_usage_record_account_ts ON usage_record(account_id, ts);
        CREATE INDEX idx_api_key_user ON api_key(user_id);
      `);

      // ── admin_users → user (transparent carry-over) ────────────────────────
      const legacyUsers = db.prepare('SELECT * FROM admin_users').all();
      const insertUser = db.prepare(`
        INSERT INTO user (username, password_algo, password_hash, salt, role)
        VALUES (?, 'sha256-salt', ?, ?, 'admin')
      `);
      for (const row of legacyUsers) {
        insertUser.run(row.username, row.password_hash, row.salt);
      }

      // ── Seed the first account from the legacy single-token config ─────────
      const getConfig = (key) => {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
        return row ? row.value : null;
      };

      const backendType = (getConfig('CLI_BACKEND') || 'cn').toLowerCase() === 'global'
        ? 'global'
        : 'cn';
      const token =
        backendType === 'global'
          ? getConfig('QODER_PAT')
          : getConfig('QODERCN_PERSONAL_ACCESS_TOKEN');

      if (token) {
        const baseUrl = getConfig('QODERCN_BASE_URL');
        const info = db.prepare(`
          INSERT INTO qoder_account (name, backend_type, base_url, enabled)
          VALUES ('default', ?, ?, 1)
        `).run(backendType, baseUrl || null);
        const accountId = info.lastInsertRowid;

        db.prepare(`
          INSERT INTO qoder_account_credential
            (account_id, pat_ciphertext, key_version, pat_fingerprint, verify_status)
          VALUES (?, ?, 1, ?, 'unverified')
        `).run(accountId, encryptSecret(token), fingerprintSecret(token));

        db.prepare(`
          INSERT INTO qoder_account_schedule (account_id, weight, max_concurrency)
          VALUES (?, 1, 0)
        `).run(accountId);
      }

      // ── Legacy PROXY_API_KEY → api_key owned by the first admin ────────────
      const proxyKey = (getConfig('PROXY_API_KEY') || '').trim();
      if (proxyKey) {
        const firstAdmin = db.prepare(
          "SELECT id FROM user WHERE role = 'admin' ORDER BY id LIMIT 1"
        ).get();
        if (firstAdmin) {
          db.prepare(`
            INSERT INTO api_key (user_id, name, key_prefix, key_hash)
            VALUES (?, 'Migrated PROXY_API_KEY', ?, ?)
          `).run(
            firstAdmin.id,
            proxyKey.slice(0, 8),
            hashForApiKey(proxyKey)
          );
        }
      }
    },
  },
  {
    version: 2,
    name: 'api-key-runtime-config',
    up(db) {
      // Per-key Qoder invocation overrides (QODERCN_* equivalents).
      // NULL = not configured, fall back to account/global defaults.
      db.exec(`
        CREATE TABLE api_key_runtime (
          api_key_id INTEGER PRIMARY KEY REFERENCES api_key(id) ON DELETE CASCADE,
          base_url TEXT,
          reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high')),
          context_window INTEGER,
          max_output_tokens INTEGER,
          timeout_ms INTEGER,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 3,
    name: 'api-key-encrypted-reveal',
    up(db) {
      // 完整密钥 AES-256-GCM 加密存储（data/.secret-key），支持控制台事后查看。
      // NULL = 旧版仅哈希存储的密钥，明文不可恢复。
      db.exec('ALTER TABLE api_key ADD COLUMN key_enc TEXT');

      // Best effort：迁移过的 PROXY_API_KEY 若明文仍在 config，回填可查看。
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = 'PROXY_API_KEY'").get();
        const proxyKey = row ? String(row.value || '').trim() : '';
        if (proxyKey) {
          const { encryptSecret } = require('./crypto');
          db.prepare(`
            UPDATE api_key SET key_enc = ?
            WHERE name = 'Migrated PROXY_API_KEY' AND key_hash = ? AND key_enc IS NULL
          `).run(encryptSecret(proxyKey), hashForApiKey(proxyKey));
        }
      } catch (_) {
        // 明文已清理或加密组件不可用：该密钥保持不可查看。
      }
    },
  },
  {
    version: 4,
    name: 'drop-cli-mode-config',
    up(db) {
      // 对话执行已统一为 Agent SDK 驱动，CLI_MODE 开关废弃；
      // 从配置真源移除，避免设置页继续展示无效变量。
      db.exec("DELETE FROM config WHERE key = 'CLI_MODE'");
    },
  },
];

function hashForApiKey(key) {
  return require('crypto').createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Run all pending migrations. Safe to call on every startup; each migration
 * executes at most once, inside its own transaction.
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migration').all().map((r) => r.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const run = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migration (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
    });
    run();

    console.log(`[migrations] applied v${migration.version}: ${migration.name}`);
  }
}

module.exports = { runMigrations, MIGRATIONS };
