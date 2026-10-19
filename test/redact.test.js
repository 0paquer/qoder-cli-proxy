const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, redactString } = require('../server/redact');

test('redacts bearer tokens and sensitive keys', () => {
  assert.equal(redactString('Authorization: Bearer abc.def'), 'Authorization: Bearer [REDACTED]');
  assert.deepEqual(redact({ token: 'secret', nested: { cookie: 'a=b', ok: 'yes' } }), {
    token: '[REDACTED]',
    nested: { cookie: '[REDACTED]', ok: 'yes' },
  });
});

test('redacts non-Bearer Authorization headers', () => {
  // 非 Bearer 形式（Basic / 裸值）也必须打码，且不吞掉后续字符
  assert.equal(redactString('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: [REDACTED]');
  // 替换串固定为首字母大写的 Authorization:
  assert.equal(
    redactString('authorization: raw-secret-value\nX-Trace: 1'),
    'Authorization: [REDACTED]\nX-Trace: 1',
  );
});

test('redacts token-style assignments', () => {
  assert.equal(redactString('failed with token=abc123 in env'), 'failed with token=[REDACTED] in env');
  assert.equal(
    redactString('QODERCN_PERSONAL_ACCESS_TOKEN=pat_xyz'),
    'QODERCN_PERSONAL_ACCESS_TOKEN=[REDACTED]',
  );
  assert.equal(redactString('access_token: at_9.9'), 'access_token=[REDACTED]');
  // 带引号的值：至少保证值本身被打码（结尾引号允许残留）
  assert.match(redactString('token="secret-v"'), /token=\[REDACTED\]/);
  assert.doesNotMatch(redactString('token="secret-v"'), /secret-v/);
  // 未命中敏感模式的文本原样保留
  assert.equal(redactString('exited with code 1'), 'exited with code 1');
});
