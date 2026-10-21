import { request } from '@umijs/max';

/** 管理控制台会话 token 的 localStorage 键名。 */
const TOKEN_KEY = 'qoder_proxy_token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token);
};
export const clearToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
};

/** 「记住用户名」的 localStorage 键名（仅本机控制台使用；出于安全只存用户名，不存密码）。 */
const REMEMBER_KEY = 'qoder_proxy_remembered_login';

export type RememberedLogin = { username: string };

export const getRememberedLogin = (): RememberedLogin | null => {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { username?: string; password?: string };
    if (saved?.username) {
      // 旧版本曾明文保存 password：读到即覆写清除，绝不再返回密码字段。
      if (saved.password) {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username: saved.username }));
      }
      return { username: saved.username };
    }
  } catch {
    /* 数据损坏时按未记住处理 */
  }
  return null;
};

export const setRememberedLogin = (value: RememberedLogin | null): void => {
  if (value) localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username: value.username }));
  else localStorage.removeItem(REMEMBER_KEY);
};

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface Me {
  ok: boolean;
  authenticated?: boolean;
  authType: 'session' | 'legacy';
  user?: { id: number; username: string; role: string };
  role?: string;
  username?: string | null;
}

export interface QuotaSnapshot {
  remaining: number;
  total: number;
  usedPercentage: number;
  isQuotaExceeded: boolean;
  expiresAt?: number | null;
  buckets: UsageBucket[];
  queriedAt: number;
}

export interface Account {
  id: number;
  name: string;
  backendType: 'cn' | 'global';
  baseUrl: string | null;
  enabled: boolean;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  patFingerprint: string | null;
  verifyStatus: 'unverified' | 'verified' | 'failed';
  verifiedAt: string | null;
  weight: number;
  maxConcurrency: number;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastUsedAt: string | null;
  quota?: QuotaSnapshot | null;
}

export interface GatewayUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  keyCount: number;
  grantCount: number;
  hasQuota: boolean;
}

/** API Key 的 Qoder 调用覆盖配置，全部字段可空 = 使用账号/全局默认。 */
export interface KeyRuntime {
  baseUrl: string | null;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
}

export interface ApiKey {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  runtime: KeyRuntime | null;
}

export interface Quota {
  userId: number;
  dailyTokenLimit: number | null;
  dailyRequestLimit: number | null;
  monthlyTokenLimit: number | null;
  monthlyRequestLimit: number | null;
  updatedAt?: string;
}

export interface QuotaUsage {
  daily: { requests: number; tokens: number };
  monthly: { requests: number; tokens: number };
}

export interface UsageOverview {
  ok: boolean;
  today: { requests: number; tokens: number; errors: number };
  byDay: { date: string; requests: number; input_tokens: number; output_tokens: number }[];
  byModel: { model: string; requests: number; input_tokens: number; output_tokens: number }[];
  byUser: {
    user_id: number;
    username: string | null;
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }[];
  byAccount: {
    account_id: number;
    account_name: string | null;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    errors: number;
  }[];
  activeCounts: Record<string, number>;
}

export interface UsageRecord {
  id: number;
  ts: string;
  user_id: number | null;
  api_key_id: number | null;
  account_id: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  token_source: string;
  status: 'success' | 'error';
  error_code: string | null;
  duration_ms: number | null;
  stream: number;
  username: string | null;
  account_name: string | null;
}

/** 后端部分接口用 HTTP 200 + {ok:false,error} 表达业务失败，这里统一抛出。 */
function check<T>(data: T): T {
  const body = data as { ok?: boolean; error?: string };
  if (body && body.ok === false) {
    throw new Error(body.error || '请求失败');
  }
  return data;
}

// ── 认证 ─────────────────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
): Promise<{ ok: boolean; token?: string; mustChangePassword?: boolean; error?: string }> {
  return request('/admin/login', {
    method: 'POST',
    data: { username, password },
    skipErrorHandler: true,
  });
}

export async function logout(): Promise<void> {
  await request('/admin/logout', { method: 'POST', skipErrorHandler: true });
}

export async function getMe(options?: { skipErrorHandler?: boolean }): Promise<Me> {
  return request('/admin/me', { method: 'GET', ...options });
}

