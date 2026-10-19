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

/** 「记住密码」的 localStorage 键名（仅本机控制台使用）。 */
const REMEMBER_KEY = 'qoder_proxy_remembered_login';

export type RememberedLogin = { username: string; password: string };

export const getRememberedLogin = (): RememberedLogin | null => {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<RememberedLogin>;
    if (saved?.username && saved?.password) {
      return { username: saved.username, password: saved.password };
    }
  } catch {
    /* 数据损坏时按未记住处理 */
  }
  return null;
};

export const setRememberedLogin = (value: RememberedLogin | null): void => {
  if (value) localStorage.setItem(REMEMBER_KEY, JSON.stringify(value));
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

export async function listModels(
  accountId?: number
): Promise<{ ok: boolean; source?: 'account' | 'static'; models: { id: string; name: string; rate?: number | null; isFree?: boolean }[] }> {
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

export async function setProxyApiKey(key: string): Promise<{ ok: boolean }> {
  return check(await request('/admin/set-proxy-api-key', { method: 'POST', data: { key } }));
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
