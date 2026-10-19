// logger 必须最先加载：包装 console.* 才能捕获 db 初始化等启动日志
require('./logger');

// ── .env bootstrap ───────────────────────────────────────────────────────────
// 1) .env 不存在：以 .env.example 为模板创建，并自动生成随机 PROXY_API_KEY。
//    固定默认密钥是安全反模式（所有部署密钥相同等于裸奔），因此每部署随机；
//    之后可在 .env 或管理台「系统设置」中修改，下次启动生效。
// 2) 加载 .env 到 process.env（不覆盖外部已显式注入的变量，如服务/容器环境）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const envPath = path.join(__dirname, '..', '.env');

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch (_) {
    // Ignore .env load errors
  }
}

function ensureDefaultEnv() {
  if (fs.existsSync(envPath)) return null;
  const examplePath = path.join(__dirname, '..', '.env.example');
  let content = fs.existsSync(examplePath)
    ? fs.readFileSync(examplePath, 'utf-8')
    : '# Qoder CLI Proxy configuration\n';
  const key = 'qp-' + crypto.randomBytes(24).toString('hex');
  if (/^PROXY_API_KEY=.*$/m.test(content)) {
    content = content.replace(/^PROXY_API_KEY=.*$/m, `PROXY_API_KEY=${key}`);
  } else {
    content = content.replace(/\s*$/, '\n')
      + '# Gateway key (auto-generated; edit here or in the admin console System Settings)\n'
      + `PROXY_API_KEY=${key}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf-8');
  return key;
}

const generatedGatewayKey = ensureDefaultEnv();
loadEnvFile();
if (generatedGatewayKey) {
  console.log(
    '[env] .env not found — created from template with a randomly generated PROXY_API_KEY. ' +
      'Edit .env (or admin console → System Settings) to change it; takes effect on next start.'
  );
}

// Windows 下隐藏子进程控制台窗口：@qoder-ai/qoder-agent-sdk 内部的 spawn/execFile
// （startDaemon 拉起 CLI 加载模型目录、IDE 探测等）未传 windowsHide，当本服务进程
// 自身没有控制台（保存设置后 detached 自重启、计划任务/服务方式启动等）时，
// 每次拉起 CLI 都会在桌面闪一个 cmd 窗口。必须在 require('./app') 之前打补丁——
// SDK 在模块加载期捕获 spawn 引用。只补缺省值，不覆盖显式传入的 windowsHide。
const cp = require('child_process');
const { spawn: origSpawn, execFile: origExecFile } = cp;
cp.spawn = function (command, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return origSpawn(command, { ...args, windowsHide: args.windowsHide ?? true });
  }
  return origSpawn(command, args, {
    ...options,
    windowsHide: (options && options.windowsHide) ?? true,
  });
};
cp.execFile = function (file, args, options, callback) {
  if (typeof args === 'function') {
    callback = args;
    args = undefined;
    options = undefined;
  } else if (args && !Array.isArray(args)) {
    callback = options;
    options = args;
    args = undefined;
  } else if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  return origExecFile(file, args, {
    ...options,
    windowsHide: (options && options.windowsHide) ?? true,
  }, callback);
};

// Initialize database
const db = require('./db');
db.initialize();

// config 表是设置页编辑的真源：同步到 process.env，保证 PORT 等
// 运行时直接读 env 的模块在「保存设置 → 自动重启」后拿到新值。
// .env 中存在但 config 表没有的键保持原值（新加进 .env 的自定义变量）。
for (const row of db.getAllConfig()) {
  if (row.key && row.value !== undefined && row.value !== null) {
    process.env[row.key] = String(row.value);
  }
}

const { createApp } = require('./app');
const { log } = require('./logger');
const { isProxyAuthEnabled } = require('./auth');
const { getCliBackend } = require('./cli-runtime');

const HOST = db.getConfig('BIND_HOST') || process.env.BIND_HOST || '127.0.0.1';
const PORT = Number(db.getConfig('PORT') || process.env.PORT || 3000);

const app = createApp();

// Self-restart grace: after /admin/update-env spawns a replacement process and
// exits, the old socket may linger for a moment. Retry instead of dying
// silently (stdio is 'ignore', so a crashed replacement used to be invisible).
const LISTEN_MAX_RETRIES = 20;
const LISTEN_RETRY_DELAY_MS = 500;

function startServer(attempt = 0) {
  const server = app.listen(PORT, HOST, () => {
    const backend = getCliBackend();
    log(`Qoder CLI Proxy listening on http://${HOST}:${PORT}`);
    log('Qoder backend', {
      name: backend.name,
      command: backend.command,
      home: backend.homeDir,
    });
    log('security', {
      proxy_api_key: isProxyAuthEnabled() ? 'enabled' : 'not set',
      cross_origin: 'loopback origins only',
      server_tool_execution: /^(1|true|yes)$/i.test(process.env.SERVER_TOOL_EXECUTION || '')
        ? 'ENABLED'
        : 'off',
    });
    if (!isProxyAuthEnabled()) {
      log(
        'note: PROXY_API_KEY is not set, so any process on this machine can use the proxy. ' +
          'Set it in .env to require a key.'
      );
    }
    // The Host/Origin checks in localOnlyGuard only defend the loopback-by-default
    // posture. Once the proxy binds a non-loopback address, every host and origin
    // is accepted unless explicitly configured — surface that loudly.
    const loopback = ['localhost', '::1'].includes(HOST) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(HOST);
    if (!loopback) {
      log('WARNING: BIND_HOST is non-loopback. Host and Origin checks are OPEN to any value —', {
        bind_host: HOST,
        recommendation:
          'Set ALLOWED_HOSTS and ALLOWED_ORIGINS explicitly, keep PROXY_API_KEY configured, ' +
          'and never expose the admin console to untrusted networks.',
      });
    }
    if (isProxyAuthEnabled() && !loopback && String(process.env.ALLOWED_HOSTS || '').trim() === '') {
      log('WARNING: ALLOWED_HOSTS is empty on a non-loopback bind. DNS-rebinding protection is off.');
    }
    // 曾启用过 API Key 凭据设施、但当前零有效 key 且未设 PROXY_API_KEY：
    // 网关已回落到开放模式（与 auth.js gatewayGuard 的开放判定同条件），必须显式告警
    try {
      const { db } = require('./db');
      const total = db.prepare('SELECT COUNT(*) AS n FROM api_key').get().n;
      const active = db.prepare('SELECT COUNT(*) AS n FROM api_key WHERE revoked_at IS NULL').get().n;
      if (total > 0 && active === 0 && !isProxyAuthEnabled()) {
        log(
          'WARNING: all API keys are revoked/absent and PROXY_API_KEY is not set — ' +
            'the /v1 gateway is OPEN to any process on this machine. ' +
            'Create a new key or set PROXY_API_KEY to close it.'
        );
      }
    } catch {
      /* 告警失败不影响启动 */
    }
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempt < LISTEN_MAX_RETRIES) {
      log(`port ${PORT} busy (self-restart grace?), retrying`, { attempt: attempt + 1 });
      setTimeout(() => startServer(attempt + 1), LISTEN_RETRY_DELAY_MS);
      return;
    }
    log('listen failed', { code: err && err.code, message: err && err.message });
    process.exitCode = 1;
  });
}

startServer();
