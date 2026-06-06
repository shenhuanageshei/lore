// test/serve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime, readPid, writePid, isAlive, killPid, findPort, start, stop } from '../lib/serve.js';
import { spawn, execFileSync as exec } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync as mkd, writeFileSync as wf } from 'node:fs';
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

test('probeRuntime can prefer node for local APIs', () => {
  const r = probeRuntime(cmd => cmd === 'python3', { preferNode: true });
  assert.equal(r.kind, 'node');
  assert.equal(r.cmd, process.execPath);
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

test('killPid terminates a real child process', async () => {
  // long-lived child: node that sleeps
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'],
    { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(isAlive(child.pid), true);
  killPid(child.pid, process.platform);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(isAlive(child.pid), false);
});

test('findPort returns the requested port when free', async () => {
  const p = await findPort(0);          // 0 => OS picks a free port, returned as-is rule
  assert.equal(typeof p, 'number');
});

test('start writes pid + returns url, stop kills and clears', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-run-'));
  try {
    // minimal .lore with manifest so start does not early-exit
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    mkd(pjoin(root, '.lore', 'site'), { recursive: true });
    wf(pjoin(root, '.lore', 'site', 'index.html'), '<!doctype html>ok');

    const info = await start({
      loreDir: pjoin(root, '.lore'),
      port: 0,
      canRun: () => false,              // force node fallback (deterministic)
      now: 't',
    });
    assert.equal(typeof info.port, 'number');
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/site\/$/);
    assert.equal(isAlive(info.pid), true);

    // server actually responds
    const r = await fetch(info.url + 'index.html');
    assert.equal(r.status, 200);

    const res = await stop({ loreDir: pjoin(root, '.lore') });
    assert.equal(res.stopped, true);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(isAlive(info.pid), false);
    assert.equal(readPid(pjoin(root, '.lore', '.state')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start is idempotent: second call reuses running server', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-run-'));
  try {
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    mkd(pjoin(root, '.lore', 'site'), { recursive: true });
    wf(pjoin(root, '.lore', 'site', 'index.html'), 'ok');
    const a = await start({ loreDir: pjoin(root, '.lore'), port: 0, canRun: () => false, now: 't' });
    const b = await start({ loreDir: pjoin(root, '.lore'), port: 0, canRun: () => false, now: 't' });
    assert.equal(a.pid, b.pid);         // same process, not restarted
    assert.equal(b.reused, true);
    await stop({ loreDir: pjoin(root, '.lore') });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stop on nothing-running is a no-op', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-run-'));
  try {
    const res = await stop({ loreDir: pjoin(root, '.lore') });
    assert.equal(res.stopped, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start throws if the server never binds within timeout', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-nobind-'));
  let spawned = null;
  try {
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    const fakeSpawn = (...args) => {
      spawned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
      return spawned;
    };
    await assert.rejects(
      () => start({ loreDir: pjoin(root, '.lore'), port: 0, canRun: () => false, spawnFn: fakeSpawn, now: 't' }),
      /did not bind/,
    );
    assert.equal(readPid(pjoin(root, '.lore', '.state')), null);
  } finally {
    if (spawned) { try { spawned.kill('SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: serve start prints URL, serve stop tears down', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-cli2-'));
  try {
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    mkd(pjoin(root, '.lore', 'site'), { recursive: true });
    wf(pjoin(root, '.lore', 'site', 'index.html'), 'ok');

    const out = exec('node',
      ['lib/serve.js', 'start', '--lore', pjoin(root, '.lore'), '--port', '0'],
      { cwd: process.cwd() }).toString();
    assert.match(out, /http:\/\/127\.0\.0\.1:\d+\/site\//);

    const stopOut = exec('node',
      ['lib/serve.js', 'stop', '--lore', pjoin(root, '.lore')],
      { cwd: process.cwd() }).toString();
    assert.match(stopOut, /stopped|no running/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: serve start without manifest exits non-zero with hint', () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-cli3-'));
  try {
    mkd(pjoin(root, '.lore'), { recursive: true });
    let err = null;
    try {
      exec('node', ['lib/serve.js', 'start', '--lore', pjoin(root, '.lore')],
        { cwd: process.cwd(), stdio: 'pipe' });
    } catch (e) { err = e; }
    assert.notEqual(err, null);                       // non-zero exit threw
    assert.match(String(err.stderr), /lore:sync/);    // hint present in stderr
  } finally { rmSync(root, { recursive: true, force: true }); }
});
