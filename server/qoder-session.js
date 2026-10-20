/**
 * 唯一对话引擎：基于 @qoder-ai/qoder-agent-sdk 实现对话执行，对外接口
 * （runQoderCnCli / runQoderCnCliStream / loadAccountUsage /
 * loadModelCatalog）由 server/qoder-engine.js 统一导出。
 *
 * 工作方式：SDK 协议（--input-format stream-json）驱动会话，prompt 走
 * stdin 传输（不受 Windows 命令行长度限制）；底层经 spawnQoderCLIProcess
 * 钩子拉起 qoderclicn 进程（与 warm-pool 预热进程复用同一 spawn 路径）。
 *
 *   - PAT 通过 SDK 一次性 auth payload 文件注入，不落环境变量。
 *   - persistSession=false，一次性查询不写会话存档。
 *   - CN VPC 端点同时写入 QODERCN_VPC_ENDPOINT（CN）与 QODER_VPC_ENDPOINT
 *     （Global），兼容两种 CLI 构建。
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, accessToken } = require('@qoder-ai/qoder-agent-sdk');
const daemonPool = require('./daemon-pool');
const { AppError } = require('./errors');
const { redactString } = require('./redact');
const { resolveModelRoute } = require('./models');
const cli = require('./cli-runtime');
const warmPool = require('./warm-pool');

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4000;

// OpenAI 的 developer 角色按 system 处理。
function isSystemRole(role) {
  return role === 'system' || role === 'developer';
}

function betaText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('');
}

/**
 * 提取 assistant 消息里的思考内容（thinking 块）。CLI 的 stream-json 协议
 * 会把 reasoning 模型（reasoning_effort 开启）的思考过程以 content 数组中的
 * thinking 块（流式为 thinking_delta 事件）下发；SDK 对块类型是开放透传，
 * 这里按需收集，不收集则为空串。
 */
function betaThinking(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''))
    .filter(Boolean)
    .join('');
}

/**
 * baseUrl 指向 VPC 专属域时提取域名供 SDK/CLI 端点覆盖。
 * https://chery-nextai.vpc.qoder.com.cn → chery-nextai.vpc.qoder.com.cn
 */
function vpcDomainFromBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const host = new URL(baseUrl).host;
    return /\.vpc\.qoder\.com\.cn$/i.test(host) ? host : null;
  } catch (_) {
    return null;
  }
}

function buildSdkEnv(baseUrl) {
  const env = {};
  const effectiveBaseUrl = baseUrl || process.env.QODERCN_BASE_URL;
  if (effectiveBaseUrl) {
    env.QODERCN_BASE_URL = effectiveBaseUrl;
    const vpcDomain = vpcDomainFromBaseUrl(effectiveBaseUrl);
    if (vpcDomain) {
      // CLI 按构建版本读取不同变量名，两个都写以兼容 CN/Global。
      env.QODERCN_VPC_ENDPOINT = vpcDomain;
      env.QODER_VPC_ENDPOINT = vpcDomain;
    }
  }
  return env;
}

/**
 * SDK 默认 spawn `qodercli`；用 spawnQoderCLIProcess 钩子复用 cli-runtime
 * 的命令解析（Windows .cmd shim → node + bundle）。SDK 计算好的参数
 * （stream-json 协议等）原样透传。
 *
 * 接入预热池：同指纹（账号 + 参数 + env）请求优先取热进程（省 4-14s
 * bundle 加载），进程用完即弃（SDK abort 语义），取走/冷启动的同时
 * 学习式补位下一个热进程。QODER_WARM_POOL=0 可整体关闭。
 *
 * 仅对话路径入池（ctx.pool=true）。控制面查询（模型/用量）已迁至
 * daemon-pool.js 的独立常驻 daemon 池，不走本池、互不挤占名额。
 */
