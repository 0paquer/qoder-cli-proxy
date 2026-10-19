const util = require('util');
const { redact } = require('./redact');

// ── 内存日志环形缓冲（/admin/logs 数据源）───────────────────────────────────
// 包装 console.*：所有模块（logger、db、warm-pool 等直接用 console 的）
// 输出统一进缓冲，控制台页面无需 shell 即可查看完整服务端输出。
const MAX_LOG_ENTRIES = 2000;
const entries = [];
let seq = 0;

function pushEntry(level, args) {
  seq += 1;
  const text = args.length === 1 ? String(args[0]) : util.format(...args);
  entries.push({ seq, ts: new Date().toISOString(), level, text });
  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }
}

const original = {
  info: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// stdout 统一加 ISO 时间戳前缀（shell/日志文件排障用）；
// 缓冲条目一律不带时间戳——时间由条目 ts 字段唯一承载，前端日志页
// 左侧时间列只显示这一个时间，避免「左列 + 正文」双重时间。
function emit(level, args) {
  const line = `[${new Date().toISOString()}] ${util.format(...args)}`;
  if (level === 'warn') original.warn(line);
  else if (level === 'error') original.error(line);
  else original.info(line);
}

console.log = (...args) => {
  try {
    pushEntry('info', args);
  } catch (_) {
    // 缓冲失败不影响真实输出
  }
  emit('info', args);
};
console.warn = (...args) => {
  try {
    pushEntry('warn', args);
  } catch (_) {}
  emit('warn', args);
};
console.error = (...args) => {
  try {
    pushEntry('error', args);
  } catch (_) {}
  emit('error', args);
};

/**
 * 结构化日志：可选 data（脱敏后输出）。统一走包装后的 console.log——
 * 缓冲条目无时间戳（时间取自 ts 字段），stdout 前缀由包装层统一添加。
 */
function log(message, data) {
  if (data === undefined) {
    console.log(message);
    return;
  }
  console.log(message, redact(data));
}

/**
 * 查询缓冲日志。从最新往回过滤、反转回时间正序；
 * since（上次返回的 latestSeq）用于增量拉取。
 */
function getLogs({ limit = 500, level = 'all', search = '', since = 0 } = {}) {
  const term = String(search || '').toLowerCase();
  const sinceSeq = Number(since) || 0;
  const max = Math.min(Math.max(Number(limit) || 500, 1), MAX_LOG_ENTRIES);
  const out = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.seq <= sinceSeq) break;
    if (level !== 'all' && entry.level !== level) continue;
    if (term && !entry.text.toLowerCase().includes(term)) continue;
    out.push(entry);
    if (out.length >= max) break;
  }
  return { entries: out.reverse(), latestSeq: seq, total: entries.length };
}

function clearLogs() {
  entries.length = 0;
}

module.exports = {
  log,
  getLogs,
  clearLogs,
};
