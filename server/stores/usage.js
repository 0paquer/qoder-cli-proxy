'use strict';

/**
 * Usage facts store: append-only usage_record + aggregate reads.
 *
 * Stats are always derived from usage_record — nothing is written back
 * to user/account rows, keeping the fact table the single source of truth.
 */

const { db } = require('../db');

/**
 * Append one usage fact. All identifiers are optional (SET NULL on delete);
 * tokens default to 0. token_source: 'actual' | 'estimated'.
 */
function recordUsage({
  userId = null,
  apiKeyId = null,
  accountId = null,
  model = '',
  inputTokens = 0,
  outputTokens = 0,
  tokenSource = 'estimated',
  status = 'success',
  errorCode = null,
  durationMs = null,
  stream = false,
}) {
  db.prepare(`
    INSERT INTO usage_record
      (ts, user_id, api_key_id, account_id, model, input_tokens, output_tokens,
       token_source, status, error_code, duration_ms, stream)
    VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    apiKeyId,
    accountId,
    String(model || ''),
    Math.max(0, Number(inputTokens) || 0),
    Math.max(0, Number(outputTokens) || 0),
    tokenSource === 'actual' ? 'actual' : 'estimated',
    status === 'error' ? 'error' : 'success',
    errorCode || null,
    durationMs === null || durationMs === undefined ? null : Math.max(0, Number(durationMs) || 0),
    stream ? 1 : 0
  );
}

/** Aggregate helper: SUM(tokens) and COUNT(*) over an interval. */
function totalsSince(whereSql, params, sinceSql) {
  return db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
    FROM usage_record
    WHERE ${whereSql} AND ts >= ${sinceSql}
  `).get(...params);
}

/**
 * A user's consumption for quota enforcement.
 * Day boundary = local midnight; month boundary = first of month.
 */
function getQuotaUsage(userId) {
  // ts is stored in UTC (CURRENT_TIMESTAMP): take the local midnight/month
  // boundary, then convert it back to UTC so the comparison matches stored ts.
  const daily = totalsSince('user_id = ?', [userId], "datetime('now', 'localtime', 'start of day', 'utc')");
  const monthly = totalsSince('user_id = ?', [userId], "datetime('now', 'localtime', 'start of month', 'utc')");
  return {
    daily: { requests: daily.requests, tokens: daily.tokens },
    monthly: { requests: monthly.requests, tokens: monthly.tokens },
  };
}

/** Usage grouped by day (optionally scoped to one user). */
function getUsageByDay(days = 7, userId = null) {
  const scope = userId ? 'AND user_id = ?' : '';
  const params = userId ? [days, userId] : [days];
  return db.prepare(`
    SELECT
      DATE(ts, 'localtime') AS date,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM usage_record
    WHERE ts >= datetime('now', '-' || ? || ' days') ${scope}
    GROUP BY DATE(ts, 'localtime')
    ORDER BY date DESC
  `).all(...params);
}

function getUsageByModel(days = 30, userId = null) {
  const scope = userId ? 'AND user_id = ?' : '';
  const params = userId ? [days, userId] : [days];
  return db.prepare(`
    SELECT
      model,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM usage_record
    WHERE ts >= datetime('now', '-' || ? || ' days') ${scope}
    GROUP BY model
    ORDER BY requests DESC
  `).all(...params);
}

function getUsageByUser(days = 30) {
  return db.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      COUNT(r.id) AS requests,
      COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(r.output_tokens), 0) AS output_tokens
    FROM usage_record r
    LEFT JOIN user u ON u.id = r.user_id
    WHERE r.ts >= datetime('now', '-' || ? || ' days')
    GROUP BY r.user_id
    ORDER BY requests DESC
  `).all(days);
}

function getUsageByAccount(days = 30) {
  return db.prepare(`
    SELECT
      a.id AS account_id,
      a.name AS account_name,
      COUNT(r.id) AS requests,
      COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END), 0) AS errors
    FROM usage_record r
    LEFT JOIN qoder_account a ON a.id = r.account_id
    WHERE r.ts >= datetime('now', '-' || ? || ' days')
    GROUP BY r.account_id
    ORDER BY requests DESC
  `).all(days);
}

/** Recent records for the admin UI (newest first). */
function getRecentRecords(limit = 50, userId = null) {
  const scope = userId ? 'WHERE r.user_id = ?' : '';
  const params = userId ? [userId, limit] : [limit];
  return db.prepare(`
    SELECT
      r.id, r.ts, r.user_id, r.api_key_id, r.account_id, r.model,
      r.input_tokens, r.output_tokens, r.token_source, r.status,
      r.error_code, r.duration_ms, r.stream,
      u.username, a.name AS account_name
    FROM usage_record r
    LEFT JOIN user u ON u.id = r.user_id
    LEFT JOIN qoder_account a ON a.id = r.account_id
    ${scope}
    ORDER BY r.id DESC
    LIMIT ?
  `).all(...params);
}

/** Platform-wide totals since server start-of-day (dashboard headline). */
function getTodayTotals() {
  const row = totalsSince('1=1', [], "datetime('now', 'localtime', 'start of day', 'utc')");
  const errors = db.prepare(`
    SELECT COUNT(*) AS n FROM usage_record
    WHERE status = 'error' AND ts >= datetime('now', 'localtime', 'start of day', 'utc')
  `).get();
  return { requests: row.requests, tokens: row.tokens, errors: errors.n };
}

module.exports = {
  recordUsage,
  getQuotaUsage,
  getUsageByDay,
  getUsageByModel,
  getUsageByUser,
  getUsageByAccount,
  getRecentRecords,
  getTodayTotals,
};
