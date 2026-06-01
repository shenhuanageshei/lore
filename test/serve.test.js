// test/serve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime } from '../lib/serve.js';

test('probeRuntime prefers python3 when available', () => {
  const r = probeRuntime(cmd => cmd === 'python3');
  assert.equal(r.kind, 'python');
  assert.equal(r.cmd, 'python3');
  assert.deepEqual(r.buildArgs(7842, '/x'),
    ['-m', 'http.server', '7842', '--bind', '127.0.0.1', '--directory', '/x']);
});

test('probeRuntime falls back to python (Windows) when no python3', () => {
  const r = probeRuntime(cmd => cmd === 'python');
  assert.equal(r.kind, 'python');
  assert.equal(r.cmd, 'python');
});

test('probeRuntime falls back to bundled node server when no python', () => {
  const r = probeRuntime(() => false);
  assert.equal(r.kind, 'node');
  assert.equal(r.cmd, process.execPath);     // current node binary
  const args = r.buildArgs(7842, '/x');
  assert.equal(args[0].endsWith('server.js'), true);
  assert.deepEqual(args.slice(1), ['/x', '7842']);
});
