'use strict';

/**
 * OpenAPI 3 spec 自动生成。
 *
 * 路径列表来自运行时自省 Express 路由表（新增路由无需登记，自动出现）；
 * 每条路由的 summary / 参数 / 请求体说明由下方 META 表按「METHOD /path」
 * 匹配补充——未登记元数据的路由以骨架形式出现在文档中。
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** 递归收集 app 挂载的全部 method|path（数组路径取第一个规范形式）。 */
function collectRoutes(layer, prefix, out) {
  if (layer.route) {
    const route = layer.route;
    for (const method of METHODS) {
      if (route.methods && route.methods[method]) {
        out.add(`${method.toUpperCase()} ${prefix}${route.path === '/' && prefix ? '' : route.path}`);
      }
    }
    return;
  }
  const stack = layer.handle && layer.handle.stack ? layer.handle.stack : null;
  if (!stack) return;
  const mount = typeof layer.path === 'string' ? layer.path : (layer.regexp && layer.regexp.fast_slash ? '' : '');
  for (const child of stack) collectRoutes(child, prefix + mount, out);
}

// ── 元数据表 ──────────────────────────────────────────────────────────────────
// tag 取值：system / gateway / v1 / auth / accounts / users / keys / usage / ops
const META = {
  // 公开
  'GET /health': { summary: '存活探针', tag: 'system', responses: { 200: '{ ok: true }' } },
  'GET /openapi.json': { summary: '本文档（自动生成）', tag: 'system' },

  // 登录与会话
  'POST /admin/login': {
    summary: '登录换取会话 token',
    tag: 'auth',
    body: { username: 'string', password: 'string' },
    responses: { 200: '{ ok, token, username, role }', 401: '凭据错误', 429: '失败次数过多已锁定' },
  },
  'GET /admin/verify-token': {
    summary: '校验会话 token 有效性', tag: 'auth',
    responses: { 200: '{ ok, valid, username, role }', 401: '无效或过期' },
  },
  'POST /admin/logout': { summary: '注销当前会话', tag: 'auth', responses: { 200: '{ ok: true }' } },
  'POST /admin/change-password': {
    summary: '修改自己的登录密码', tag: 'auth',
    body: { currentPassword: 'string', newPassword: 'string' },
    responses: { 200: '{ ok: true }', 400: '新密码不满足强度或旧密码错误' },
  },
  'GET /admin/me': {
    summary: '当前会话身份（任意登录用户）', tag: 'auth',
    responses: { 200: '{ ok, username, role, mustChangePassword }' },
  },

  // Qoder 账号
  'GET /admin/accounts': { summary: '账号列表（PAT 指纹脱敏）', tag: 'accounts' },
  'POST /admin/accounts': {
    summary: '新增 Qoder 账号（PAT 以 AES-256-GCM 加密入库）', tag: 'accounts',
    body: { name: 'string', pat: 'string', 'baseUrl?': 'string' },
  },
  'GET /admin/accounts/:id': { summary: '账号详情', tag: 'accounts', params: { id: '账号 ID' } },
  'PATCH /admin/accounts/:id': {
    summary: '更新账号（名称/接入点/启停等，字段可选）', tag: 'accounts',
    params: { id: '账号 ID' },
  },
  'DELETE /admin/accounts/:id': { summary: '删除账号', tag: 'accounts', params: { id: '账号 ID' } },
  'POST /admin/accounts/:id/pat': {
    summary: '更换账号 PAT', tag: 'accounts', params: { id: '账号 ID' },
    body: { pat: 'string' },
  },
  'POST /admin/accounts/:id/verify': {
    summary: '验证账号 PAT 连通性', tag: 'accounts', params: { id: '账号 ID' },
    responses: { 200: '{ ok, models? }', 502: '上游不可达' },
  },
  'POST /admin/accounts/:id/usage': {
    summary: '查询该账号的上游用量', tag: 'accounts', params: { id: '账号 ID' },
    responses: { 200: '上游返回的用量数据', 502: '上游不可达' },
  },

  // 模型与调用测试
  'GET /admin/models': { summary: '经 CLI 后端拉取可用模型列表', tag: 'v1' },
  'POST /admin/test-chat': {
    summary: '非流式调用测试（管理台走完整链路）', tag: 'v1',
    body: { model: 'string', messages: 'OpenAI 消息数组', 'stream?': 'boolean', 'reasoning_effort?': 'low|medium|high' },
  },
  'POST /admin/test-chat/stream': {
    summary: '流式调用测试（SSE）', tag: 'v1', body: '同 /admin/test-chat',
  },

  // 用户
  'GET /admin/users': { summary: '用户列表', tag: 'users' },
  'POST /admin/users': {
    summary: '创建用户', tag: 'users', body: { username: 'string', password: 'string', 'role?': 'user|admin' },
  },
  'PATCH /admin/users/:id': {
    summary: '更新用户（密码/角色/启停）', tag: 'users', params: { id: '用户 ID' },
  },
  'DELETE /admin/users/:id': { summary: '删除用户（连同其密钥/授权）', tag: 'users', params: { id: '用户 ID' } },

  // API Key
  'GET /admin/users/:id/keys': { summary: '用户的 API Key 列表（明文仅创建时可见）', tag: 'keys', params: { id: '用户 ID' } },
  'POST /admin/users/:id/keys': {
    summary: '为用户签发 qk-* 密钥', tag: 'keys', params: { id: '用户 ID' },
    body: { 'name?': 'string', 'overrides?': 'baseUrl/reasoningEffort/contextWindow/maxOutputTokens/timeoutMs' },
    responses: { 200: '{ ok, key: "qk-…"（唯一一次明文）}' },
  },
  'GET /admin/keys/:keyId/secret': {
    summary: '查看密钥明文（需 admin）', tag: 'keys', params: { keyId: '密钥 ID' },
  },
  'PATCH /admin/keys/:keyId': {
    summary: '更新密钥（名称/启停/运行时覆盖）', tag: 'keys', params: { keyId: '密钥 ID' },
  },
  'DELETE /admin/keys/:keyId': {
    summary: '吊销/删除密钥（?purge=1 物理删除）', tag: 'keys', params: { keyId: '密钥 ID' },
    responses: { 200: '{ ok, warning? }——吊销最后一个有效密钥时网关回到本机开放模式' },
  },

  // 授权与配额
  'GET /admin/users/:id/grants': { summary: '用户可用的账号授权列表', tag: 'users', params: { id: '用户 ID' } },
  'PUT /admin/users/:id/grants': {
    summary: '整体替换用户授权', tag: 'users', params: { id: '用户 ID' },
    body: { accountIds: 'number[]' },
  },
  'GET /admin/users/:id/quota': { summary: '用户配额设置', tag: 'users', params: { id: '用户 ID' } },
  'PUT /admin/users/:id/quota': {
    summary: '设置配额（日/月，tokens/请求数，null=不限）', tag: 'users', params: { id: '用户 ID' },
    body: { 'dailyTokenLimit?': 'number', 'dailyRequestLimit?': 'number', 'monthlyTokenLimit?': 'number', 'monthlyRequestLimit?': 'number' },
  },

  // 用量
  'GET /admin/usage/overview': { summary: '用量总览（按用户/账号/模型聚合）', tag: 'usage' },
  'GET /admin/usage/records': {
    summary: '用量明细（分页）', tag: 'usage',
    query: { 'page?': 'number', 'pageSize?': 'number', 'userId?': 'number', 'accountId?': 'number', 'search?': 'string' },
  },
  'GET /usage/local': { summary: '本进程估算用量（网关级凭据）', tag: 'usage' },
  'POST /usage/reset-local': { summary: '清零本进程估算用量', tag: 'usage' },

  // 运行时与运维
  'GET /admin/runtime-defaults': { summary: '运行时默认参数（思考深度/上下文窗口等）', tag: 'ops' },
  'GET /admin/runtime-status': { summary: '运行时状态（后端/预热池/版本）', tag: 'ops' },
  'GET /admin/logs': { summary: '服务端日志缓冲（增量 since/level/search）', tag: 'ops', query: { 'limit?': 'number', 'level?': 'info|warn|error', 'search?': 'string', 'since?': 'number' } },
  'DELETE /admin/logs': { summary: '清空日志缓冲', tag: 'ops' },
  'GET /admin/env-config': { summary: '全部配置（config 表 + .env 同步值）', tag: 'ops' },
  'POST /admin/update-env': {
    summary: '更新配置并自动重启', tag: 'ops',
    body: { 'updates?': '键值对象', 'deletes?': 'string[]' },
  },
  'POST /admin/restart': { summary: '重启服务进程', tag: 'ops' },

  // /v1 网关（OpenAI / Anthropic 兼容）
  'GET /v1/models': { summary: '模型列表（OpenAI 兼容）', tag: 'v1' },
  'POST /v1/chat/completions': {
    summary: 'Chat Completions（OpenAI 兼容，SSE 支持 stream）', tag: 'v1',
    body: { model: 'string', messages: 'array', 'stream?': 'boolean', 'reasoning_effort?': 'low|medium|high' },
  },
  'POST /v1/messages': {
    summary: 'Messages（Anthropic 兼容，SSE 支持 stream，thinking 块回传）', tag: 'v1',
    body: { model: 'string', max_tokens: 'number', messages: 'array', 'stream?': 'boolean', 'thinking?': 'object' },
  },
};

