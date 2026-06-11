// lib/syncstate.js —— B1 同步控制状态层（.state/ 本地存储，best-effort 容错同 registry.js）
// 档位是 per-machine 工作流偏好：删文件 = 回默认 notify，无损坏（spec 决策）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MODES = new Set(['manual', 'notify', 'auto']);
const MODE_FILE = 'sync.json';
const QUEUE_FILE = 'rewrite-requests.ndjson';

export function readSyncMode(stateDir) {
  const p = join(stateDir, MODE_FILE);
  if (!existsSync(p)) return 'notify';
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')).mode;
    return MODES.has(m) ? m : 'notify';
  } catch { return 'notify'; }
}

export function writeSyncMode(stateDir, mode) {
  if (!MODES.has(mode)) throw new Error(`lore: invalid sync mode "${mode}" (manual|notify|auto)`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, MODE_FILE), JSON.stringify({ mode }, null, 2) + '\n');
}

// rewrite 队列：壳「✍ 排队」→ append；会话 /lore:sync 优先消化后从文件移除该行（命令层职责）。
// B2 的 auto 档复用同一队列（LLM 运行器消费）。
export function readRewriteRequests(stateDir) {
  const p = join(stateDir, QUEUE_FILE);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.page === 'string' && r.page) out.push(r); }
    catch { /* skip bad line */ }
  }
  return out;
}

export function appendRewriteRequest(stateDir, { page, now = new Date().toISOString() }) {
  if (!page || typeof page !== 'string') return { queued: false };   // 防御：read 侧过滤同款谓词，append 侧对称把门
  if (readRewriteRequests(stateDir).some(r => r.page === page)) return { queued: false };
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, QUEUE_FILE), JSON.stringify({ ts: now, page }) + '\n');
  return { queued: true };
}

// --- B2 自动重写状态（spec 2026-06-10-lore-auto-rewrite）---
const PENDING_FILE = 'auto-pending.json';
const RUNNER_PID_FILE = 'runner.pid';
const RUNS_FILE = 'auto-runs.ndjson';
const CONFIG_DEFAULTS = { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5 };

// sync.json 的全配置视图（B1 的 {mode} 形状向后兼容，未知字段忽略，非法值回默认）。
export function readSyncConfig(stateDir) {
  const p = join(stateDir, MODE_FILE);
  let raw = {};
  if (existsSync(p)) { try { raw = JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { raw = {}; } }
  return {
    mode: MODES.has(raw.mode) ? raw.mode : CONFIG_DEFAULTS.mode,
    debounce_minutes: Number.isFinite(raw.debounce_minutes) ? raw.debounce_minutes : CONFIG_DEFAULTS.debounce_minutes,
    schedule: typeof raw.schedule === 'string' && /^\d{2}:\d{2}$/.test(raw.schedule) ? raw.schedule : CONFIG_DEFAULTS.schedule,
    max_pages: Number.isFinite(raw.max_pages) ? raw.max_pages : CONFIG_DEFAULTS.max_pages,
  };
}

export function writeAutoPending(stateDir, ts) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, PENDING_FILE), JSON.stringify({ since: ts }) + '\n');
}
export function readAutoPending(stateDir) {
  const p = join(stateDir, PENDING_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).since ?? null; } catch { return null; }
}
export function clearAutoPending(stateDir) {
  try { rmSync(join(stateDir, PENDING_FILE), { force: true }); } catch { /* best-effort */ }
}

export function writeRunnerPid(stateDir, pid) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RUNNER_PID_FILE), JSON.stringify({ pid }) + '\n');
}
export function readRunnerPid(stateDir) {
  const p = join(stateDir, RUNNER_PID_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).pid ?? null; } catch { return null; }
}
export function clearRunnerPid(stateDir) {
  try { rmSync(join(stateDir, RUNNER_PID_FILE), { force: true }); } catch { /* best-effort */ }
}

export function appendAutoRun(stateDir, run) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, RUNS_FILE), JSON.stringify(run) + '\n');
}
export function readAutoRuns(stateDir, limit = 20) {
  const p = join(stateDir, RUNS_FILE);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out.reverse().slice(0, limit);                    // 最新在前
}