export async function changePassword(
  username: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return request('/admin/change-password', {
    method: 'POST',
    data: { username, newPassword },
    skipErrorHandler: true,
  });
}

// ── 账号 ─────────────────────────────────────────────────────────────────────

export async function listAccounts(): Promise<{ ok: boolean; accounts: Account[] }> {
  return check(await request('/admin/accounts', { method: 'GET' }));
}

export async function createAccount(body: {
  name: string;
  backendType: string;
  baseUrl?: string;
  pat: string;
  weight?: number;
  maxConcurrency?: number;
  remark?: string;
}): Promise<{ ok: boolean; account: Account }> {
  return check(await request('/admin/accounts', { method: 'POST', data: body }));
}

export async function updateAccount(
  id: number,
  body: {
    name?: string;
    backendType?: string;
    baseUrl?: string | null;
    enabled?: boolean;
    remark?: string | null;
    weight?: number;
    maxConcurrency?: number;
  },
): Promise<{ ok: boolean; account: Account }> {
  return check(await request(`/admin/accounts/${id}`, { method: 'PATCH', data: body }));
}

export async function deleteAccount(id: number): Promise<{ ok: boolean }> {
  return check(await request(`/admin/accounts/${id}`, { method: 'DELETE' }));
}

export async function updateAccountPat(
  id: number,
  pat: string,
): Promise<{ ok: boolean }> {
  return check(await request(`/admin/accounts/${id}/pat`, { method: 'POST', data: { pat } }));
}

export async function verifyAccount(
  id: number,
): Promise<{ ok: boolean; verifyStatus: string; error?: string; durationMs?: number }> {
  return request(`/admin/accounts/${id}/verify`, {
    method: 'POST',
    timeout: 120000,
  });
}

export interface UsageBucket {
  label: string;
  total: number;
  used: number;
  remaining: number;
  percentage: number;
}

export interface AccountUsage {
  buckets: UsageBucket[];
  totalUsagePercentage?: number | null;
  isQuotaExceeded?: boolean;
  expiresAt?: number | null;
}

export async function fetchAccountUsage(
  id: number,
): Promise<{ ok: boolean; usage?: AccountUsage; cached?: boolean; durationMs?: number }> {
  return request(`/admin/accounts/${id}/usage`, { method: 'POST', timeout: 120000 });
}

// ── 测试对话（管理员） ────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 账号目录条目：CLI 原始 ModelInfo 原样透传（value/displayName/priceFactor/isFree/...），
 * 并与 /v1/models 统一语义：id/value/displayName = 模型显示名称，modelId = CLI 内部代号。 */
export interface RawModelInfo {
  id?: string;
  modelId?: string;
  value: string;
  displayName?: string;
  description?: string;
  priceFactor?: number | null;
  isFree?: boolean;
  isReasoning?: boolean;
  isDefault?: boolean;
  isEnabled?: boolean;
  [key: string]: unknown;
}

export async function listModels(
  accountId?: number
): Promise<{ ok: boolean; source?: 'account' | 'static'; models: RawModelInfo[] }> {
  const qs = accountId ? `?accountId=${accountId}` : '';
  return check(await request(`/admin/models${qs}`, { method: 'GET' }));
}

/** 指定账号跑一次真实 CLI 对话，绕过调度器与配额统计。 */
export async function testChat(body: {
  accountId: number;
  model: string;
  messages: ChatTurn[];
}): Promise<{
  ok: boolean;
  content?: string;
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
  durationMs?: number;
  error?: string;
  code?: string;
}> {
  return request('/admin/test-chat', { method: 'POST', data: body, timeout: 180000 });
}

export interface StreamTestChatDone {
  ok: boolean;
  content?: string;
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
  durationMs?: number;
  error?: string;
  code?: string;
}

