// lib/serve.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { /* already gone */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

export function probeRuntime(canRun) {
  for (const cmd of ['python3', 'python']) {
    if (canRun(cmd)) {
      return {
        kind: 'python', cmd,
        buildArgs: (port, dir) =>
          ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir],
      };
    }
  }
  return {
    kind: 'node', cmd: process.execPath,
    buildArgs: (port, dir) => [SERVER_JS, dir, String(port)],
  };
}
