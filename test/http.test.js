const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// Isolated DB — must be set before requiring server modules so tests never
// touch (or depend on the contents of) the real data/qoder-proxy.db.
process.env.QODER_PROXY_DB = path.join(os.tmpdir(), `qoder-proxy-http-${Date.now()}.db`);
require('../server/migrations').runMigrations(require('../server/db').db);

const qoderCli = require('../server/qoder-session');
const { createApp, extractRequestOptions } = require('../server/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('health and models endpoints are OpenAI-compatible enough for discovery', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const models = await fetch(`${baseUrl}/v1/models`);
    assert.equal(models.status, 200);
    const body = await models.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'qoder-cn');
    assert.equal(body.data.some((model) => model.id === 'qwen3.7-max'), true);
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-flash'), true);
  } finally {
    server.close();
  }
});

test('streaming returns OpenAI-compatible SSE chunks', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('OK');
    return 'OK';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(streaming.status, 200);
    assert.match(streaming.headers.get('content-type'), /text\/event-stream/);
    const text = await streaming.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /"content":"OK"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('true streaming forwards multiple deltas in real time', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('Hello ');
    onDelta('world');
    onDelta('!');
    return 'Hello world!';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(streaming.status, 200);
    const text = await streaming.text();
    // Each delta should appear as a separate SSE chunk
    const deltaMatches = text.match(/"content":"[^"]+"/g) || [];
    assert.equal(deltaMatches.length, 3);
    assert.match(deltaMatches[0], /"content":"Hello "/);
    assert.match(deltaMatches[1], /"content":"world"/);
    assert.match(deltaMatches[2], /"content":"!"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('tool call messages are accepted (no longer rejected)', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'I will help you.';
  const { server, baseUrl } = await listen(createApp());
  try {
    // Messages with tool_calls in history should now be accepted
    const toolCall = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'read file' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' } }] },
          { role: 'tool', tool_call_id: 'call_x', content: 'file contents here' },
          { role: 'user', content: 'what was in the file?' },
        ],
      }),
    });
    assert.equal(toolCall.status, 200);
    const body = await toolCall.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('anthropic messages endpoint with tools injects tool definitions', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let captured;
  qoderCli.runQoderCnCli = async (input) => {
    captured = input;
    return 'OK';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'not-used',
      },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        max_tokens: 32,
        system: 'Be terse.',
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.deepEqual(body.content, [{ type: 'text', text: 'OK' }]);
    // Tools should be injected as system prompt, not "text-only" warning
    assert.equal(captured.messages.some((message) => /tool_calls/.test(message.content)), true);
    assert.equal(captured.messages.some((message) => /text-only/.test(message.content)), false);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('anthropic messages endpoint streams Anthropic SSE events', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('OK');
    return 'OK';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /"type":"text_delta","text":"OK"/);
    assert.match(text, /event: message_stop/);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('anthropic true streaming forwards multiple deltas', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('Hello ');
    onDelta('world');
    return 'Hello world';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    // Each delta should appear as a separate content_block_delta
    const deltaMatches = text.match(/event: content_block_delta/g) || [];
    assert.equal(deltaMatches.length, 2);
    assert.match(text, /"text":"Hello "/);
    assert.match(text, /"text":"world"/);
    assert.match(text, /event: content_block_stop/);
    assert.match(text, /event: message_delta/);
    assert.match(text, /event: message_stop/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('anthropic count_tokens returns an approximate input token count', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.input_tokens, 'number');
    assert.equal(body.input_tokens > 0, true);
  } finally {
    server.close();
  }
});

test('extracts OpenCode and OpenAI-compatible model options', () => {
  assert.deepEqual(
    extractRequestOptions({
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }),
    {
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }
  );

  assert.deepEqual(
    extractRequestOptions({
      reasoning_effort: 'low',
      context_window: 64000,
      max_tokens: 1024,
    }),
    {
      reasoningEffort: 'low',
      contextWindow: 64000,
      maxOutputTokens: 1024,
    }
  );

  assert.equal(
    extractRequestOptions({
      providerOptions: {
        'qoder-cn-local': {
          reasoningEffort: 'max',
        },
      },
    }).reasoningEffort,
    'max'
  );
});