function buildSpawnCli(backend, ctx = {}) {
  return (sdkOptions) => {
    const command = cli.resolveCliCommand(
      process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command
    );
    const spec = cli.buildSpawnCommand(command, sdkOptions.args, backend);
    const attachAbort = (childLike) => {
      const signal = sdkOptions.signal;
      if (signal) {
        if (signal.aborted) childLike.kill();
        else signal.addEventListener('abort', () => childLike.kill(), { once: true });
      }
      return childLike;
    };
    const poolSpec = {
      command: spec.command,
      args: spec.args,
      env: sdkOptions.env,
      cwd: sdkOptions.cwd || process.cwd(),
      token: ctx.token,
    };

    if (ctx.pool && warmPool.isEnabled() && ctx.token) {
      const key = warmPool.keyFor(poolSpec);
      const warmed = warmPool.defaultPool.acquire(key);
      if (warmed) {
        // 热路径：取走即用；立即为下一个同指纹请求补位。
        warmPool.defaultPool.offer(key, poolSpec);
        return attachAbort(warmed);
      }
      // 冷路径：学习式预热——下一个同指纹请求享受热启动。
      warmPool.defaultPool.offer(key, poolSpec);
    }

    const child = spawn(spec.command, spec.args, {
      cwd: sdkOptions.cwd || process.cwd(),
      env: sdkOptions.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return attachAbort({
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      kill: (signalArg) => child.kill(signalArg),
      on: (event, listener) => child.on(event, listener),
      once: (event, listener) => child.once(event, listener),
      off: (event, listener) => child.off(event, listener),
    });
  };
}

// 推理参数经 extraArgs 透传给 CLI，支持集合复用 cli-runtime 的探测缓存，
// 避免旧版 CLI 不认识选项直接 "unknown option" 退出。
function buildExtraArgs({ reasoningEffort, contextWindow, maxOutputTokens }, backend) {
  const supported = cli.probeCliOptions(backend);
  const cliSupports = (name) => !supported || supported.has(name);
  const extra = {};
  if (reasoningEffort && cliSupports('reasoning-effort')) {
    extra['reasoning-effort'] = reasoningEffort;
  }
  if (contextWindow && cliSupports('context-window')) {
    extra['context-window'] = String(contextWindow);
  }
  if (maxOutputTokens && cliSupports('max-output-tokens')) {
    extra['max-output-tokens'] = String(maxOutputTokens);
  }
  return Object.keys(extra).length ? extra : null;
}

/**
 * 构造 prompt 与 system prompt：cli-runtime 的消息归一化与工具协议判定。
 * system 走 SDK 的 preset+append（对齐 --append-system-prompt）。
 */
function buildRequestParts({ messages, tools }) {
  const normalized = cli.normalizeMessages(messages);
  const systemParts = normalized
    .filter((m) => isSystemRole(m.role))
    .map((m) => m.content)
    .filter(Boolean);
  const nonSystem = normalized.filter((m) => !isSystemRole(m.role));
  const appendSystemPrompt = systemParts.join('\n\n');
  const hasSystemToolPrompt = systemParts.some((content) => /\[Tool Protocol\]/.test(content));
  const prompt = cli.buildPrompt(nonSystem, tools, hasSystemToolPrompt);
  return { prompt, appendSystemPrompt };
}

function mapSdkError(error, { backend, stderrTail, timedOut, clientAborted }) {
  if (error instanceof AppError) return error;
  if (clientAborted) {
    return new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
  }
  if (timedOut) {
    return new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`);
  }
  const sdkCode = error && error.code;
  if (sdkCode === 'ENOENT') {
    return new AppError(502, 'cli_not_found', `${backend.command} is not installed or not on PATH.`);
  }
  const detail = redactString(stderrTail || (error && error.message) || String(error)).trim();
  const suffix = detail ? ` ${detail.slice(-400)}` : '';
  return new AppError(502, 'upstream_error', `${backend.command} failed.${suffix}`);
}

function requireToken(backend, token) {
  const effectiveToken = token || process.env[backend.tokenEnvVar];
  if (!effectiveToken) {
    throw new AppError(
      401,
      'cli_token_missing',
      `No Qoder account is available: no account exists in the registry and ${backend.tokenEnvVar} ` +
        'is not set. Add an account in the admin console (Accounts page), or keep ' +
        `${backend.tokenEnvVar} in .env for legacy single-account mode.`,
      'authentication_error'
    );
  }
  return effectiveToken;
}

/**
 * 组装 SDK query() 的 options。stream=true 时开启增量事件。
 */
function buildQueryOptions({
  backend,
  token,
  baseUrl,
  rootDir,
  model,
  appendSystemPrompt,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  signal,
  stream,
  stderrRef,
  pool = true,
}) {
  const controller = new AbortController();
  const extraArgs = buildExtraArgs({ reasoningEffort, contextWindow, maxOutputTokens }, backend);

  const options = {
    auth: accessToken(token),
    cwd: rootDir,
    model,
    // 关闭内置工具：代理的工具调用是提示词层模拟，等价于 CLI 的 --tools=。
    tools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // 一次性查询：不写会话存档，无法 resume（代理无会话语义）。
    persistSession: false,
    includePartialMessages: Boolean(stream),
    abortController: controller,
    env: buildSdkEnv(baseUrl),
    spawnQoderCLIProcess: buildSpawnCli(backend, { token, pool }),
    stderr: (data) => {
      stderrRef.value = stderrRef.value
        ? `${stderrRef.value}${data}`.slice(-STDERR_TAIL_BYTES)
        : String(data).slice(-STDERR_TAIL_BYTES);
    },
  };
  if (appendSystemPrompt) {
    options.systemPrompt = { type: 'preset', preset: 'qodercli', append: appendSystemPrompt };
  }
  if (extraArgs) {
    options.extraArgs = extraArgs;
  }
  return { options, controller };
}

/**
 * 运行一次 SDK 会话并归集结果。返回 { text, usage, resultMessage }。
 * 超时/取消/上游错误统一映射为 AppError。
 */
async function runSdkSession({ prompt, options, controller, timeoutMs, signal, backend, stderrRef }) {
  const timeout = Number(timeoutMs || process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let resultMessage = null;
  let assistantText = '';
  let assistantThinking = '';
  let outputBytes = 0;

  const appendOutput = (text) => {
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new AppError(502, 'upstream_output_too_large', 'Qoder CN CLI output exceeded the limit.');
    }
    return text;
  };

  try {
    const q = query({ prompt, options });
    for await (const message of q) {
      if (!message || typeof message !== 'object') continue;
      if (message.type === 'stream_event') {
        // 非流式路径不消费增量事件；流式路径在 runQoderCnCliStream 中处理。
        continue;
      }
      if (message.type === 'assistant') {
        const text = betaText(message.message);
        if (text) {
          appendOutput(text);
          assistantText = text; // 同一轮 assistant 事件为累计快照，取最后一条
        }
        const thinking = betaThinking(message.message);
        if (thinking) assistantThinking = thinking; // 累计快照，同样取最后一条
      } else if (message.type === 'result') {
        resultMessage = message; // result 为终止消息，流随后关闭
      }
    }
  } catch (error) {
    throw mapSdkError(error, {
      backend,
      stderrTail: stderrRef ? stderrRef.value : '',
      timedOut,
      clientAborted: Boolean(signal && signal.aborted),
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }

  if (signal && signal.aborted) {
    throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
  }
  if (timedOut) {
    throw new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`);
  }

  return { resultMessage, assistantText, thinkingText: assistantThinking };
}

function finalizeResult({ resultMessage, assistantText, backend }) {
  if (resultMessage && resultMessage.subtype && resultMessage.subtype !== 'success') {
    const errors = Array.isArray(resultMessage.errors) ? resultMessage.errors.filter(Boolean).join('; ') : '';
    const detail = redactString(errors).trim();
    const suffix = detail ? ` ${detail.slice(-400)}` : '';
    throw new AppError(
      502,
      'upstream_error',
      `${backend.command} failed (${resultMessage.subtype}).${suffix}`
    );
  }

  const resultText =
    resultMessage && typeof resultMessage.result === 'string' && resultMessage.result.trim()
      ? resultMessage.result
      : assistantText;
  if (!resultText.trim()) {
    throw new AppError(502, 'empty_upstream_output', 'Qoder CN SDK session returned no assistant content.');
  }

  // usageFacts 统一口径：CLI/SDK 偶发回全 0 usage，视同"未报告"走估算，
  // 否则接口 usage 与用量记录恒 0。
  const usage = cli.usageFacts(resultMessage && resultMessage.usage);
  return { text: resultText, usage };
}

function reportUsage(onUsage, usage) {
  if (!usage || typeof onUsage !== 'function') return;
  try {
    onUsage(usage);
  } catch (_) {
    // Usage reporting must never break the response path.
  }
}

/**
 * Run the CLI once, non-streaming. Resolves with the assistant text.
 */
async function runQoderCnCli({
  messages,
  model,
  tools,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  timeoutMs,
  signal,
  rootDir = process.cwd(),
  token,
  baseUrl,
  backendType,
  onUsage,
  onThinking,
}) {
  const backend = cli.getCliBackend(backendType);
  const effectiveToken = requireToken(backend, token);
  const modelRoute = resolveModelRoute(model);
  const { prompt, appendSystemPrompt } = buildRequestParts({ messages, tools });
  const stderrRef = { value: '' };

  const { options, controller } = buildQueryOptions({
    backend,
    token: effectiveToken,
    baseUrl,
    rootDir,
    model: modelRoute.cliModel,
    appendSystemPrompt,
    reasoningEffort: reasoningEffort || modelRoute.reasoningEffort || process.env.QODERCN_REASONING_EFFORT,
    contextWindow: contextWindow || process.env.QODERCN_CONTEXT_WINDOW,
    maxOutputTokens: maxOutputTokens || process.env.QODERCN_MAX_OUTPUT_TOKENS,
    timeoutMs,
    signal,
    stream: false,
    stderrRef,
  });

  const { resultMessage, assistantText, thinkingText } = await runSdkSession({
    prompt,
    options,
    controller,
    timeoutMs,
    signal,
    backend,
    stderrRef,
  });
  const { text, usage } = finalizeResult({ resultMessage, assistantText, backend });
  // 非流式没有增量概念：思考全文在会话结束时一次性回调（若调用方关心）。
  if (thinkingText && typeof onThinking === 'function') {
    try {
      onThinking(thinkingText);
    } catch (_) {
      // Thinking reporting must never break the response path.
    }
  }
  reportUsage(onUsage, usage);
  return text;
}

/**
 * Stream via SDK incremental events. Calls onDelta(textChunk) with incremental
 * text deltas and resolves with the full assistant text.
 */
async function runQoderCnCliStream({
  messages,
  model,
  tools,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  timeoutMs,
  signal,
  rootDir = process.cwd(),
  onDelta,
  onThinking,
  token,
  baseUrl,
  backendType,
  onUsage,
}) {
  const backend = cli.getCliBackend(backendType);
  const effectiveToken = requireToken(backend, token);
  const modelRoute = resolveModelRoute(model);
  const { prompt, appendSystemPrompt } = buildRequestParts({ messages, tools });
  const stderrRef = { value: '' };

  const { options, controller } = buildQueryOptions({
    backend,
    token: effectiveToken,
    baseUrl,
    rootDir,
    model: modelRoute.cliModel,
    appendSystemPrompt,
    reasoningEffort: reasoningEffort || modelRoute.reasoningEffort || process.env.QODERCN_REASONING_EFFORT,
    contextWindow: contextWindow || process.env.QODERCN_CONTEXT_WINDOW,
    maxOutputTokens: maxOutputTokens || process.env.QODERCN_MAX_OUTPUT_TOKENS,
    timeoutMs,
    signal,
    stream: true,
    stderrRef,
  });

  const timeout = Number(timeoutMs || process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let resultMessage = null;
  let assistantText = '';
  let assistantThinking = '';
  let emitted = '';
  let thinkingEmitted = false;
  let outputBytes = 0;

  const emitDelta = (chunk, kind = 'text') => {
    if (!chunk) return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new AppError(502, 'upstream_output_too_large', 'Qoder CN CLI output exceeded the limit.');
    }
    if (kind === 'thinking') {
      thinkingEmitted = true;
      if (typeof onThinking !== 'function') return;
      try {
        onThinking(chunk);
      } catch (_) {
        // Client connection may already be gone — keep draining the stream.
      }
      return;
    }
    emitted += chunk;
    try {
      onDelta(chunk);
    } catch (_) {
      // Client connection may already be gone — keep draining the stream.
    }
  };

  try {
    const q = query({ prompt, options });
    for await (const message of q) {
      if (!message || typeof message !== 'object') continue;
      if (message.type === 'stream_event') {
        const event = message.event;
        if (!event || event.type !== 'content_block_delta' || !event.delta) continue;
        if (
          event.delta.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          emitDelta(event.delta.text);
        } else if (
          event.delta.type === 'thinking_delta' &&
          typeof event.delta.thinking === 'string'
        ) {
          // reasoning 模型的思考增量；调用方未订阅时仅计数不回调。
          emitDelta(event.delta.thinking, 'thinking');
        }
      } else if (message.type === 'assistant') {
        const text = betaText(message.message);
        if (text) {
          // assistant 是累计快照，emitDelta 已按增量计数；这里只取全文，
          // 不再累加 outputBytes（否则双计、多轮重复累计会提前触发 10MB 上限）
          assistantText = text;
        }
        const thinking = betaThinking(message.message);
        if (thinking) assistantThinking = thinking;
      } else if (message.type === 'result') {
        resultMessage = message;
      }
    }
  } catch (error) {
    throw mapSdkError(error, {
      backend,
      stderrTail: stderrRef.value,
      timedOut,
      clientAborted: Boolean(signal && signal.aborted),
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }

  if (signal && signal.aborted) {
    throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
  }
  if (timedOut) {
    throw new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`);
  }

  const { text, usage } = finalizeResult({ resultMessage, assistantText, backend });

  // Fallback: no incremental deltas arrived but the session succeeded —
  // emit the full text so streaming clients are not left with an empty
  // message.
  if (!emitted && text) {
    try {
      onDelta(text);
    } catch (_) {
      // Ignore — resolve regardless.
    }
  }

  // Thinking fallback：增量一个没来但最终快照里有思考内容（CLI 聚合行为
  // 差异兜底），一次性补发全文，保证订阅方拿到完整思考。
  if (!thinkingEmitted && assistantThinking && typeof onThinking === 'function') {
    try {
      onThinking(assistantThinking);
    } catch (_) {
      // Ignore — resolve regardless.
    }
  }

  reportUsage(onUsage, usage);
  return text;
}

/**
 * 账号额度查询：复用 SDK 控制协议的 get_usage_info（daemon 面应答）。
 *
 * 实证（2026-10-17 探针）：streaming input 永不产出消息即可拿到配额，
 * 全程零对话轮次、零 credits 消耗（session.total_credits=0），冷启动
 * 约 10s。返回 { ok, usage }；usage 为归一化后的配额桶数组。
 */
const USAGE_TIMEOUT_MS = 60000;

function normalizeUsageBucket(label, bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const total = Number(bucket.total ?? bucket.cap);
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    label,
    total,
    used: Math.max(0, Number(bucket.used) || 0),
    remaining: Math.max(0, Number(bucket.remaining) || 0),
    percentage: Math.max(0, Math.min(100, Number(bucket.percentage) || 0)),
  };
}

function normalizeUsageInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const buckets = [
    normalizeUsageBucket('个人配额', info.userQuota),
    normalizeUsageBucket('加油包', info.addOnQuota),
    normalizeUsageBucket('组织资源包', info.orgResourcePackage),
  ].filter(Boolean);
  return {
    buckets,
    totalUsagePercentage:
      info.totalUsagePercentage == null ? null : Math.max(0, Math.min(100, Number(info.totalUsagePercentage) || 0)),
    isQuotaExceeded: Boolean(info.isQuotaExceeded),
    // expiresAt 是毫秒时间戳（配额重置/到期时间），无值时为 null。
    expiresAt: Number.isFinite(Number(info.expiresAt)) ? Number(info.expiresAt) : null,
  };
}

/**
 * 控制面 RPC 超时/取消包装：超时或 signal 中止即拒绝调用方；不中止常驻
 * daemon（查询只读无副作用，让其自然完成）。
 */
function withControlTimeout(promise, timeout, signal, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(reject, new AppError(504, 'upstream_timeout', timeoutMessage)),
      timeout
    );
    const onAbort = () =>
      finish(reject, new AppError(499, 'request_cancelled', 'Request was cancelled by the client.'));
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      fn(value);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function loadAccountUsage({ token, baseUrl, backendType, timeoutMs, signal } = {}) {
  const backend = cli.getCliBackend(backendType);
  const effectiveToken = requireToken(backend, token);
  const stderrRef = { value: '' };
  const timeout = Number(timeoutMs || process.env.QODERCN_TIMEOUT_MS || USAGE_TIMEOUT_MS);
  if (signal && signal.aborted) {
    throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
  }

  // 控制面 daemon 常驻池：每账号复用一个常驻 daemon（getUsageInfo 热响应
  // <100ms），免去每次 startDaemon 约 7s 的初始化；查询失败即剔除坏进程。
  const keyInput = { token: effectiveToken, baseUrl, backendType };
  const bundleSpec = cli.buildSpawnCommand(
    cli.resolveCliCommand(process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command),
    [],
    backend
  );
  const bundlePath = bundleSpec.args && bundleSpec.args[0];

  let acquired;
  try {
    acquired = await daemonPool.getDaemon(keyInput, {
      auth: accessToken(effectiveToken),
      ...(bundlePath ? { pathToQoderCLIExecutable: bundlePath } : {}),
      env: buildSdkEnv(baseUrl),
      stderr: (data) => {
        stderrRef.value = stderrRef.value
          ? `${stderrRef.value}${data}`.slice(-STDERR_TAIL_BYTES)
          : String(data).slice(-STDERR_TAIL_BYTES);
      },
    });
    const info = await withControlTimeout(
      acquired.daemon.getUsageInfo(),
      timeout,
      signal,
      'Usage query timed out.'
    );
    const usage = normalizeUsageInfo(info);
    if (!usage || usage.buckets.length === 0) {
      throw new AppError(502, 'upstream_error', 'Usage query succeeded but returned no quota data.');
    }
    return { ok: true, usage };
  } catch (error) {
    // 查询失败：坏进程剔除，下次取用重建（失败不保留）。
    await daemonPool.drop(keyInput);
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      'upstream_error',
      `Usage query failed: ${redactString(String((error && error.message) || error))}`
    );
  } finally {
    if (acquired && acquired.release) await acquired.release();
  }
}

/**
 * 模型目录查询：SDK daemon 面的 getModels()，返回含 priceFactor（credit
 * 倍率）的完整 ModelInfo。daemon 初始化约 7s、getModels 热响应 <100ms
 * （2026-10-17 探针实证），因此模块级缓存成功 10min / 失败 60s（目录
 * 低频变化，远比账号级模型列表的 60s 缓存宽松）；用完即 stop，不驻留内存。
 *
 * credit 倍率（priceFactor）只在本查询返回，模型名字符串本身不带倍率。
 * 返回 { ok, models: [{id, name, rate, isFree, isReasoning, isDefault}] }。
 */
const CATALOG_TIMEOUT_MS = 90000;
const CATALOG_CACHE_OK_MS = 10 * 60 * 1000;
const CATALOG_CACHE_FAIL_MS = 60 * 1000;

const catalogCaches = new Map(); // tokenFp → { at, ok, models }

async function loadModelCatalog({ token, baseUrl, backendType, timeoutMs, force } = {}) {
  const backend = cli.getCliBackend(backendType);
  const effectiveToken = requireToken(backend, token);
  const cacheKey = crypto.createHash('sha256').update(`${backendType || 'cn'}|${effectiveToken}`).digest('hex').slice(0, 24);
  // force=true（管理台测试对话）：跳过缓存读取，每次真实查询；查询结果仍写回
  // 缓存供网关热路径使用。
  const hit = force ? null : catalogCaches.get(cacheKey);
  if (hit && Date.now() - hit.at < (hit.ok ? CATALOG_CACHE_OK_MS : CATALOG_CACHE_FAIL_MS)) {
    return { ok: hit.ok, models: hit.models };
  }

  // bundle 路径与 spawn 钩子同源：buildSpawnCommand 把 .cmd shim 解析为
  // node + bundle，args[0] 即 bundle 绝对路径（daemon 必需，否则 Windows
  // 上 .cmd shim 起不来且 stderr 静默）。
  const spec = cli.buildSpawnCommand(
    cli.resolveCliCommand(process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command),
    [],
    backend
  );
  const bundlePath = spec.args && spec.args[0];
  const timeout = Number(timeoutMs || process.env.QODERCN_TIMEOUT_MS || CATALOG_TIMEOUT_MS);
  const keyInput = { token: effectiveToken, baseUrl, backendType };

  let acquired = null;
  let raceTimer = null;
  try {
    // 控制面 daemon 常驻池：复用同账号 daemon（初始化约 7s → 热响应
    // <100ms）。force 实时查询同样命中常驻进程，只读控制请求复用安全。
    acquired = await daemonPool.getDaemon(keyInput, {
      auth: accessToken(effectiveToken),
      ...(bundlePath ? { pathToQoderCLIExecutable: bundlePath } : {}),
      env: buildSdkEnv(baseUrl),
      stderr: () => {},
    });
    const raw = await Promise.race([
      acquired.daemon.getModels(),
      new Promise((_, reject) => {
        raceTimer = setTimeout(
          () => reject(new AppError(504, 'upstream_timeout', 'Model catalog query timed out.')),
          timeout
        );
      }),
    ]);
    clearTimeout(raceTimer);
    const models = (Array.isArray(raw) ? raw : [])
      .filter((m) => m && typeof m === 'object' && m.isEnabled !== false)
      .map((m) => ({
        id: String(m.value || m.modelId || ''),
        name: String(m.displayName || m.value || ''),
        rate: Number.isFinite(Number(m.priceFactor)) ? Number(m.priceFactor) : null,
        isFree: Boolean(m.isFree),
        isReasoning: Boolean(m.isReasoning),
        isDefault: Boolean(m.isDefault),
        raw: m, // CLI 原始 ModelInfo 原样保留，供 /v1/models 完整透传
      }))
      .filter((m) => m.id);
    if (models.length === 0) throw new AppError(502, 'upstream_error', 'Model catalog returned no models.');
    catalogCaches.set(cacheKey, { at: Date.now(), ok: true, models });
    return { ok: true, models };
  } catch (error) {
    clearTimeout(raceTimer);
    catalogCaches.set(cacheKey, { at: Date.now(), ok: false, models: [] });
    console.error(
      `[model-catalog] query failed: ${redactString((error && error.message) || String(error)).trim()}`
    );
    // 查询失败：坏进程剔除，下次取用重建（失败不保留）。
    await daemonPool.drop(keyInput);
    if (error instanceof AppError) throw error;
    throw mapSdkError(error, { backend, stderrTail: '', timedOut: false, clientAborted: false });
  } finally {
    clearTimeout(raceTimer);
    if (acquired && acquired.release) await acquired.release();
  }
}

module.exports = {
  runQoderCnCli,
  runQoderCnCliStream,
  loadAccountUsage,
  loadModelCatalog,
};
