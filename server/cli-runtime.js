/**
 * CLI 运行时工具集：Agent SDK 拉起 qoderclicn/qodercli 进程所需的公共能力。
 *
 * 对话执行已全部由 server/qoder-session.js（@qoder-ai/qoder-agent-sdk）承担，
 * 本模块只保留 SDK 依赖的底层函数：
 *   - resolveCliCommand / buildSpawnCommand —— Windows .cmd shim 解析，
 *     SDK 的 spawnQoderCLIProcess 钩子据此把命令解析为 node + bundle
 *   - probeCliOptions —— --help 探测 CLI 支持的长选项集合
 *   - normalizeMessages / buildPrompt —— OpenAI 消息 → CLI prompt 构造
 *   - getCliBackend / buildChildEnv —— cn/global 双线路与子进程环境
 *   - usageFacts —— usage 对象归一（全 0 视同未报告）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { AppError } = require('./errors');
const { buildToolSystemPrompt } = require('./tool-parser');

/**
 * Resolve the CLI backend configuration.
 *
 * Supports two backends:
 *   - "cn"     → qoderclicn  (Qoder CN, auth in .qoderworkcn)
 *   - "global" → qodercli    (Qoder international, auth in .qoder)
 *
 * The backend is selected per-request (multi-account) via `requested`,
 * falling back to CLI_BACKEND env var (default: "cn").
 * Individual fields can be overridden with CLI_COMMAND and CLI_TOKEN.
 */
function getCliBackend(requested) {
  const backend = (requested || process.env.CLI_BACKEND || 'cn').toLowerCase();

  if (backend === 'global') {
    return {
      name: 'global',
      command: process.env.CLI_COMMAND || 'qodercli',
      bundlePackage: '@qoder-ai/qodercli',
      bundlePath: path.join('bundle', 'qodercli.js'),
      homeDir: path.join(process.env.USERPROFILE || process.env.HOME || '~', '.qoder'),
      tokenEnvVar: 'QODER_PAT',
    };
  }

  // Default: cn
  return {
    name: 'cn',
    command: process.env.CLI_COMMAND || 'qoderclicn',
    bundlePackage: '@qodercn-ai/qoderclicn',
    bundlePath: path.join('bundle', 'qoderclicn.js'),
    homeDir: path.join(process.env.USERPROFILE || process.env.HOME || '~', '.qoderworkcn'),
    tokenEnvVar: 'QODERCN_PERSONAL_ACCESS_TOKEN',
  };
}

// OpenAI's `developer` role is the successor of `system` — treat both as
// system-level instructions routed through --append-system-prompt.
function isSystemRole(role) {
  return role === 'system' || role === 'developer';
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function normalizeMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      // Format tool results with their call ID for context continuity
      const id = message.tool_call_id || 'unknown';
      const content = normalizeContent(message.content);
      return {
        role: 'tool',
        content: `<tool_result id="${id}">\n${content}\n</tool_result>`,
      };
    }
    if (message.role === 'assistant' && message.tool_calls) {
      // Format previous assistant tool_calls for context continuity
      const parts = [];
      if (message.content) {
        parts.push(normalizeContent(message.content));
      }
      for (const call of message.tool_calls) {
        const name = call.function?.name || call.name || 'unknown';
        const args = call.function?.arguments || JSON.stringify(call.arguments || {});
        parts.push(`[assistant called tool: ${name} with arguments: ${args}]`);
      }
      return { role: 'assistant', content: parts.join('\n') };
    }
    return {
      role: message.role,
      content: normalizeContent(message.content),
    };
  });
}

function buildPrompt(messages, tools, hasSystemToolPrompt = false) {
  const normalized = normalizeMessages(messages);
  const parts = [];

  const hasSystemPrompt = normalized.some((m) => m.role === 'system');
  const hasTools = tools && tools.length > 0 && !hasSystemToolPrompt;

  if (hasTools) {
    parts.push(buildToolSystemPrompt(tools));
  } else if (hasSystemPrompt) {
    // Client already told the model who to be — don't add anything.
    // The JSON conversation blob below is enough context.
  } else {
    // No system prompt, no tools — bare request. Add minimal guidance.
    parts.push('Answer the latest user message in the conversation context below.');
  }

  parts.push('');
  parts.push(JSON.stringify({ messages: normalized }, null, 2));
  return parts.join('\n');
}

/**
 * 归一 usage 对象 → {inputTokens, outputTokens} | null。
 *
 * 容忍字段别名（input_tokens / inputTokens / prompt_tokens 等）。CLI/SDK
 * 偶发回全 0 的 usage（qodercn 的 result/modelUsage 均为 0）——视同"未报告"
 * 返回 null，让调用方走估算；否则接口 usage 与用量记录会恒 0。
 */
