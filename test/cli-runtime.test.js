const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  buildChildEnv,
  buildPrompt,
  buildSpawnCommand,
  getCliBackend,
  resolveCliCommand,
  usageFacts,
} = require('../server/cli-runtime');

test('prompt preserves multi-turn messages', () => {
  const prompt = buildPrompt([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ]);

  assert.match(prompt, /Be terse/);
  assert.match(prompt, /first/);
  assert.match(prompt, /second/);
  assert.match(prompt, /third/);
});

test('wraps Windows cmd shims for spawning', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spec = buildSpawnCommand('C:\\bin\\qoderclicn.cmd', ['--version']);
    assert.match(spec.command, /cmd\.exe$/i);
    assert.deepEqual(spec.args.slice(0, 4), ['/d', '/s', '/c', 'C:\\bin\\qoderclicn.cmd']);
    assert.equal(spec.args.at(-1), '--version');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('uses qoderclicn JS bundle directly when npm cmd shim is available', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-spawn-'));
  const shim = path.join(temp, 'qoderclicn.cmd');
  const bundle = path.join(
    temp,
    'node_modules',
    '@qodercn-ai',
    'qoderclicn',
    'bundle',
    'qoderclicn.js'
  );
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(shim, '@echo off\n');
  fs.writeFileSync(bundle, 'console.log("ok")\n');

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spec = buildSpawnCommand(shim, ['--print', 'hello']);
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], bundle);
    assert.equal(spec.args.at(-1), 'hello');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolves bare qoderclicn command to Windows npm cmd shim on PATH', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-path-'));
  const shim = path.join(temp, 'qoderclicn.cmd');
  fs.writeFileSync(shim, '@echo off\n');

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const command = resolveCliCommand('qoderclicn', { PATH: temp, PATHEXT: '.EXE;.BAT;.CMD' });
    assert.equal(command, shim);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolveCliCommand keeps explicit CLI paths unchanged', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(resolveCliCommand('C:\\bin\\qoderclicn.cmd', { PATH: '' }), 'C:\\bin\\qoderclicn.cmd');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('getCliBackend honors a per-request backend override', () => {
  const originalBackend = process.env.CLI_BACKEND;
  process.env.CLI_BACKEND = 'cn';
  try {
    assert.equal(getCliBackend('global').name, 'global');
    assert.equal(getCliBackend('global').tokenEnvVar, 'QODER_PAT');
    assert.equal(getCliBackend('cn').name, 'cn');
    assert.equal(getCliBackend().name, 'cn');
  } finally {
    if (originalBackend === undefined) delete process.env.CLI_BACKEND;
    else process.env.CLI_BACKEND = originalBackend;
  }
});

test('buildChildEnv injects per-request token and prefers per-request base URL', () => {
  const backend = getCliBackend('cn');
  const originalBase = process.env.QODERCN_BASE_URL;
  process.env.QODERCN_BASE_URL = 'https://env-endpoint.example.com';
  try {
    const env = buildChildEnv(os.tmpdir(), 'per-account-token', backend, 'https://account-endpoint.example.com');
    assert.equal(env.QODERCN_PERSONAL_ACCESS_TOKEN, 'per-account-token');
    assert.equal(env.QODERCN_BASE_URL, 'https://account-endpoint.example.com');

    const fallbackEnv = buildChildEnv(os.tmpdir(), 't2', backend, null);
    assert.equal(fallbackEnv.QODERCN_BASE_URL, 'https://env-endpoint.example.com');
  } finally {
    if (originalBase === undefined) delete process.env.QODERCN_BASE_URL;
    else process.env.QODERCN_BASE_URL = originalBase;
  }
});

test('usageFacts normalizes field aliases', () => {
  assert.deepEqual(usageFacts({ input_tokens: 12, output_tokens: 34 }), {
    inputTokens: 12,
    outputTokens: 34,
  });
  assert.deepEqual(usageFacts({ inputTokens: 1, outputTokens: 2 }), {
    inputTokens: 1,
    outputTokens: 2,
  });
  assert.deepEqual(usageFacts({ prompt_tokens: 5, completion_tokens: 7 }), {
    inputTokens: 5,
    outputTokens: 7,
  });
});

test('usageFacts treats an all-zero usage object as unreported', () => {
  // CLI/SDK 偶发返回全 0 的 usage —— 必须视同未报告走估算，
  // 否则接口 usage 与用量记录恒 0。
  const zeroUsage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  assert.equal(usageFacts(zeroUsage), null);
  // 部分为 0 仍是可用事实
  assert.deepEqual(usageFacts({ input_tokens: 12, output_tokens: 0 }), {
    inputTokens: 12,
    outputTokens: 0,
  });
});

test('usageFacts returns null for missing or invalid usage', () => {
  assert.equal(usageFacts(null), null);
  assert.equal(usageFacts(undefined), null);
  assert.equal(usageFacts('usage'), null);
  assert.equal(usageFacts({}), null);
});
