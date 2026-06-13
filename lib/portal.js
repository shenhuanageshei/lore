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

// 开机自启（win32）：Startup 文件夹放 vbs，wscript 隐藏窗口跑 node portal.js start（start 幂等）。
// 非 win32 不实现（YAGNI）——CLI 打印 cron/launchd 手动指引。
export function autostart(action, { appData = process.env.APPDATA, platform = process.platform } = {}) {
  if (platform !== 'win32') return { status: 'unsupported' };
  const dir = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbs = join(dir, 'lore-portal.vbs');
  if (action === 'off') {
    if (!existsSync(vbs)) return { status: 'absent' };
    rmSync(vbs);
    return { status: 'removed' };
  }
  if (existsSync(vbs)) return { status: 'present' };
  mkdirSync(dir, { recursive: true });
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run "node ""${self}"" start", 0, False\r\n`);
  return { status: 'installed' };
}
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
    // detached 子进程入口：建门户 → 仅绑 127.0.0.1。
    // 传函数（非快照）：每请求重读 registry——新 init 的 repo 免重启 portal 自动出现。
    const port = Number(process.argv[3]) || PORTAL_PORT;
    createPortalServer(() => toMap(listRepos())).listen(port, '127.0.0.1',
      () => console.log(`lore portal on 127.0.0.1:${port}`));
    // portal 接管全部 repo 的 auto ticker（portal 有写面后，它是比 per-repo serve 更自然的常驻调度宿主）。
    // 每 tick 重读 registry——新登记的 repo 自动纳入。tickAuto 永不抛。
    setInterval(async () => {
      try {
        const { tickAuto } = await import('./runner.js');
        for (const r of listRepos()) tickAuto(r.loreDir);
      } catch { /* ticker 永不击落 portal */ }
    }, 60_000).unref();
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
  } else if (sub === 'autostart') {
    const r = autostart(process.argv[3] === 'off' ? 'off' : 'on');
    console.log({
      installed: '✓ 开机自启已装（Startup/lore-portal.vbs，下次登录自动起 portal）',
      present: '✓ 已是开机自启',
      removed: '✓ 已移除开机自启',
      absent: '（本来就没装）',
      unsupported: '非 Windows：请手动加 cron/launchd 跑 node lib/portal.js start',
    }[r.status]);
  } else {
    console.error('usage: node lib/portal.js start|stop|list|autostart [on|off]');
    process.exit(1);
  }
}