function describeBody(body) {
  if (!body) return undefined;
  const props = {};
  const required = [];
  for (const [key, type] of Object.entries(body)) {
    const optional = key.endsWith('?');
    const name = optional ? key.slice(0, -1) : key;
    props[name] = { type: type.startsWith('number') ? 'number' : type.startsWith('array') || type.includes('数组') ? 'array' : 'string' };
    if (!optional) required.push(name);
  }
  return { type: 'object', properties: props, required: required.length ? required : undefined };
}

function buildOpenApi(app) {
  const routes = new Set();
  if (app && app._router) {
    for (const layer of app._router.stack) collectRoutes(layer, '', routes);
  }

  const paths = {};
  const known = new Set();
  for (const key of Object.keys(META)) known.add(key);

  // 自省到的路由 + 元数据路由合并（自省为准，元数据补充未挂载者以备文档用）
  const all = new Set([...routes, ...known].filter((k) => !k.startsWith('GET /ui') && !k.startsWith('GET /v1/v1')));
  for (const key of all) {
    const space = key.indexOf(' ');
    const method = key.slice(0, space).toLowerCase();
    const routePath = key.slice(space + 1);
    const meta = META[key] || {};
    const item = {
      tags: [meta.tag || 'misc'],
      summary: meta.summary || '(自动收集，待补充说明)',
      security: key.startsWith('GET /health') || key === 'POST /admin/login' || routePath.startsWith('/v1') || routePath.startsWith('/usage') ? [] : [{ bearerAuth: [] }],
      responses: {
        200: { description: (meta.responses && meta.responses['200']) || '成功' },
      },
    };
    for (const [code, desc] of Object.entries(meta.responses || {})) {
      if (code !== '200') item.responses[code] = { description: desc };
    }
    if (meta.params) {
      item.parameters = Object.entries(meta.params).map(([name, desc]) => ({
        name, in: 'path', required: true, schema: { type: 'string' }, description: desc,
      }));
    }
    if (meta.query) {
      item.parameters = item.parameters || [];
      for (const [name, desc] of Object.entries(meta.query)) {
        item.parameters.push({ name, in: 'query', required: false, schema: { type: 'string' }, description: desc });
      }
    }
    if (meta.body && method !== 'get') {
      item.requestBody = {
        required: true,
        content: { 'application/json': { schema: describeBody(meta.body) } },
      };
    }
    if (routePath.startsWith('/v1') || routePath.startsWith('/usage')) {
      item.parameters = (item.parameters || []).concat([
        { name: 'Authorization', in: 'header', required: false, schema: { type: 'string' }, description: 'Bearer <qk- key>（存在任一密钥时必填）' },
      ]);
      if (method === 'post') {
        item.parameters.push({ name: 'x-api-key', in: 'header', required: false, schema: { type: 'string' }, description: 'Anthropic 系客户端密钥头' });
      }
    }
    const specPath = routePath.replace(/:([A-Za-z]+)/g, '{$1}');
    paths[specPath] = paths[specPath] || {};
    paths[specPath][method] = item;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Qoder CLI Proxy API',
      description:
        'Qoder 订阅 → OpenAI/Anthropic 兼容本地多账号网关。\n\n' +
        '- `/v1/*`：OpenAI / Anthropic 兼容接口，凭据为管理台签发的 `qk-*` 用户密钥\n' +
        '- `/admin/*`：管理控制台 API，凭据为 `POST /admin/login` 换取的会话 token（Swagger UI 右上角 Authorize 填入）\n' +
        '- 本文档由服务端运行时自动生成：路径来自路由表自省，说明来自内置元数据表',
      version: require('../package.json').version,
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: '管理 API：POST /admin/login 的 token；网关：qk-* 密钥' },
      },
    },
    paths,
  };
}

module.exports = { buildOpenApi };
