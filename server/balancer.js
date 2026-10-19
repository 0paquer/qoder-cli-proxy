'use strict';

/**
 * Multi-account load balancer.
 *
 * Responsibilities:
 *   - Pick an available account for a request (SQL-filtered candidates,
 *     weighted random among those whose in-memory concurrency is not full).
 *   - Enforce per-account max_concurrency with in-memory semaphores
 *     (concurrency is transient state — never persisted).
 *   - Track failures and put accounts into cooldown with exponential
 *     backoff; cooldown IS persisted (schedule.cooldown_until) so a restart
 *     doesn't immediately hammer a failing account again.
 *   - Support explicit exclusion (retry loops must never retry the same
 *     account that just failed).
 *
 * Selection algorithm (deliberately simple, no recursion):
 *   candidates = getAvailableAccounts(backendType, excludeIds)  — SQL side:
 *     enabled, matching backend, not in cooldown, oldest-used first
 *   → drop candidates whose concurrency is full
 *   → weighted random by schedule.weight (weight 0 = paused, never picked
 *     unless it is the only candidate left)
 */

const { getAvailableAccounts, markAccountUsed, setAccountCooldown, recordAccountFailure, recordAccountSuccess } = require('./stores/accounts');

const FAILURE_COOLDOWN_BASE_MS = 30 * 1000;
const FAILURE_COOLDOWN_MAX_MS = 10 * 60 * 1000;

// Quota / credit exhaustion is persistent: retrying after a short backoff just
// burns another request. When a failure matches these patterns the account is
// cooled down for PERSISTENT_FAILURE_COOLDOWN_MS on the FIRST failure.
const PERSISTENT_FAILURE_PATTERNS = [
  /credit/i,
  /insufficient/i,
  /quota/i,
  /limit\s*reached/i,
  /usage\s*limit/i,
  /额度/i,
];
const PERSISTENT_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

function isPersistentFailure(error) {
  const text =
    typeof error === 'string'
      ? error
      : [error && error.code, error && error.message].filter(Boolean).join(' ');
  if (!text) return false;
  return PERSISTENT_FAILURE_PATTERNS.some((re) => re.test(text));
}

/** accountId → current in-flight request count */
const activeCounts = new Map();

/**
 * accountId → 额度调度因子（0..1）。由额度快照写入时更新（后台预刷新/
 * 手动查询），请求遇额度类持久失败时置 0；无快照的账号不在表内 = 因子 1
 * （不干预配置权重）。effectiveWeight = schedule.weight × factor。
 * 失败触发的 0 带 expiresAt（与持久冷却同寿命），到期自动复位为 1——
 * 防止 CLI 引擎（额度查询恒失败）或误判的持久失败把账号锁死到进程重启；
 * 快照写入的因子无过期，由下一次真实额度查询纠正。
 */
const quotaFactors = new Map();

/** factor 取值 0..1；非法值忽略。opts.expiresAt 为毫秒时间戳，到期该因子自动失效。 */
function setQuotaFactor(accountId, factor, opts = {}) {
  const value = Number(factor);
  if (!Number.isFinite(value) || value < 0 || value > 1) return;
  quotaFactors.set(accountId, { value, expiresAt: opts.expiresAt || null });
}

function getQuotaFactor(accountId) {
  const hit = quotaFactors.get(accountId);
  if (!hit) return 1;
  if (hit.expiresAt && Date.now() >= hit.expiresAt) {
    quotaFactors.delete(accountId);
    return 1;
  }
  return hit.value;
}

/** 观测快照（runtime-status / 调试）。 */
function getQuotaFactors() {
  const out = {};
  for (const [id, hit] of quotaFactors) out[id] = getQuotaFactor(id);
  return out;
}

function activeCount(accountId) {
  return activeCounts.get(accountId) || 0;
}

function concurrencyFull(account) {
  const max = Number(account.maxConcurrency) || 0;
  if (max <= 0) return false; // 0 = unlimited
  return activeCount(account.id) >= max;
}

/**
 * Weighted random pick. Higher weight → proportionally more traffic.
 * Zero-weight accounts are skipped unless nothing else is available.
 */
function pickWeighted(candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const positive = candidates.filter((c) => (Number(c.weight) || 0) > 0);
  const pool = positive.length ? positive : candidates;
  const total = pool.reduce((sum, c) => sum + (Number(c.weight) || 0), 0);

  let roll = Math.random() * total;
  for (const candidate of pool) {
    roll -= Number(candidate.weight) || 0;
    if (roll <= 0) return candidate;
  }
  return pool[pool.length - 1];
}

/**
 * Pick the next account.
 * @param {object} opts
 * @param {string} [opts.backendType='cn']
 * @param {number[]} [opts.excludeIds] accounts to skip (already tried)
 * @param {number[]|null} [opts.allowedIds] ACL restriction; null = no restriction
 * @returns {object|null} account row or null when nothing is available
 */