/** 流式版 testChat：SSE 增量回调 onDelta/onThinking，resolve 值为 done 汇总事件。signal 用于客户端中止。 */
export async function streamTestChat(
  body: { accountId: number; model: string; messages: ChatTurn[] },
  onDelta: (delta: string) => void,
  onThinking?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamTestChatDone> {
  // 裸 fetch 不走 umi 拦截器，必须手动带会话 token（adminGuard 要求 Bearer）
  const token = getToken();
  const res = await fetch('/admin/test-chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let payload: any = null;
    try {
      payload = await res.json();
    } catch (_) {
      // 非 JSON 错误体，走通用提示
    }
    const err: any = new Error(payload?.error?.message || `HTTP ${res.status}`);
    err.data = payload;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done: StreamTestChatDone = { ok: false, error: 'stream ended without summary' };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const event = JSON.parse(payload);
      if (event.type === 'delta' && typeof event.delta === 'string') {
        onDelta(event.delta);
      } else if (event.type === 'thinking' && typeof event.delta === 'string') {
        onThinking?.(event.delta);
      } else if (event.type === 'done') {
        done = event;
      }
    } catch (_) {
      // 忽略无法解析的心跳/杂散行
    }
  };

  while (true) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf);
  return done;
}

/**
 * 按需预热：切换模型/账号时后台补位该指纹的热进程（fire-and-forget）。
 * 服务端有 60s 冷却与池满/进行中门控，重复调用无副作用；
 * 失败静默（skipErrorHandler），绝不打扰用户操作。
 */
export async function prewarmChat(body: {
  accountId: number;
  model: string;
  stream: boolean;
}): Promise<{ ok: boolean; queued?: boolean; skipped?: string }> {
  return request('/admin/prewarm-chat', {
    method: 'POST',
    data: body,
    skipErrorHandler: true,
  });
}

// ── 用户 ─────────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<{ ok: boolean; users: GatewayUser[] }> {
  return check(await request('/admin/users', { method: 'GET' }));
}

export async function createUser(body: {
  username: string;
  password: string;
  role: string;
}): Promise<{ ok: boolean; user: GatewayUser }> {
  return check(await request('/admin/users', { method: 'POST', data: body }));
}

export async function updateUser(
  id: number,
  body: { role?: string; enabled?: boolean; password?: string },
): Promise<{ ok: boolean; user: GatewayUser }> {
  return check(await request(`/admin/users/${id}`, { method: 'PATCH', data: body }));
}

export async function deleteUser(id: number): Promise<{ ok: boolean }> {
  return check(await request(`/admin/users/${id}`, { method: 'DELETE' }));
}

// ── API 密钥 ─────────────────────────────────────────────────────────────────

export async function listUserKeys(
  userId: number,
): Promise<{ ok: boolean; keys: ApiKey[] }> {
  return check(await request(`/admin/users/${userId}/keys`, { method: 'GET' }));
}

/** 明文密钥返回一次，同时加密副本入库供事后查看。 */
export async function createUserKey(
  userId: number,
  body: {
    name?: string;
    expiresInDays?: number;
    runtime?: Partial<KeyRuntime> | null;
  },
): Promise<{ ok: boolean; apiKey: { id: number; key: string; keyPrefix: string } }> {
  return check(await request(`/admin/users/${userId}/keys`, { method: 'POST', data: body }));
}

/** 查看完整密钥（旧版仅哈希的密钥返回 409，不可查看）。 */
export async function revealUserKey(keyId: number): Promise<{ ok: boolean; key: string }> {
  return check(await request(`/admin/keys/${keyId}/secret`, { method: 'GET' }));
}

/** 更新密钥的调用覆盖配置，全空 = 恢复默认。 */
export async function updateKeyRuntime(
  keyId: number,
  runtime: Partial<KeyRuntime> | null,
): Promise<{ ok: boolean }> {
  return check(await request(`/admin/keys/${keyId}`, { method: 'PATCH', data: { runtime } }));
}

export interface RuntimeDefaults {
  baseUrl: string;
  reasoningEffort: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
}

/** 调用配置的当前生效默认值（config 表 → 环境变量 → 内置默认），供密钥表单预填。 */
export async function getRuntimeDefaults(): Promise<RuntimeDefaults> {
  const res = check<{ ok: boolean; defaults: RuntimeDefaults }>(
    await request('/admin/runtime-defaults', { method: 'GET' }),
  );
  return res.defaults;
}