function usageFacts(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens =
    Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens) || 0;
  const outputTokens =
    Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens) || 0;
  if (!inputTokens && !outputTokens) return null;
  return { inputTokens, outputTokens };
}

function ensureRuntimeHome(rootDir) {
  const runtimeHome = path.join(rootDir, '.runtime', 'qodercn-home');
  fs.mkdirSync(path.join(runtimeHome, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'AppData', 'Local'), { recursive: true });
  return runtimeHome;
}

function buildChildEnv(rootDir, token, backend, baseUrl) {
  ensureRuntimeHome(rootDir);
  const cfg = backend || getCliBackend();
  // Don't override HOME/USERPROFILE — let the CLI find its auth config
  // in the real home directory (same as running the CLI directly).
  const env = { ...process.env };
  // Set the backend-specific token env var (per-account token for multi-account)
  if (token) {
    env[cfg.tokenEnvVar] = token;
  }
  // Per-account base URL wins; process.env is the legacy fallback
  const effectiveBaseUrl = baseUrl || process.env.QODERCN_BASE_URL;
  if (effectiveBaseUrl) {
    env.QODERCN_BASE_URL = effectiveBaseUrl;
  } else {
    delete env.QODERCN_BASE_URL;
  }
  return env;
}

function buildSpawnCommand(command, args, backend) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const cfg = backend || getCliBackend();
    const bundle = path.join(
      path.dirname(command),
      'node_modules',
      cfg.bundlePackage,
      cfg.bundlePath
    );
    if (fs.existsSync(bundle)) {
      return {
        command: process.execPath,
        args: [bundle, ...args],
      };
    }
    // cmd.exe does not honor Node's argv escaping: shell metacharacters in any
    // argument would be interpreted by the shell (injection / mangling). Refuse
    // instead — point CLI_COMMAND at the CLI's JS bundle to bypass cmd.exe.
    const all = [command, ...args.map(String)];
    const unsafe = all.find((part) => /[&|<>^"%!]/.test(part));
    if (unsafe) {
      throw new AppError(
        500,
        'cli_spawn_unsafe',
        'CLI is a .cmd/.bat shim but its JS bundle was not found, so it must run via ' +
          'cmd.exe — and an argument contains shell metacharacters, which is unsafe. ' +
          'Set CLI_COMMAND to the CLI\'s bundle .js path to bypass cmd.exe.'
      );
    }
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

// CLI 参数支持探测：不同版本的 qoderclicn/qodercli 支持的选项不同（例如部分
// 版本没有 --reasoning-effort / --context-window / --max-output-tokens，传入会
// 直接报 "unknown option" 退出）。首次构建参数前跑一次 --help，解析支持的长选
// 项集合；探测失败则返回 null，调用方按旧行为全部传参。
const cliOptionSupport = new Map();

function probeCliOptions(backend) {
  const cached = cliOptionSupport.get(backend.name);
  if (cached !== undefined) return cached;
  try {
    const command = resolveCliCommand(process.env.CLI_COMMAND || backend.command, process.env);
    const spec = buildSpawnCommand(command, ['--help'], backend);
    const result = spawnSync(spec.command, spec.args, {
      timeout: 20000,
      encoding: 'utf8',
      env: buildChildEnv(process.cwd(), null, backend),
      windowsHide: true,
    });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    const opts = new Set();
    for (const match of text.matchAll(/--([a-z][a-z0-9-]*)/gi)) {
      opts.add(match[1].toLowerCase());
    }
    cliOptionSupport.set(backend.name, opts.size > 0 ? opts : null);
    return opts.size > 0 ? opts : null;
  } catch (_) {
    cliOptionSupport.set(backend.name, null);
    return null;
  }
}

function hasPathSeparator(command) {
  return /[\\/]/.test(command);
}

function pathEnv(env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

function executableExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function resolveCliCommand(command, env = process.env) {
  if (process.platform !== 'win32' || hasPathSeparator(command)) return command;

  const commandExt = path.extname(command);
  const defaultExts = ['.cmd', '.exe', '.bat', '.com'];
  const envExts = (env.PATHEXT || '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const candidateExts = commandExt
    ? ['']
    : [...defaultExts, ...envExts.filter((ext) => !defaultExts.includes(ext))];

  for (const dir of pathEnv(env).split(';').filter(Boolean)) {
    for (const ext of candidateExts) {
      const candidate = path.join(dir, command + ext);
      if (executableExists(candidate)) return candidate;
    }
  }

  return command;
}

module.exports = {
  buildChildEnv,
  buildPrompt,
  buildSpawnCommand,
  getCliBackend,
  normalizeMessages,
  probeCliOptions,
  resolveCliCommand,
  usageFacts,
};
