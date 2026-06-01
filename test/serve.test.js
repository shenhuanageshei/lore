// test/serve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime, readPid, writePid, isAlive } from '../lib/serve.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

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

test('writePid then readPid round-trips', () => {
  const state = mkdtempSync(pjoin(tmpdir(), 'lore-state-'));
  try {
    writePid(state, { pid: 4242, port: 7842, runtime: 'python', started: 't' });
    const info = readPid(state);
    assert.equal(info.pid, 4242);
    assert.equal(info.port, 7842);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('readPid returns null when absent', () => {
  const state = mkdtempSync(pjoin(tmpdir(), 'lore-state-'));
  try { assert.equal(readPid(state), null); }
  finally { rmSync(state, { recursive: true, force: true }); }
});

test('isAlive is true for current process, false for unused pid', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 31 - 1), false);   // implausible pid
});

test('readPid returns null on corrupt JSON', () => {
  const state = mkdtempSync(pjoin(tmpdir(), 'lore-state-'));
  try {
    writeFileSync(pjoin(state, 'serve.pid'), '{ not valid json');
    assert.equal(readPid(state), null);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