function pickAccount({ backendType = 'cn', excludeIds = [], allowedIds = null } = {}) {
  let candidates = getAvailableAccounts(backendType, excludeIds);
  if (allowedIds) {
    const allowed = new Set(allowedIds);
    candidates = candidates.filter((account) => allowed.has(account.id));
  }
  candidates = candidates.filter((account) => !concurrencyFull(account));
  // 剩余额度参与权重：effectiveWeight = 配置 weight × 额度因子。
  // factor = 0（额度耗尽/持久失败）直接剔除——不依赖 pickWeighted 的全零兜底，
  // 否则全零时 factor 0 账号仍会被选中并注定失败，与"0 = 不调度"语义矛盾；
  // 全部剔空则返回 null，由调用方给出 no_available_account 明确错误。
  candidates = candidates.filter((account) => getQuotaFactor(account.id) > 0);
  candidates = candidates.map((account) => {
    const factor = getQuotaFactor(account.id);
    if (factor === 1) return account;
    return { ...account, weight: (Number(account.weight) || 0) * factor };
  });
  return pickWeighted(candidates);
}

/**
 * Reserve a concurrency slot. Call releaseAccount() when the request ends
 * (success or failure).
 */
function acquireAccount(accountId) {
  activeCounts.set(accountId, activeCount(accountId) + 1);
}

function releaseAccount(accountId) {
  const next = Math.max(0, activeCount(accountId) - 1);
  if (next === 0) activeCounts.delete(accountId);
  else activeCounts.set(accountId, next);
}

/** Snapshot for the admin UI / health reporting. */
function getActiveCounts() {
  return Object.fromEntries(activeCounts);
}

/**
 * Cooldown duration after n consecutive failures (exponential backoff).
 * A single failure only increments the counter — transient blips should not
 * eject an account. From the 2nd consecutive failure on: 30s, 60s, 120s …
 * capped at 10 minutes.
 */
function cooldownForFailures(consecutiveFailures) {
  const failures = Number(consecutiveFailures) || 0;
  if (failures < 2) return 0;
  const ms = FAILURE_COOLDOWN_BASE_MS * 2 ** Math.min(failures - 2, 10);
  return Math.min(ms, FAILURE_COOLDOWN_MAX_MS);
}

/**
 * Report a request outcome. Persistence lives in the stores; this only
 * sequences the schedule state transitions.
 */
function reportSuccess(accountId) {
  recordAccountSuccess(accountId);
}

function reportFailure(accountId, error) {
  let cooldownUntil = null;
  // Read-modify-write is fine here: single-process server, better-sqlite3 is sync.
  const { db } = require('./db');
  const row = db
    .prepare('SELECT consecutive_failures FROM qoder_account_schedule WHERE account_id = ?')
    .get(accountId);
  const failures = row ? (row.consecutive_failures || 0) + 1 : 1;
  const persistent = error ? isPersistentFailure(error) : false;
  // 额度类失败是明确的耗尽信号：立即把调度因子打到 0（不等下次快照），
  // 与 1 小时冷却双保险；因子与冷却同寿命到期复位，快照写入可随时覆盖纠正。
  if (persistent) setQuotaFactor(accountId, 0, { expiresAt: Date.now() + PERSISTENT_FAILURE_COOLDOWN_MS });
  const ms = persistent
    ? Math.max(PERSISTENT_FAILURE_COOLDOWN_MS, cooldownForFailures(failures))
    : cooldownForFailures(failures);
  if (ms > 0) {
    cooldownUntil = new Date(Date.now() + ms).toISOString();
    setAccountCooldown(accountId, cooldownUntil);
  }
  recordAccountFailure(accountId);
  return { failures, cooldownUntil, persistent };
}

/**
 * Mark an account as chosen: reserve the slot and update last_used_at.
 * Pair with releaseAccount() in a finally block.
 */
function beginRequest(accountId) {
  acquireAccount(accountId);
  markAccountUsed(accountId);
}

/**
 * Pick + reserve in one step. Returns null when nothing is available.
 * @returns {object|null}
 */
function checkoutAccount({ backendType = 'cn', excludeIds = [], allowedIds = null } = {}) {
  const account = pickAccount({ backendType, excludeIds, allowedIds });
  if (!account) return null;
  beginRequest(account.id);
  return account;
}

module.exports = {
  acquireAccount,
  beginRequest,
  checkoutAccount,
  cooldownForFailures,
  getActiveCounts,
  getQuotaFactor,
  getQuotaFactors,
  isPersistentFailure,
  pickAccount,
  releaseAccount,
  reportFailure,
  reportSuccess,
  setQuotaFactor,
  FAILURE_COOLDOWN_BASE_MS,
  FAILURE_COOLDOWN_MAX_MS,
};
