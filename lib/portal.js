// lib/portal.js — 单机共享门户生命周期：一个固定端口（7842）的常驻 server 聚合本机所有 lore repo。
// 与 per-repo lib/serve.js 共存（只复用其跨平台 killPid/isAlive）。
import net from 'node:net';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createPortalServer } from '../server.js';
import { listRepos, defaultReposPath } from './repos.js';
import { isAlive, killPid } from './serve.js';

export const PORTAL_PORT = 7842;
const SELF = fileURLToPath(import.meta.url);

export function portalPidPath(home = homedir()) {
  return join(home, '.lore', 'portal.pid');
}

function readPidFile(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function writePidFile(p, info) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2) + '\n');
}
function clearPidFile(p) { rmSync(p, { force: true }); }

// [{name, loreDir}] → { name: loreDir }，喂给 createPortalServer。
export function toMap(repos) {
  const map = {};
  for (const r of repos) map[r.name] = r.loreDir;
  return map;
}

// 等子进程绑上端口（复刻 serve.js 的私有 waitForPort，避免改动 serve.js）。
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

// 启动常驻门户。已在跑（pid alive）则幂等返回 URL（reused:true）。否则 detached spawn
// `node lib/portal.js __run <port>`，写 ~/.lore/portal.pid，等其绑端口。
export async function start({ home = homedir(), port = PORTAL_PORT, spawnFn = spawn } = {}) {
  const pidPath = portalPidPath(home);
  const existing = readPidFile(pidPath);
  if (existing && isAlive(existing.pid)) {
    return { ...existing, url: `http://127.0.0.1:${existing.port}/`, reused: true };
  }
  const child = spawnFn(process.execPath, [SELF, '__run', String(port)], { detached: true, stdio: 'ignore' });
  child.unref();
  const info = { pid: child.pid, port };
  writePidFile(pidPath, info);
  const ready = await waitForPort(port);
  if (!ready) {
    clearPidFile(pidPath);
    throw new Error(`lore portal (pid ${child.pid}) did not bind on port ${port} within ~3s`);
  }
  return { ...info, url: `http://127.0.0.1:${port}/`, reused: false };
}

// 停掉门户：读 pid → 跨平台 kill（复用 serve.js）→ 清 pid 文件。
export async function stop({ home = homedir() } = {}) {
  const pidPath = portalPidPath(home);
  const info = readPidFile(pidPath);
  if (!info) return { stopped: false };
  if (isAlive(info.pid)) killPid(info.pid, process.platform);
  clearPidFile(pidPath);
  return { stopped: true, pid: info.pid };
}

if (process.argv[1] === SELF) {
  const sub = process.argv[2];
  if (sub === '__run') {
    // detached 子进程入口：读 registry → 建门户 → 仅绑 127.0.0.1。
    const port = Number(process.argv[3]) || PORTAL_PORT;
    createPortalServer(toMap(listRepos())).listen(port, '127.0.0.1',
      () => console.log(`lore portal on 127.0.0.1:${port}`));
  } else if (sub === 'start') {
    start().then((info) => {
      const tag = info.reused ? ' (already running)' : '';
      console.log(`▶ lore portal${tag} ${info.url}   stop: /lore:portal stop`);
    }).catch((e) => { console.error(e.message); process.exit(1); });
  } else if (sub === 'stop') {
    stop().then((res) => console.log(res.stopped ? '■ portal stopped' : 'no running portal'))
      .catch((e) => { console.error(e.message); process.exit(1); });
  } else if (sub === 'list') {
    const repos = listRepos();
    if (!repos.length) console.log('no lore repos registered (run /lore:init in a repo)');
    else for (const r of repos) console.log(`${r.name}  ${r.loreDir}`);
  } else {
    console.error('usage: node lib/portal.js start|stop|list');
    process.exit(1);
  }
}