test('OpenAI chat completions returns tool_calls when model outputs tool call JSON', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => '```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/test.txt"}}]}\n```';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'read /tmp/test.txt' }],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.ok(body.choices[0].message.tool_calls);
    assert.equal(body.choices[0].message.tool_calls.length, 1);
    assert.equal(body.choices[0].message.tool_calls[0].type, 'function');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read_file');
    // arguments must be a JSON string per OpenAI spec
    assert.equal(typeof body.choices[0].message.tool_calls[0].function.arguments, 'string');
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
    assert.equal(args.path, '/tmp/test.txt');
    assert.ok(body.choices[0].message.tool_calls[0].id.startsWith('call_'));
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('OpenAI chat completions falls back to text when model outputs plain text with tools', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'I cannot find that file.';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'read /tmp/missing.txt' }],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.content, 'I cannot find that file.');
    assert.equal(body.choices[0].message.tool_calls, undefined);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('Anthropic messages endpoint returns tool_use blocks when model outputs tool call JSON', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => '```json\n{"tool_calls": [{"name": "Read", "arguments": {"path": "/tmp/test.txt"}}]}\n```';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read /tmp/test.txt' }] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, 'message');
    assert.equal(body.stop_reason, 'tool_use');
    // Should have a tool_use content block
    const toolUseBlocks = body.content.filter((b) => b.type === 'tool_use');
    assert.equal(toolUseBlocks.length, 1);
    assert.equal(toolUseBlocks[0].name, 'Read');
    // Anthropic: input is a parsed object, not a JSON string
    assert.deepEqual(toolUseBlocks[0].input, { path: '/tmp/test.txt' });
    assert.ok(toolUseBlocks[0].id.startsWith('toolu_'));
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('Anthropic messages endpoint returns mixed text+tool_use when model outputs text before tool JSON', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'Let me read that file for you.\n```json\n{"tool_calls": [{"name": "Read", "arguments": {"path": "/tmp/x"}}]}\n```';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read /tmp/x' }] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.stop_reason, 'tool_use');
    const textBlocks = body.content.filter((b) => b.type === 'text');
    const toolUseBlocks = body.content.filter((b) => b.type === 'tool_use');
    // Should have both text and tool_use
    assert.equal(textBlocks.length, 1);
    assert.equal(textBlocks[0].text, 'Let me read that file for you.');
    assert.equal(toolUseBlocks.length, 1);
    assert.equal(toolUseBlocks[0].name, 'Read');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('OpenAI chat completions with tool role messages formats tool results in prompt', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let captured;
  qoderCli.runQoderCnCli = async (input) => {
    captured = input;
    return 'The file says hello.';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'read /tmp/test.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_abc', content: 'hello world' },
          { role: 'user', content: 'what did the file say?' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    // Verify that tool result was formatted with its call ID in the prompt
    assert.ok(captured);
    const toolMessage = captured.messages.find((m) => m.role === 'tool');
    assert.ok(toolMessage);
    assert.equal(toolMessage.tool_call_id, 'call_abc');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('thinking: OpenAI stream forwards reasoning_content deltas separately', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta, onThinking }) => {
    if (onThinking) {
      onThinking('让我想想');
      onThinking('，答案是');
    }
    onDelta('42');
    return '42';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(streaming.status, 200);
    const text = await streaming.text();
    const reasoningMatches = text.match(/"reasoning_content":"[^"]+"/g) || [];
    assert.equal(reasoningMatches.length, 2);
    assert.match(reasoningMatches[0], /"reasoning_content":"让我想想"/);
    assert.match(reasoningMatches[1], /"reasoning_content":"，答案是"/);
    // 正文与思考分离：content 只承载正文增量
    assert.match(text, /"content":"42"/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('thinking: OpenAI non-streaming returns message.reasoning_content', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async ({ onThinking }) => {
    if (onThinking) onThinking('思考过程全文');
    return '最终答案';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, '最终答案');
    assert.equal(body.choices[0].message.reasoning_content, '思考过程全文');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('thinking: Anthropic stream emits thinking block before text block', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta, onThinking }) => {
    if (onThinking) onThinking('先推理');
    onDelta('后作答');
    return '后作答';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const streaming = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(streaming.status, 200);
    const text = await streaming.text();
    // thinking 块先 start（index 0），text 块后 start（index 1）
    const thinkingStart = text.indexOf('"content_block":{"type":"thinking"');
    const textStart = text.indexOf('"content_block":{"type":"text"');
    assert.ok(thinkingStart >= 0, 'thinking content_block_start expected');
    assert.ok(textStart > thinkingStart, 'text block must start after thinking block');
    assert.match(text, /"type":"thinking_delta","thinking":"先推理"/);
    assert.match(text, /"type":"text_delta","text":"后作答"/);
    assert.match(text, /event: content_block_stop/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('thinking: Anthropic non-streaming prepends thinking block to content', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async ({ onThinking }) => {
    if (onThinking) onThinking('推理全文');
    return '结论';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content[0].type, 'thinking');
    assert.equal(body.content[0].thinking, '推理全文');
    assert.equal(body.content[1].type, 'text');
    assert.equal(body.content[1].text, '结论');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('thinking: no onThinking subscriber keeps responses thinking-free', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  // CLI 产出思考增量但网关未订阅（不会发生——网关总是订阅；此用例锁死
  // 「未订阅时流式响应不出现 reasoning_content」的兼容行为）
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('plain');
    return 'plain';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await streaming.text();
    assert.equal((text.match(/reasoning_content/g) || []).length, 0);
    assert.match(text, /"content":"plain"/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});