export async function revokeKey(
  keyId: number,
  purge = false,
): Promise<{ ok: boolean; warning?: string }> {
  return check(
    await request(`/admin/keys/${keyId}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),
  );
}

// ── 授权与配额 ───────────────────────────────────────────────────────────────

export async function listGrants(
  userId: number,
): Promise<{ ok: boolean; accountIds: number[] }> {
  return check(await request(`/admin/users/${userId}/grants`, { method: 'GET' }));
}

export async function updateGrants(
  userId: number,
  accountIds: number[],
): Promise<{ ok: boolean; accountIds: number[] }> {
  return check(
    await request(`/admin/users/${userId}/grants`, {
      method: 'PUT',
      data: { accountIds },
    }),
  );
}

export async function getQuota(
  userId: number,
): Promise<{ ok: boolean; quota: Quota | null; usage: QuotaUsage }> {
  return check(await request(`/admin/users/${userId}/quota`, { method: 'GET' }));
}

export async function updateQuota(
  userId: number,
  body: {
    dailyTokenLimit: number | null;
    dailyRequestLimit: number | null;
    monthlyTokenLimit: number | null;
    monthlyRequestLimit: number | null;
  },
): Promise<{ ok: boolean; quota: Quota }> {
  return check(await request(`/admin/users/${userId}/quota`, { method: 'PUT', data: body }));
}

// ── 用量 ─────────────────────────────────────────────────────────────────────

export async function getUsageOverview(days = 14): Promise<UsageOverview> {
  return check(await request(`/admin/usage/overview?days=${days}`, { method: 'GET' }));
}

export async function getUsageRecords(params: {
  limit?: number;
  userId?: number | null;
}): Promise<{ ok: boolean; records: UsageRecord[] }> {
  return check(
    await request('/admin/usage/records', {
      method: 'GET',
      params: { limit: params.limit ?? 50, userId: params.userId ?? undefined },
    }),
  );
}

// ── 系统设置（legacy 接口） ──────────────────────────────────────────────────

export async function getEnvConfig(): Promise<{ ok: boolean; config: Record<string, string> }> {
  return check(await request('/admin/env-config', { method: 'GET' }));
}

export async function updateEnv(
  updates: Record<string, string>,
  deletes: string[] = [],
): Promise<{ ok: boolean }> {
  return check(
    await request('/admin/update-env', { method: 'POST', data: { updates, deletes } }),
  );
}

export interface RuntimeStatus {
  version: string;
  nodeVersion: string;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  port: number;
  bindHost: string;
  cliBackend: string;
}

export async function getRuntimeStatus(): Promise<{ ok: boolean; status: RuntimeStatus }> {
  return check(await request('/admin/runtime-status', { method: 'GET' }));
}

/** 热池全局统计（来自 GET /admin/warm-pool 的 stats）。 */
export interface WarmPoolStats {
  enabled: boolean;
  keys: number;
  idle: number;
  size: number;
  maxTotal: number;
  ttlMs: number;
  readyMs: number;
  keepaliveMs: number;
  keepaliveWindowMs: number;
  trackedSpecs: number;
}

/** 热池单条指纹（账号列由服务端从 PAT 反查，不回传 token）。 */
export interface WarmPoolKey {
  key: string;
  stream: boolean;
  accountId: number | null;
  accountName: string | null;
  idle: number;
  immature: number;
  oldestAgeMs: number | null;
  nextReclaimMs: number | null;
  lastSeenAgoMs: number | null;
  refillCooldownMs: number;
}

export async function getWarmPool(): Promise<{
  ok: boolean;
  stats: WarmPoolStats;
  keys: WarmPoolKey[];
}> {
  return check(await request('/admin/warm-pool', { method: 'GET' }));
}

/** 手动预热：key 省略则全部已登记指纹。返回实际补位数。 */
export async function prewarmWarmPool(key?: string): Promise<{ ok: boolean; warmed: number }> {
  return check(await request('/admin/warm-pool/prewarm', { method: 'POST', data: key ? { key } : {} }));
}

/** 驱逐单条指纹：杀其空闲热进程并停止保温。 */
export async function evictWarmPool(key: string): Promise<{ ok: boolean; killed: number }> {
  return check(await request('/admin/warm-pool/evict', { method: 'POST', data: { key } }));
}

/** 清空热池：杀掉全部空闲热进程并清空保温表。 */
export async function clearWarmPool(): Promise<{ ok: boolean; killed: number }> {
  return check(await request('/admin/warm-pool/clear', { method: 'POST', data: {} }));
}

/** 池参数（毫秒），由设置页「参数设置」弹窗提交，未提供的字段保持不变。 */
export interface WarmPoolConfigPayload {
  size?: number;
  maxTotal?: number;
  ttlMs?: number;
  readyMs?: number;
  keepaliveMs?: number;
  keepaliveWindowMs?: number;
}

/** 池参数热更新：立即生效并写入 .env，无需重启；返回新统计。 */
export async function updateWarmPoolConfig(
  payload: WarmPoolConfigPayload,
): Promise<{ ok: boolean; stats: WarmPoolStats }> {
  return check(await request('/admin/warm-pool/config', { method: 'POST', data: payload }));
}

// ── 控制面 daemon 常驻池（模型/用量查询） ─────────────────────────────────────

/** 常驻 daemon 单条（账号列由服务端从 PAT 反查，不回传 token）。 */
export interface DaemonPoolEntry {
  key: string;
  accountId: number | null;
  accountName: string | null;
  state: string;
  lastUsedAgoMs: number;
  nextReclaimMs: number;
}

export interface DaemonPoolStats {
  enabled: boolean;
  ttlMs: number;
  count: number;
}

export async function getDaemonPool(): Promise<{
  ok: boolean;
  stats: DaemonPoolStats;
  entries: DaemonPoolEntry[];
}> {
  return check(await request('/admin/daemon-pool', { method: 'GET' }));
}

/** daemon 池参数热更新：开关 + 空闲回收 TTL，立即生效并写入 .env。 */
export async function updateDaemonPoolConfig(payload: {
  enabled?: boolean;
  ttlMs?: number;
}): Promise<{ ok: boolean; stats: DaemonPoolStats }> {
  return check(await request('/admin/daemon-pool/config', { method: 'POST', data: payload }));
}

/** 手动回收常驻 daemon：key 省略则全部，下次查询自动重建。 */
export async function dropDaemonPool(key?: string): Promise<{ ok: boolean; dropped: number }> {
  return check(await request('/admin/daemon-pool/drop', { method: 'POST', data: key ? { key } : {} }));
}

// ── 全局模型参数（推理默认值） ─────────────────────────────────────────────────

/** 全局模型参数提交体：空串/空值表示清除回默认；未提供的字段保持不变。 */
export interface ModelDefaultsPayload {
  reasoningEffort?: string;
  contextWindow?: number | '';
  maxOutputTokens?: number | '';
  timeoutMs?: number | '';
}

/** 模型参数热更新：立即生效并写入 .env，无需重启；返回当前生效默认值。 */
export async function updateModelDefaults(
  payload: ModelDefaultsPayload,
): Promise<{ ok: boolean; defaults: RuntimeDefaults }> {
  return check(await request('/admin/model-defaults', { method: 'POST', data: payload }));
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  seq: number;
  ts: string;
  level: LogLevel;
  text: string;
}

export interface LogQuery {
  limit?: number;
  level?: 'all' | LogLevel;
  search?: string;
  since?: number;
}

export async function getLogs(
  params: LogQuery,
): Promise<{ ok: boolean; entries: LogEntry[]; latestSeq: number; total: number }> {
  return check(
    await request('/admin/logs', {
      method: 'GET',
      params: {
        limit: params.limit,
        level: params.level && params.level !== 'all' ? params.level : undefined,
        search: params.search || undefined,
        since: params.since,
      },
    }),
  );
}

export async function clearLogs(): Promise<{ ok: boolean }> {
  return check(await request('/admin/logs', { method: 'DELETE' }));
}

export async function restartServer(body: {
  port?: string;
  bindHost?: string;
  qoderBaseUrl?: string;
  allowedHosts?: string;
  allowedOrigins?: string;
}): Promise<{ ok: boolean }> {
  return request('/admin/restart', { method: 'POST', data: body, skipErrorHandler: true });
}
