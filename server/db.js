const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// QODER_PROXY_DB overrides the database location (tests / portable setups)
const DB_PATH = process.env.QODER_PROXY_DB || path.join(__dirname, '..', 'data', 'qoder-proxy.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
// Enforce referential integrity for the domain tables (user/api_key/grants…)
db.pragma('foreign_keys = ON');

// Initialize base tables (config/sessions/usage_stats — legacy, still in use)
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    request_type TEXT DEFAULT 'chat'
  );
`);

// Helper: legacy sha256-salt password hash (kept for transparent upgrade path)
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

// Helper: generate random salt
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Helper: generate token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Config Operations ─────────────────────────────────────────────────────────

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

function getAllConfig() {
  return db.prepare('SELECT key, value FROM config ORDER BY key').all();
}

function deleteConfig(key) {
  db.prepare('DELETE FROM config WHERE key = ?').run(key);
}

// ── User Operations (user table; password_algo-aware) ────────────────────────
// Compatibility note: the old admin_users API is preserved on the new `user`
// table so existing routes keep working. bcrypt support activates when
// password_algo is 'bcrypt' (set by future password-change flows).

function verifyPassword(row, password) {
  if (row.password_algo === 'bcrypt') {
    try {
      // Lazy require: bcryptjs is only needed once bcrypt hashes exist.
      const bcrypt = require('bcryptjs');
      return bcrypt.compareSync(password, row.password_hash);
    } catch (_) {
      console.error('[db] bcryptjs not installed; cannot verify bcrypt password');
      return false;
    }
  }
  // Legacy: sha256-salt — transparently upgrade to bcrypt on success.
  const salt = row.salt || '';
  const ok = hashPassword(password, salt) === row.password_hash;
  if (ok) {
    try {
      const bcrypt = require('bcryptjs');
      db.prepare(`
        UPDATE user SET password_algo = 'bcrypt', password_hash = ?, salt = NULL,
                        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND password_algo = 'sha256-salt'
      `).run(bcrypt.hashSync(password, 10), row.id);
    } catch (_) {
      // Best-effort upgrade; login still succeeds.
    }
  }
  return ok;
}

function createAdminUser(username, password, role = 'user') {
  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  try {
    db.prepare(`
      INSERT INTO user (username, password_algo, password_hash, salt, role) 
      VALUES (?, 'sha256-salt', ?, ?, ?)
    `).run(username, passwordHash, salt, role === 'admin' ? 'admin' : 'user');
    return { ok: true };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { ok: false, error: 'Username already exists' };
    }
    return { ok: false, error: err.message };
  }
}

function verifyAdminUser(username, password) {
  const user = db.prepare('SELECT * FROM user WHERE username = ?').get(username);
  if (!user || !user.enabled) return false;
  return verifyPassword(user, password);
}

function changeAdminPassword(username, newPassword, exceptToken) {
  const salt = generateSalt();
  const passwordHash = hashPassword(newPassword, salt);

  const result = db.prepare(`
    UPDATE user SET password_algo = 'sha256-salt', password_hash = ?, salt = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE username = ?
  `).run(passwordHash, salt, username);

  if (result.changes > 0) {
    // 改密吊销该用户其他会话（保留当前会话，避免操作者自己被立即踢出）
    db.prepare('DELETE FROM sessions WHERE username = ? AND token != ?').run(username, exceptToken || '');
  }

  return result.changes > 0;
}

function getAdminUsers() {
  return db.prepare(
    'SELECT id, username, role, enabled, created_at, updated_at FROM user ORDER BY created_at'
  ).all();
}

// ── Session Operations ────────────────────────────────────────────────────────

// SQLite CURRENT_TIMESTAMP 格式为 'YYYY-MM-DD HH:MM:SS'（UTC）。
// expires_at 必须用同款格式存储，否则与 CURRENT_TIMESTAMP 做字符串比较时
// ISO 中间的 'T' 恒大于空格，导致过期判断失效、cleanup 也清不掉。
function toSqliteDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

const SESSION_ABSOLUTE_MAX_HOURS = 24 * 7; // 滑动续期的绝对上限：7 天

function createSession(username, expiresInHours = 24) {
  const token = generateToken();
  const expiresAt = toSqliteDatetime(new Date(Date.now() + expiresInHours * 60 * 60 * 1000));

  db.prepare(`
    INSERT INTO sessions (token, username, expires_at) 
    VALUES (?, ?, ?)
  `).run(token, username, expiresAt);

  return token;
}

function verifySession(token) {
  const session = db.prepare(`
    SELECT * FROM sessions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP
  `).get(token);

  if (!session) return null;

  // Extend session on each verification（滑动续期，但受 created_at + 7 天绝对上限约束）
  const createdAtMs = session.created_at
    ? Date.parse(String(session.created_at).replace(' ', 'T') + 'Z')
    : NaN;
  const slidingMs = Date.now() + 24 * 60 * 60 * 1000;
  const absoluteMs = Number.isFinite(createdAtMs)
    ? createdAtMs + SESSION_ABSOLUTE_MAX_HOURS * 60 * 60 * 1000
    : slidingMs;
  const newExpiresAt = toSqliteDatetime(new Date(Math.min(slidingMs, absoluteMs)));
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(newExpiresAt, token);

  return session;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP').run();
}

// ── Usage Stats Operations ────────────────────────────────────────────────────

function recordUsage(model, inputTokens, outputTokens, requestType = 'chat') {
  db.prepare(`
    INSERT INTO usage_stats (model, input_tokens, output_tokens, request_type) 
    VALUES (?, ?, ?, ?)
  `).run(model, inputTokens, outputTokens, requestType);
}

function getUsageStats(days = 7) {
  return db.prepare(`
    SELECT 
      DATE(timestamp) as date,
      model,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM usage_stats
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(timestamp), model
    ORDER BY date DESC, model
  `).all(days);
}

function getUsageByModel(days = 30) {
  return db.prepare(`
    SELECT 
      model,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM usage_stats
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY model
    ORDER BY request_count DESC
  `).all(days);
}

// ── Initialization ────────────────────────────────────────────────────────────

function migrateEnvToConfig() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();

    // Only migrate if not already in database
    if (!getConfig(key)) {
      setConfig(key, value);
    }
  }

  console.log('[db] Migrated .env config to database');
}

function initialize() {
  // Order matters: .env values must land in config BEFORE migrations run,
  // because migration 001 seeds the default account from the legacy token.
  migrateEnvToConfig();

  // Versioned schema + data migrations (schema_migration tracks progress)
  require('./migrations').runMigrations(db);

  // Create default admin user if not exists
  const existingUsers = getAdminUsers();
  if (existingUsers.length === 0) {
    createAdminUser('admin', 'admin123', 'admin');
    console.log('[db] Created default admin user: admin / admin123');
  }

  // 迁移旧版 ISO 格式 expires_at（'...T...Z'）为 SQLite datetime 格式，
  // 否则旧会话与 CURRENT_TIMESTAMP 字符串比较失效（'T' > ' ' 恒真）
  db.prepare(`
    UPDATE sessions SET expires_at = REPLACE(SUBSTR(expires_at, 1, 19), 'T', ' ')
    WHERE expires_at LIKE '%T%'
  `).run();

  // Cleanup expired sessions on startup
  cleanupExpiredSessions();

  console.log('[db] Database initialized at', DB_PATH);
}

module.exports = {
  // Config
  getConfig,
  setConfig,
  getAllConfig,
  deleteConfig,
  
  // Admin Users
  createAdminUser,
  verifyAdminUser,
  changeAdminPassword,
  getAdminUsers,
  
  // Sessions
  createSession,
  verifySession,
  deleteSession,
  cleanupExpiredSessions,
  
  // Usage Stats
  recordUsage,
  getUsageStats,
  getUsageByModel,
  
  // Init
  initialize,
  
  // Direct DB access for advanced operations
  db,
};
