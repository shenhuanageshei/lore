// lib/serve.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { registryPath, registerServer, unregisterServer, listServers } from './registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

const PID_NAME = 'serve.pid';

export function writePid(stateDir, info) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, PID_NAME), JSON.stringify(info, null, 2));
}

export function readPid(stateDir) {
  const p = join(stateDir, PID_NAME);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function clearPid(stateDir) {
  rmSync(join(stateDir, PID_NAME), { force: true });
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = exists but not ours
}

export function killPid(pid, platform) {
  if (platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { /* already gone */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

function nodeRuntime() {
  return {
    kind: 'node', cmd: process.execPath,
    buildArgs: (port, dir) => [SERVER_JS, dir, String(port)],
  };
}

// Default to the bundled Node server — it sets correct MIME types (.mjs → text/javascript)
// and serves the local write APIs (preferences, translation, sync control) that the
// Python static server can't. Python `http.server` is available as a fallback when
// Node is unavailable, but lacks .mjs MIME so the shell breaks (browser rejects
// module scripts with text/plain).
export function probeRuntime(canRun = defaultCanRun, { preferPython = false } = {}) {
  if (preferPython) {
    for (const cmd of ['python3', 'python']) {
      if (canRun(cmd)) {
        return {
          kind: 'python', cmd,
          buildArgs: (port, dir) =>
            ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir],
        };
      }
    }
  }
  return nodeRuntime();
}

// 同 repo 稳定端口（7000-7999）：hash(loreDir) → 端口，同 repo URL 恒定。
export function stablePort(loreDir) {
  const h = createHash('sha1').update(loreDir).digest('hex').slice(0, 6);
  return 7000 + (parseInt(h, 16) % 1000);
}

// registry 中活着的 server；顺带把死条目从 registry 清掉。path/alive 可注入便于测。
export function listRunning(path = registryPath(), alive = isAlive) {
  const running = [];
  for (const s of listServers(path)) {
    if (alive(s.pid)) running.push(s);
    else unregisterServer(s.loreDir, path);
  }
  return running;
}

// 停掉 registry 里所有 server 并注销。返回 kill 数。可注入。
export function stopAllRunning(path = registryPath(), alive = isAlive, kill = killPid, platform = process.platform) {
  let n = 0;
  for (const s of listServers(path)) {
    if (alive(s.pid)) { kill(s.pid, platform); n++; }
    unregisterServer(s.loreDir, path);
  }
  return n;
}

// NOTE: TOCTOU — the probed port is free now but could be claimed before the
// child binds it. Acceptable for single-user local use; if it happens, the child
// fails to bind and start() throws via the waitForPort check.
export function findPort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () => {
      // preferred busy → ask OS for any free port
      const s2 = net.createServer();
      s2.once('error', reject);
      s2.listen(0, '127.0.0.1', () => {
        const p = s2.address().port; s2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const p = srv.address().port; srv.close(() => resolve(p));
    });
  });
}

export async function start({ loreDir, port, canRun, spawnFn = spawn, now = new Date().toISOString(), preferPython = false }) {
  const stateDir = join(loreDir, '.state');
  const targetPort = port ?? stablePort(loreDir);
  const existing = readPid(stateDir);
  if (existing && isAlive(existing.pid)) {
    return { ...existing, url: `http://127.0.0.1:${existing.port}/site/`, reused: true };
  }
  const can = canRun ?? defaultCanRun;
  const runtime = probeRuntime(can, { preferPython });
  const chosen = await findPort(targetPort);
  // detached + unref so the static server outlives this slash-command process.
  // Windows note: a Microsoft-Store python.exe alias stub may not survive parent
  // exit reliably; the bundled node fallback always does.
  const child = spawnFn(runtime.cmd, runtime.buildArgs(chosen, loreDir),
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const info = { pid: child.pid, port: chosen, runtime: runtime.kind, started: now };
  writePid(stateDir, info);
  const ready = await waitForPort(chosen);
  if (!ready) {
    clearPid(stateDir);
    throw new Error(`lore: server (pid ${child.pid}) did not bind on port ${chosen} within ~3s`);
  }
  return { ...info, url: `http://127.0.0.1:${chosen}/site/`, reused: false };
}

export async function stop({ loreDir }) {
  const stateDir = join(loreDir, '.state');
  const info = readPid(stateDir);
  if (!info) return { stopped: false };
  if (isAlive(info.pid)) killPid(info.pid, process.platform);
  clearPid(stateDir);
  return { stopped: true, pid: info.pid };
}

function defaultCanRun(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true }); return true; }
  catch { return false; }
}

function waitForPort(port, tries = 50) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (n <= 0) return resolve(false);
        setTimeout(() => attempt(n - 1), 60);
      });
    };
    attempt(tries);
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lore') out.lore = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--node') out.node = true;       // backward compat: now default, no-op
    else if (a === '--python') out.python = true;   // opt-in to Python static server
    else out._.push(a);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  const loreDir = args.lore ?? join(process.cwd(), '.lore');
  (async () => {
    if (sub === 'start') {
      if (!existsSync(join(loreDir, 'wiki', '.manifest.json'))) {
        console.error('No .lore/wiki/.manifest.json — run /lore:sync first.');
        process.exit(1);
      }
      const info = await start({ loreDir, port: args.port, now: new Date().toISOString(), preferPython: !!args.python });
      registerServer({ loreDir, pid: info.pid, port: info.port, started: info.started ?? new Date().toISOString() });
      const tag = info.reused ? ` (already running, ${info.runtime})` : '';
      console.log(`▶ lore wiki${tag} ${info.url}   stop: /lore:serve --stop`);
      if (args.node && info.reused && info.runtime !== 'node') {
        console.log('  --node is the default now — use --python for Python static server');
      }
    } else if (sub === 'stop') {
      const res = await stop({ loreDir });
      unregisterServer(loreDir);
      console.log(res.stopped ? '■ stopped' : 'no running lore server');
    } else if (sub === 'list') {
      const running = listRunning();
      if (!running.length) console.log('no running lore servers');
      else for (const s of running) console.log(`▶ ${s.port}  ${s.loreDir}  (pid ${s.pid})`);
    } else if (sub === 'stop-all') {
      const n = stopAllRunning();
      console.log(n ? `■ stopped ${n} server(s)` : 'no running lore servers');
    } else {
      console.error('usage: node lib/serve.js start|stop|list|stop-all [--lore <dir>] [--port N] [--node]');
      process.exit(1);
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
